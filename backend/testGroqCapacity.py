import sys
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import llm_adapter as adapter


def assert_equal(actual, expected, label):
    if actual != expected:
        raise AssertionError(f"{label}: expected {expected!r}, got {actual!r}")


def reset_capacity():
    with adapter._groq_capacity_lock:
        adapter._groq_capacity_snapshot = None
        adapter._groq_inflight_tokens = 0
    adapter._groq_call_state.telemetry = None


def budget(default=2500, estimated=500, force=False, execution_mode="fast"):
    return {
        "budget_class": "interactive",
        "default_output_tokens": default,
        "selected_output_tokens": default,
        "estimated_input_tokens": estimated,
        "force_fallback": force,
        "execution_mode": execution_mode,
    }


def set_capacity(remaining, limit=10_000):
    return adapter._capture_groq_telemetry({
        "x-ratelimit-limit-tokens": str(limit),
        "x-ratelimit-remaining-tokens": str(remaining),
        "x-ratelimit-reset-tokens": "2m59.5s",
        "retry-after": "1.25",
    })


def test_header_and_usage_capture():
    reset_capacity()
    usage = SimpleNamespace(prompt_tokens=120, completion_tokens=40, total_tokens=160, prompt_tokens_details=SimpleNamespace(cached_tokens=20))
    telemetry = adapter._capture_groq_telemetry({
        "x-ratelimit-limit-tokens": "6000",
        "x-ratelimit-remaining-tokens": "4500",
        "x-ratelimit-reset-tokens": "7.66s",
        "retry-after": "2",
    }, SimpleNamespace(usage=usage))
    assert_equal(telemetry["capacity"]["limit_tokens"], 6000, "limit header")
    assert_equal(telemetry["capacity"]["remaining_tokens"], 4500, "remaining header")
    assert_equal(telemetry["capacity"]["reset_after_ms"], 7660, "reset header")
    assert_equal(telemetry["capacity"]["retry_after_ms"], 2000, "retry-after header")
    assert_equal(telemetry["usage"]["cached_tokens"], 20, "cached usage")


def test_shared_capacity_group_and_thresholds():
    reset_capacity()
    set_capacity(3000)
    selected, fallback, reservation, band = adapter._select_groq_capacity_allocation(2500, budget())
    assert_equal((selected, fallback, band), (2125, False, "guarded"), "25-50 percent behavior")
    adapter._release_groq_capacity_reservation(reservation)

    set_capacity(2000)
    selected, fallback, reservation, band = adapter._select_groq_capacity_allocation(3500, budget(default=3500, execution_mode="intuitive"))
    assert_equal((selected, fallback, band), (2100, False, "constrained"), "10-25 percent behavior")
    adapter._release_groq_capacity_reservation(reservation)

    first = adapter.get_groq_capacity_snapshot()
    set_capacity(800)
    second = adapter.get_groq_capacity_snapshot()
    assert_equal(first["capacity_group"], "default_org", "first shared group")
    assert_equal(second["capacity_group"], "default_org", "second shared group")
    selected, fallback, reservation, band = adapter._select_groq_capacity_allocation(2500, budget())
    assert_equal((selected, fallback, reservation, band), (256, True, 0, "critical"), "critical fallback")

    with adapter._groq_capacity_lock:
        adapter._groq_capacity_snapshot["observed_at_ms"] = 0
    assert_equal(adapter.get_groq_capacity_snapshot(), None, "expired reset window is discarded")


def test_capacity_falls_to_existing_gemini_chain():
    reset_capacity()
    set_capacity(500)
    groq_called = False
    gemini_caps = []
    originals = {
        "_cache_get": adapter._cache_get,
        "_cache_set": adapter._cache_set,
        "_invoke_groq": adapter._invoke_groq,
        "_invoke_gemini_attempt_chain": adapter._invoke_gemini_attempt_chain,
    }

    def fake_groq(*args, **kwargs):
        nonlocal groq_called
        groq_called = True
        return "unexpected"

    def fake_gemini(_prompt, attempts, max_output_tokens=None, **_kwargs):
        gemini_caps.append(max_output_tokens)
        return "fallback-ok", attempts[0].model

    try:
        adapter._cache_get = lambda _key: None
        adapter._cache_set = lambda _key, _value: None
        adapter._invoke_groq = fake_groq
        adapter._invoke_gemini_attempt_chain = fake_gemini
        result = adapter.call_llm_router(
            "protected input",
            task="chat",
            prefer="groq",
            model_override="gpt-oss-120b",
            max_output_tokens=2500,
            budget_policy=budget(),
        )
    finally:
        for name, value in originals.items():
            setattr(adapter, name, value)

    assert_equal(groq_called, False, "critical capacity skips Groq key slots")
    assert_equal(gemini_caps, [256], "fallback receives reduced cap")
    assert_equal(result.get("text"), "fallback-ok", "existing Gemini chain result")
    assert_equal(result.get("fallback"), True, "fallback metadata")


def test_selected_cap_reaches_gemini_and_pollinations():
    reset_capacity()
    gemini_caps = []
    pollinations_caps = []
    originals = {
        "_cache_get": adapter._cache_get,
        "_cache_set": adapter._cache_set,
        "_invoke_gemini": adapter._invoke_gemini,
        "_call_pollinations": adapter._call_pollinations,
    }
    try:
        adapter._cache_get = lambda _key: None
        adapter._cache_set = lambda _key, _value: None
        adapter._invoke_gemini = lambda *args, **kwargs: gemini_caps.append(kwargs.get("max_output_tokens")) or "gemini-ok"
        adapter._call_pollinations = lambda *args, **kwargs: (
            pollinations_caps.append(kwargs.get("max_output_tokens")) or "pollinations-ok",
            "stop",
            False,
        )
        adapter.call_llm_router(
            "gemini cap",
            task="chat",
            model_override="gemini:gemini-lite",
            execution_mode="fast",
        )
        adapter.call_llm_router(
            "pollinations cap",
            task="chat",
            model_override="mistral",
            max_output_tokens=9000,
            execution_mode="intuitive",
        )
    finally:
        for name, value in originals.items():
            setattr(adapter, name, value)

    assert_equal(gemini_caps, [2500], "Gemini receives Fast cap")
    assert_equal(pollinations_caps, [3500], "Pollinations receives Intuitive cap")


def test_rate_limit_does_not_treat_keys_as_additive_capacity():
    calls = []
    originals = {
        "GROQ_API_KEYS": adapter.GROQ_API_KEYS,
        "_get_round_robin_groq_keys": adapter._get_round_robin_groq_keys,
        "_call_groq": adapter._call_groq,
        "_mark_key_unhealthy": adapter._mark_key_unhealthy,
    }

    class RateLimitedError(RuntimeError):
        status_code = 429

    try:
        adapter.GROQ_API_KEYS = ["slot-1", "slot-2", "slot-3"]
        adapter._get_round_robin_groq_keys = lambda: list(adapter.GROQ_API_KEYS)
        adapter._call_groq = lambda *args, **kwargs: calls.append(args[1]) or (_ for _ in ()).throw(RateLimitedError("rate limited"))
        adapter._mark_key_unhealthy = lambda _key: None
        try:
            adapter._invoke_groq("test")
        except RuntimeError:
            pass
    finally:
        for name, value in originals.items():
            setattr(adapter, name, value)

    assert_equal(calls, ["slot-1"], "429 stops remaining same-group key slots")


TESTS = [
    test_header_and_usage_capture,
    test_shared_capacity_group_and_thresholds,
    test_capacity_falls_to_existing_gemini_chain,
    test_selected_cap_reaches_gemini_and_pollinations,
    test_rate_limit_does_not_treat_keys_as_additive_capacity,
]


def main():
    for test in TESTS:
        test()
        print(f"PASS | {test.__name__}")
    print("Groq capacity Phase 1 validation passed.")


if __name__ == "__main__":
    main()
