import os
import sys
import time
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


def reset_gemini_state(records=None):
    records = records or [
        adapter.GeminiKeyRecord(1, "GEMINI_API_KEY_1", "fake-key-1"),
        adapter.GeminiKeyRecord(2, "GEMINI_API_KEY_2", "fake-key-2"),
    ]
    adapter.GEMINI_KEY_RECORDS = list(records)
    adapter.GEMINI_API_KEYS = [record.key for record in records]
    adapter._gemini_key_state.clear()
    adapter._gemini_disabled_key_slots.clear()
    adapter._gemini_key_rotation_index = 0
    return records


def assert_equal(actual, expected, label):
    if actual != expected:
        raise AssertionError(f"{label}: expected {expected!r}, got {actual!r}")


def assert_true(value, label):
    if not value:
        raise AssertionError(label)


def test_lite_pool_definition_and_ordering():
    expected_pool = [
        "gemini-3.8-flash",
        "gemini-3.7-flash",
        "gemini-3.6-flash",
        "gemini-3.5-flash-lite",
        "gemini-3.5-flash",
        "gemini-3.1-flash-lite",
        "gemini-3-flash",
        "gemini-2.5-flash-lite",
        "gemma-4-31b-it",
        "gemma-4-26b-a4b-it",
        "gemini-2.5-flash",
    ]
    assert_equal(adapter.ORDERED_LITE_MODELS, expected_pool, "exact 11 lite models and order")
    assert_equal(len(adapter.ORDERED_LITE_MODELS), 11, "11 lite models in pool")


def test_key_major_candidate_traversal():
    records = reset_gemini_state([
        adapter.GeminiKeyRecord(1, "GEMINI_API_KEY_1", "fake-key-1"),
        adapter.GeminiKeyRecord(2, "GEMINI_API_KEY_2", "fake-key-2"),
    ])
    candidates = adapter._get_lite_pool_candidates()
    assert_equal(len(candidates), 22, "2 keys * 11 models = 22 candidates")

    # Key 1 must contain all 11 models before Key 2
    key1_candidates = candidates[:11]
    key2_candidates = candidates[11:]

    assert_true(all(rec.index == 1 for rec, _ in key1_candidates), "first 11 candidates must be Key 1")
    assert_equal([m for _, m in key1_candidates], adapter.ORDERED_LITE_MODELS, "Key 1 models match ordered pool")

    assert_true(all(rec.index == 2 for rec, _ in key2_candidates), "next 11 candidates must be Key 2")
    assert_equal([m for _, m in key2_candidates], adapter.ORDERED_LITE_MODELS, "Key 2 models match ordered pool")


def test_first_request_uses_key_1_gemini_38_flash():
    reset_gemini_state()
    invocations = []

    def fake_call_gemini(prompt, api_key, model=None, **kwargs):
        invocations.append((api_key, model))
        return "response-3.8"

    with patched(
        _cache_get=lambda _key: None,
        _cache_set=lambda _key, _value: None,
        _call_gemini=fake_call_gemini,
    ):
        result, used_model = adapter._invoke_gemini_lite_pool("hello")

    assert_equal(result, "response-3.8", "invoke result")
    assert_equal(used_model, "gemini-3.8-flash", "used model name")
    assert_equal(invocations, [("fake-key-1", "gemini-3.8-flash")], "first call uses key 1 and model 1")


def test_429_on_model_advances_to_next_model_on_same_key():
    reset_gemini_state()
    invocations = []

    def fake_call_gemini(prompt, api_key, model=None, **kwargs):
        invocations.append((api_key, model))
        if model == "gemini-3.8-flash":
            raise RuntimeError("429 Resource exhausted: quota exceeded")
        return f"success:{model}"

    with patched(
        _cache_get=lambda _key: None,
        _cache_set=lambda _key, _value: None,
        _call_gemini=fake_call_gemini,
    ):
        result, used_model = adapter._invoke_gemini_lite_pool("test 429")

    assert_equal(result, "success:gemini-3.7-flash", "fallback result")
    assert_equal(used_model, "gemini-3.7-flash", "fallback used model")
    assert_equal(
        invocations,
        [
            ("fake-key-1", "gemini-3.8-flash"),
            ("fake-key-1", "gemini-3.7-flash"),
        ],
        "429 immediately falls back to next model on same key (does not jump to key 2)",
    )


def test_exhausting_all_models_on_key1_moves_to_key2_model1():
    reset_gemini_state()
    invocations = []

    def fake_call_gemini(prompt, api_key, model=None, **kwargs):
        invocations.append((api_key, model))
        if api_key == "fake-key-1":
            raise RuntimeError("429 quota exhausted on key 1")
        return f"success:{api_key}:{model}"

    with patched(
        _cache_get=lambda _key: None,
        _cache_set=lambda _key, _value: None,
        _call_gemini=fake_call_gemini,
    ):
        result, used_model = adapter._invoke_gemini_lite_pool("test key exhaust")

    assert_equal(result, "success:fake-key-2:gemini-3.8-flash", "key 2 result")
    assert_equal(used_model, "gemini-3.8-flash", "key 2 restarts from model 1")
    assert_equal(len(invocations), 12, "11 attempts on key 1 then 1 on key 2")
    assert_equal(invocations[11], ("fake-key-2", "gemini-3.8-flash"), "key 2 starts with gemini-3.8-flash")


def test_local_cooldown_respected_without_remote_checks():
    records = reset_gemini_state()
    key1 = records[0]

    # Artificially fail gemini-3.8-flash on key 1
    adapter._record_gemini_failure(key1, "gemini-3.8-flash", RuntimeError("429 Rate limited"))

    # Candidates should now skip key 1 gemini-3.8-flash
    candidates = adapter._get_lite_pool_candidates()
    assert_equal(candidates[0], (key1, "gemini-3.7-flash"), "first candidate skips cooled-down 3.8-flash")


def test_success_clears_only_exact_key_model_state():
    records = reset_gemini_state()
    key1 = records[0]

    # Record 429 for gemini-3.8-flash
    adapter._record_gemini_failure(key1, "gemini-3.8-flash", RuntimeError("429 Rate limited"))
    # Record transient for gemini-3.7-flash
    adapter._record_gemini_failure(key1, "gemini-3.7-flash", RuntimeError("503 Backend error"))

    # Success on gemini-3.7-flash
    adapter._record_gemini_success(key1, "gemini-3.7-flash")

    # 3.7 state should be cleared
    state_37 = adapter._gemini_state_snapshot(key1, "gemini-3.7-flash")
    assert_equal(state_37, {}, "3.7 state is cleared")

    # 3.8 state should still be in cooldown!
    state_38 = adapter._gemini_state_snapshot(key1, "gemini-3.8-flash")
    assert_equal(state_38.get("last_status"), "rate_limited", "3.8 remains rate-limited")
    assert_true(float(state_38.get("cooldown_until", 0)) > time.time(), "3.8 cooldown active")


def test_independent_state_across_models():
    records = reset_gemini_state()
    key1 = records[0]

    adapter._record_gemini_failure(key1, "gemini-3.8-flash", RuntimeError("429 rate limit"))
    available_38 = adapter._gemini_candidate_available(key1, "gemini-3.8-flash")
    available_37 = adapter._gemini_candidate_available(key1, "gemini-3.7-flash")

    assert_equal(available_38, False, "3.8 is unavailable due to cooldown")
    assert_equal(available_37, True, "3.7 remains available on the same key")


def test_retry_after_extraction():
    records = reset_gemini_state()
    key1 = records[0]

    # Test with string mentioning retry after 42s
    adapter._record_gemini_failure(
        key1,
        "gemini-3.8-flash",
        RuntimeError("429 Resource exhausted: please retry after 42s or later"),
    )
    state = adapter._gemini_state_snapshot(key1, "gemini-3.8-flash")
    cooldown_until = float(state.get("cooldown_until", 0))
    now = time.time()
    assert_true(cooldown_until >= now + 40 and cooldown_until <= now + 45, "retry-after 42s respected")


def test_transient_vs_rate_limit_distinction():
    records = reset_gemini_state()
    key1 = records[0]

    adapter._record_gemini_failure(key1, "gemini-3.8-flash", RuntimeError("503 Service Unavailable"))
    state_503 = adapter._gemini_state_snapshot(key1, "gemini-3.8-flash")
    assert_equal(state_503.get("last_status"), "transient", "503 classified as transient")

    adapter._record_gemini_failure(key1, "gemini-3.7-flash", RuntimeError("429 Too Many Requests"))
    state_429 = adapter._gemini_state_snapshot(key1, "gemini-3.7-flash")
    assert_equal(state_429.get("last_status"), "rate_limited", "429 classified as rate_limited")


def test_404_model_unavailable_does_not_disable_key():
    records = reset_gemini_state()
    key1 = records[0]

    adapter._record_gemini_failure(key1, "gemini-3.8-flash", RuntimeError("404 Model not found"))
    state = adapter._gemini_state_snapshot(key1, "gemini-3.8-flash")
    assert_equal(state.get("last_status"), "model_unavailable", "classified as model_unavailable")
    assert_true(not state.get("disabled"), "404 does not disable key slot")
    assert_true(key1.index not in adapter._gemini_disabled_key_slots, "key slot is not in disabled set")

    # Next model on same key is available
    assert_true(
        adapter._gemini_candidate_available(key1, "gemini-3.7-flash"),
        "subsequent model on same key is available",
    )


def test_invalid_key_disables_key_slot_only():
    records = reset_gemini_state()
    key1 = records[0]
    key2 = records[1]

    adapter._record_gemini_failure(key1, "gemini-3.8-flash", RuntimeError("403 Forbidden: API key expired"))
    assert_true(key1.index in adapter._gemini_disabled_key_slots, "key 1 slot disabled")
    assert_true(key2.index not in adapter._gemini_disabled_key_slots, "key 2 slot remains active")

    candidates = adapter._get_lite_pool_candidates()
    assert_true(all(rec.index == 2 for rec, _ in candidates), "all candidates now use key 2")


def test_final_fallback_to_pollinations_after_full_lite_pool_failure():
    reset_gemini_state()
    pollinations_called = []

    def fake_call_gemini(prompt, api_key, model=None, **kwargs):
        raise RuntimeError("429 all keys and models exhausted")

    def fake_call_pollinations(prompt, model, **kwargs):
        pollinations_called.append(model)
        return "pollinations-answer", "stop", False

    with patched(
        _cache_get=lambda _key: None,
        _cache_set=lambda _key, _value: None,
        _call_gemini=fake_call_gemini,
        _call_pollinations=fake_call_pollinations,
    ):
        result = adapter.call_llm_router(
            "hello lite",
            task="chat",
            model_override="gemini:gemini-lite",
        )

    assert_equal(pollinations_called, [adapter.POLLINATIONS_LITE_MODEL], "falls back to pollinations lite model")
    assert_equal(result.get("text"), "pollinations-answer", "result text from pollinations")
    assert_equal(result.get("model_used"), adapter.POLLINATIONS_LITE_MODEL, "model used is pollinations")


def test_streaming_failover_before_output():
    reset_gemini_state()
    invocations = []

    def fake_call_gemini_stream(prompt, api_key, model=None, **kwargs):
        invocations.append((api_key, model))
        if model == "gemini-3.8-flash":
            raise RuntimeError("429 rate limit on stream start")
        yield "chunk-1"
        yield "chunk-2"

    with patched(
        _cache_get=lambda _key: None,
        _cache_set=lambda _key, _value: None,
        _call_gemini_stream=fake_call_gemini_stream,
    ):
        chunks = list(adapter._stream_gemini_lite_pool("test stream failover"))

    assert_equal(chunks, ["chunk-1", "chunk-2"], "stream yielded chunks")
    assert_equal(
        invocations,
        [
            ("fake-key-1", "gemini-3.8-flash"),
            ("fake-key-1", "gemini-3.7-flash"),
        ],
        "streaming failed over before any text was emitted",
    )


def test_no_streaming_failover_after_visible_output_emitted():
    reset_gemini_state()
    invocations = []

    def fake_call_gemini_stream(prompt, api_key, model=None, **kwargs):
        invocations.append((api_key, model))
        yield "first-visible-chunk"
        raise RuntimeError("mid-stream disconnect")

    with patched(
        _cache_get=lambda _key: None,
        _cache_set=lambda _key, _value: None,
        _call_gemini_stream=fake_call_gemini_stream,
    ):
        gen = adapter._stream_gemini_lite_pool("test midstream")
        first = next(gen)
        assert_equal(first, "first-visible-chunk", "received first chunk")
        try:
            next(gen)
            assert_true(False, "mid-stream error should be re-raised")
        except RuntimeError as err:
            assert_true("mid-stream disconnect" in str(err), "re-raised original mid-stream error")

    assert_equal(
        invocations,
        [("fake-key-1", "gemini-3.8-flash")],
        "did NOT attempt failover to next model after visible chunk was emitted",
    )


def test_capability_filtering():
    reset_gemini_state()

    # image_input capability skips Gemma
    candidates_tool = adapter._get_lite_pool_candidates(required_capabilities=["image_input"])
    models_tool = [m for _, m in candidates_tool[:9]]  # Key 1 has 9 models without 2 Gemma models
    assert_true("gemma-4-31b-it" not in models_tool, "Gemma 31b omitted for image_input requirement")
    assert_true("gemma-4-26b-a4b-it" not in models_tool, "Gemma 26b omitted for image_input requirement")
    assert_equal(len(candidates_tool), 18, "2 keys * 9 models = 18 candidates")

    # Image attachments skips Gemma
    candidates_image = adapter._get_lite_pool_candidates(image_attachments=[{"type": "image/png"}])
    models_image = [m for _, m in candidates_image[:9]]
    assert_true("gemma-4-31b-it" not in models_image, "Gemma 31b omitted for image attachments")
    assert_true("gemma-4-26b-a4b-it" not in models_image, "Gemma 26b omitted for image attachments")
    assert_equal(len(candidates_image), 18, "2 keys * 9 models = 18 candidates")


def test_legacy_aliases_route_to_lite_pool():
    reset_gemini_state()
    aliases = ["gemini-lite", "gemini:gemini-lite"]
    for alias in aliases:
        assert_true(adapter._is_lite_model("gemini-3.1-flash-lite", alias), f"alias {alias} is lite model")


def test_401_disables_key_slot_across_all_models():
    records = reset_gemini_state()
    key1 = records[0]
    adapter._record_gemini_failure(key1, "gemini-3.8-flash", RuntimeError("401 Unauthorized: Invalid API key"))
    assert_true(key1.index in adapter._gemini_disabled_key_slots, "401 disables key slot")


def test_model_specific_403_does_not_disable_key_slot():
    records = reset_gemini_state()
    key1 = records[0]
    # Model-specific 403 (e.g. model permission denied)
    adapter._record_gemini_failure(
        key1,
        "gemma-4-31b-it",
        RuntimeError("403 Forbidden: User has not been granted access to model gemma-4-31b-it"),
    )
    assert_true(key1.index not in adapter._gemini_disabled_key_slots, "model-specific 403 must not disable key slot")
    state = adapter._gemini_state_snapshot(key1, "gemma-4-31b-it")
    assert_equal(state.get("last_status"), "model_unavailable", "model-specific 403 classified as model_unavailable")
    assert_true(not state.get("disabled"), "key is not disabled")
    assert_true(adapter._gemini_candidate_available(key1, "gemini-3.8-flash"), "other models on same key remain available")


def test_concrete_model_does_not_enter_lite_pool():
    reset_gemini_state()
    # Explicit request for concrete model gemini-3.1-flash-lite must not enter Lite pool
    assert_true(not adapter._is_lite_model("gemini-3.1-flash-lite", "gemini-3.1-flash-lite"), "concrete model override")
    # Standard route must not enter Lite pool
    assert_true(not adapter._is_lite_model("gemini-3.1-flash-lite", "gemini-standard"), "standard route override")
    # Reasoning route must not enter Lite pool
    assert_true(not adapter._is_lite_model("gemini-3.5-flash", "gemini-reasoning"), "reasoning route override")
    # Web route must not enter Lite pool
    assert_true(not adapter._is_lite_model("gemini-2.5-flash-lite", "gemini-web"), "web route override")
    # Direct Lite aliases DO enter Lite pool
    assert_true(adapter._is_lite_model("gemini-3.1-flash-lite", "gemini:gemini-lite"), "gemini:gemini-lite alias")
    assert_true(adapter._is_lite_model("gemini-3.1-flash-lite", "gemini-lite"), "gemini-lite alias")


def test_retry_after_clamping():
    records = reset_gemini_state()
    key1 = records[0]

    # Absurdly high retry-after (e.g. 1000s) clamped to 300s ceiling
    adapter._record_gemini_failure(
        key1,
        "gemini-3.8-flash",
        RuntimeError("429 Resource exhausted: retry after 1000s"),
    )
    state = adapter._gemini_state_snapshot(key1, "gemini-3.8-flash")
    cooldown_until = float(state.get("cooldown_until", 0))
    now = time.time()
    assert_true(cooldown_until <= now + 305 and cooldown_until >= now + 295, "retry-after clamped to 300s")


def main():
    test_lite_pool_definition_and_ordering()
    test_key_major_candidate_traversal()
    test_first_request_uses_key_1_gemini_38_flash()
    test_429_on_model_advances_to_next_model_on_same_key()
    test_exhausting_all_models_on_key1_moves_to_key2_model1()
    test_local_cooldown_respected_without_remote_checks()
    test_success_clears_only_exact_key_model_state()
    test_independent_state_across_models()
    test_retry_after_extraction()
    test_transient_vs_rate_limit_distinction()
    test_404_model_unavailable_does_not_disable_key()
    test_invalid_key_disables_key_slot_only()
    test_401_disables_key_slot_across_all_models()
    test_model_specific_403_does_not_disable_key_slot()
    test_concrete_model_does_not_enter_lite_pool()
    test_retry_after_clamping()
    test_final_fallback_to_pollinations_after_full_lite_pool_failure()
    test_streaming_failover_before_output()
    test_no_streaming_failover_after_visible_output_emitted()
    test_capability_filtering()
    test_legacy_aliases_route_to_lite_pool()
    print("PASS | All Gemini Lite Quota Router tests passed successfully.")


if __name__ == "__main__":
    main()
