import os
import sys
from contextlib import contextmanager
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import llm_adapter as adapter


@contextmanager
def patched(**attrs):
    originals = {name: getattr(adapter, name) for name in attrs}
    try:
        for name, value in attrs.items():
            setattr(adapter, name, value)
        yield
    finally:
        for name, value in originals.items():
            setattr(adapter, name, value)


@contextmanager
def patched_env(values: dict[str, str | None]):
    originals = {name: os.environ.get(name) for name in values}
    try:
        for name, value in values.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value
        yield
    finally:
        for name, value in originals.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value


def reset_gemini_state(records=None):
    records = records or [
        adapter.GeminiKeyRecord(1, "GEMINI_API_KEY_1", "fake-key-1"),
        adapter.GeminiKeyRecord(2, "GEMINI_API_KEY_2", "fake-key-2"),
    ]
    adapter.GEMINI_KEY_RECORDS = list(records)
    adapter.GEMINI_API_KEYS = [record.key for record in records]
    adapter._gemini_key_state.clear()
    adapter._gemini_key_rotation_index = 0
    return records


def assert_equal(actual, expected, label):
    if actual != expected:
        raise AssertionError(f"{label}: expected {expected!r}, got {actual!r}")


def assert_true(value, label):
    if not value:
        raise AssertionError(label)


def test_six_key_parsing_and_legacy_slot():
    env = {
        "GEMINI_API_KEY": "legacy-key",
        "GEMINI_API_KEY_1": "slot-1",
        "GEMINI_API_KEY_2": "slot-2",
        "GEMINI_API_KEY_3": "slot-3",
        "GEMINI_API_KEY_4": "slot-4",
        "GEMINI_API_KEY_5": "slot-5",
        "GEMINI_API_KEY_6": "slot-6",
    }
    with patched_env(env):
        records = adapter._read_gemini_key_records()
    assert_equal([record.index for record in records], [1, 2, 3, 4, 5, 6], "six-key indexes")
    assert_equal([record.key for record in records], [f"slot-{i}" for i in range(1, 7)], "six-key values")
    assert_true(all(record.key != "legacy-key" for record in records), "legacy key must not become a seventh slot")

    legacy_env = {name: None for name in env}
    legacy_env["GEMINI_API_KEY"] = "legacy-only"
    with patched_env(legacy_env):
        records = adapter._read_gemini_key_records()
    assert_equal([(record.index, record.env_name, record.key) for record in records], [(1, "GEMINI_API_KEY", "legacy-only")], "legacy slot fallback")


def test_stable_round_robin_indexes():
    records = reset_gemini_state([
        adapter.GeminiKeyRecord(1, "GEMINI_API_KEY_1", "fake-key-1"),
        adapter.GeminiKeyRecord(2, "GEMINI_API_KEY_2", "fake-key-2"),
        adapter.GeminiKeyRecord(3, "GEMINI_API_KEY_3", "fake-key-3"),
    ])
    first = adapter._get_round_robin_gemini_records("gemini-test")
    second = adapter._get_round_robin_gemini_records("gemini-test")
    assert_equal([record.index for record in first], [1, 2, 3], "first round-robin order")
    assert_equal([record.index for record in second], [2, 3, 1], "second round-robin order")
    assert_equal([record.env_name for record in records], ["GEMINI_API_KEY_1", "GEMINI_API_KEY_2", "GEMINI_API_KEY_3"], "stable env names")


def test_failure_health_state():
    records = reset_gemini_state([adapter.GeminiKeyRecord(1, "GEMINI_API_KEY_1", "fake-key-1")])
    record = records[0]

    adapter._record_gemini_failure(record, "gemini-429", RuntimeError("429 quota exceeded for fake-key-1"))
    state = adapter._gemini_state_snapshot(record, "gemini-429")
    assert_equal(state.get("last_status"), "rate_limited", "429 classification")
    assert_true(float(state.get("cooldown_until", 0)) > 0, "429 cooldown set")
    assert_true("fake-key-1" not in state.get("last_error", ""), "429 error redacted")

    adapter._record_gemini_failure(record, "gemini-503", RuntimeError("503 service unavailable"))
    state = adapter._gemini_state_snapshot(record, "gemini-503")
    assert_equal(state.get("last_status"), "transient", "5xx classification")
    assert_true(float(state.get("cooldown_until", 0)) > 0, "5xx cooldown set")

    adapter._record_gemini_failure(record, "gemini-timeout", TimeoutError("timed out"))
    state = adapter._gemini_state_snapshot(record, "gemini-timeout")
    assert_equal(state.get("last_status"), "transient", "timeout classification")
    assert_true(float(state.get("cooldown_until", 0)) > 0, "timeout cooldown set")

    adapter._record_gemini_failure(record, "gemini-403", RuntimeError("403 invalid API key fake-key-1"))
    state = adapter._gemini_state_snapshot(record, "gemini-403")
    assert_equal(state.get("last_status"), "invalid_key", "403 classification")
    assert_true(state.get("disabled") is True, "403 disables key")
    assert_true("fake-key-1" not in state.get("last_error", ""), "403 error redacted")

    adapter._record_gemini_failure(record, "gemma-missing", RuntimeError("404 model not found"))
    state = adapter._gemini_state_snapshot(record, "gemma-missing")
    assert_equal(state.get("last_status"), "model_unavailable", "model unavailable classification")
    assert_true(not state.get("disabled"), "model-not-found must not disable key")


def test_redaction():
    test_key = "TEST_GEMINI_KEY_1_NOT_REAL"
    reset_gemini_state([adapter.GeminiKeyRecord(1, "GEMINI_API_KEY_1", test_key)])
    redacted = adapter._redact_secrets(f"{test_key} provider failure")
    assert_true(test_key not in redacted, "pool key redacted")


def test_groq_to_gemini_standard_fallback():
    reset_gemini_state([adapter.GeminiKeyRecord(1, "GEMINI_API_KEY_1", "fake-key-1")])
    gemini_calls = []
    pollinations_calls = []

    def fake_call_gemini(prompt, api_key, model=None, **kwargs):
        gemini_calls.append((api_key, model, kwargs))
        return f"gemini:{model}"

    def fake_call_pollinations(*args, **kwargs):
        pollinations_calls.append(args)
        return "pollinations", "stop", False

    with patched(
        _cache_get=lambda _key: None,
        _cache_set=lambda _key, _value: None,
        _invoke_groq=lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("forced groq failure")),
        _call_gemini=fake_call_gemini,
        _call_pollinations=fake_call_pollinations,
    ):
        result = adapter.call_llm_router(
            "standard fallback",
            task="chat",
            prefer="groq",
            model_override="gpt-oss-120b",
        )

    assert_equal(result.get("text"), f"gemini:{adapter.GEMINI_STANDARD_MODEL}", "standard fallback text")
    assert_equal(result.get("model_used"), adapter.GEMINI_STANDARD_MODEL, "standard fallback model")
    assert_true(result.get("fallback") is True, "standard fallback marked")
    assert_equal(len(pollinations_calls), 0, "Pollinations not used before Gemini standard fallback")
    assert_equal(gemini_calls[0][0], "fake-key-1", "Gemini fallback used configured key")


def test_reasoning_fallback_order():
    reset_gemini_state([adapter.GeminiKeyRecord(1, "GEMINI_API_KEY_1", "fake-key-1")])
    gemini_models = []

    def fake_call_gemini(prompt, api_key, model=None, **kwargs):
        gemini_models.append((model, kwargs))
        return f"reasoning:{model}"

    with patched(
        _cache_get=lambda _key: None,
        _cache_set=lambda _key, _value: None,
        _invoke_groq=lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("forced groq reasoning failure")),
        _call_gemini=fake_call_gemini,
        _call_pollinations=lambda *args, **kwargs: ("pollinations", "stop", False),
    ):
        result = adapter.call_llm_router(
            "reasoning fallback",
            task="chat",
            prefer="groq",
            model_override="gpt-oss-120b",
            skip_wrappers=True,
        )

    assert_equal(result.get("model_used"), adapter.GEMINI_REASONING_MODEL, "reasoning Gemini primary")
    assert_equal(gemini_models[0][0], adapter.GEMINI_REASONING_MODEL, "reasoning first attempt")


def test_gemini_lite_falls_to_pollinations_after_gemma_failures():
    reset_gemini_state([adapter.GeminiKeyRecord(1, "GEMINI_API_KEY_1", "fake-key-1")])
    gemini_models = []
    pollinations_models = []

    def fake_call_gemini(prompt, api_key, model=None, **kwargs):
        gemini_models.append(model)
        raise RuntimeError("503 Gemini unavailable")

    def fake_call_pollinations(prompt, model, **kwargs):
        pollinations_models.append(model)
        return "pollinations-lite", "stop", False

    with patched(
        _cache_get=lambda _key: None,
        _cache_set=lambda _key, _value: None,
        _call_gemini=fake_call_gemini,
        _call_pollinations=fake_call_pollinations,
    ):
        result = adapter.call_llm_router(
            "lite fallback",
            task="chat",
            model_override="gemini:gemini-lite",
        )

    assert_equal(gemini_models[:3], [adapter.GEMINI_LITE_MODEL, adapter.GEMMA_PRIMARY_MODEL, adapter.GEMMA_SECONDARY_MODEL], "lite then Gemma attempts")
    assert_equal(pollinations_models, [adapter.POLLINATIONS_LITE_MODEL], "lite Pollinations last resort")
    assert_equal(result.get("text"), "pollinations-lite", "lite Pollinations text")
    assert_equal(result.get("model_used"), adapter.POLLINATIONS_LITE_MODEL, "lite Pollinations model")


def test_web_attempts_google_search_gate():
    with patched(GEMINI_GOOGLE_SEARCH_ENABLED=True):
        attempts = adapter._web_gemini_attempts()
    assert_equal(
        [(attempt.model, attempt.google_search) for attempt in attempts[:2]],
        [(adapter.GEMINI_WEB_MODEL, True), (adapter.GEMINI_WEB_BACKUP_MODEL, True)],
        "web grounding attempts first when enabled",
    )

    with patched(GEMINI_GOOGLE_SEARCH_ENABLED=False):
        attempts = adapter._web_gemini_attempts()
    assert_true(all(not attempt.google_search for attempt in attempts), "web grounding disabled by default")


def test_public_sanitizer_omits_internal_chain_fields():
    server_source = Path(__file__).with_name("server.ts").read_text(encoding="utf-8")
    assert_true('"fallback_reason"' in server_source, "server sanitizer omits fallback_reason")
    assert_true('"error_detail"' in server_source, "server sanitizer omits error_detail")
    assert_true("sanitizePublicPayload" in server_source, "public payload sanitizer exists")


TESTS = [
    test_six_key_parsing_and_legacy_slot,
    test_stable_round_robin_indexes,
    test_failure_health_state,
    test_redaction,
    test_groq_to_gemini_standard_fallback,
    test_reasoning_fallback_order,
    test_gemini_lite_falls_to_pollinations_after_gemma_failures,
    test_web_attempts_google_search_gate,
    test_public_sanitizer_omits_internal_chain_fields,
]


def main() -> int:
    failures = 0
    for test in TESTS:
        try:
            test()
            print(f"PASS | {test.__name__}")
        except Exception as exc:
            failures += 1
            print(f"FAIL | {test.__name__}: {exc}")

    if failures:
        print(f"Gemini fallback routing validation failed: {failures} case(s) failed.")
        return 1

    print("Gemini fallback routing validation passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
