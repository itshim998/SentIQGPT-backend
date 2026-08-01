import os
import sys
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace

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
def patched_flags(provider: bool, lane: bool):
    names = {
        "SENTIQ_NVIDIA_PROVIDER_ENABLED": "true" if provider else "false",
        "SENTIQ_NEMOTRON_INTUITIVE_ENABLED": "true" if lane else "false",
    }
    originals = {name: os.environ.get(name) for name in names}
    try:
        os.environ.update(names)
        yield
    finally:
        for name, value in originals.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value


class FakeNvidiaProvider:
    def __init__(self, *, fail: bool = False):
        self.fail = fail
        self.complete_calls = []
        self.stream_calls = []

    def complete(self, prompt, *, max_tokens, reasoning_budget, sentiq_tool_request=None):
        self.complete_calls.append((prompt, max_tokens, reasoning_budget))
        if self.fail:
            raise RuntimeError("simulated primary exhaustion")
        return (
            "intuitive-visible",
            SimpleNamespace(input_tokens=40, output_tokens=140, total_tokens=180),
            "nvidia-slot-2",
        )

    def stream(self, prompt, *, max_tokens, reasoning_budget, sentiq_tool_request=None):
        self.stream_calls.append((prompt, max_tokens, reasoning_budget))
        if self.fail:
            raise RuntimeError("simulated primary exhaustion")
        yield "intuitive-"
        yield "visible"
        yield {
            "kind": "provider_usage",
            "usage": {
                "input_tokens": 40,
                "output_tokens": 140,
                "total_tokens": 180,
                "hidden_reasoning_tokens": 100,
                "source": "reported",
            },
            "slot_id": "nvidia-slot-2",
        }


class PartialFailureNvidiaProvider(FakeNvidiaProvider):
    def stream(self, prompt, *, max_tokens, reasoning_budget, sentiq_tool_request=None):
        self.stream_calls.append((prompt, max_tokens, reasoning_budget))
        yield "partial-visible"
        raise RuntimeError("simulated disconnect after visible output")


def assert_equal(actual, expected, label):
    if actual != expected:
        raise AssertionError(f"{label}: expected {expected!r}, got {actual!r}")


def assert_true(value, label):
    if not value:
        raise AssertionError(label)


def common_patches(provider):
    return patched(
        NVIDIA_NEMOTRON_PROVIDER=provider,
        _cache_get=lambda _key: None,
        _cache_set=lambda _key, _value: None,
    )


def test_flag_matrix_and_buffered_routing():
    provider = FakeNvidiaProvider()
    groq_calls = []
    with common_patches(provider), patched(
        _invoke_groq=lambda *args, **kwargs: groq_calls.append((args, kwargs)) or "legacy-visible",
    ):
        with patched_flags(False, False):
            legacy = adapter.call_llm_router(
                "legacy request",
                task="chat",
                prefer="groq",
                model_override="gpt-oss-120b",
                execution_mode="intuitive",
            )
        with patched_flags(True, False):
            provider_only = adapter.call_llm_router(
                "provider-only request",
                task="chat",
                prefer="groq",
                model_override="gpt-oss-120b",
                execution_mode="intuitive",
            )
        with patched_flags(False, True):
            lane_only = adapter.call_llm_router(
                "lane-only request",
                task="chat",
                prefer="groq",
                model_override="gpt-oss-120b",
                execution_mode="intuitive",
            )
        with patched_flags(True, True):
            intuitive = adapter.call_llm_router(
                "new lane request",
                task="chat",
                prefer="groq",
                model_override="gpt-oss-120b",
                max_output_tokens=6_000,
                execution_mode="intuitive",
                budget_policy={"reasoning_budget_tokens": 2_000},
            )

    assert_equal(legacy["text"], "legacy-visible", "all-off route")
    assert_equal(provider_only["text"], "legacy-visible", "provider-only route")
    assert_equal(lane_only["text"], "legacy-visible", "lane-only fail-closed route")
    assert_equal(len(groq_calls), 3, "legacy route count")
    assert_equal(intuitive["text"], "intuitive-visible", "Intuitive primary route")
    assert_equal(intuitive["model_used"], None, "new provider branding hidden")
    assert_equal(intuitive["telemetry"]["usage"]["output_tokens"], 140, "reported usage propagated")
    assert_equal(provider.complete_calls[0][1:], (6_000, 2_000), "generation and reasoning budgets")


def test_fast_never_selects_nvidia():
    provider = FakeNvidiaProvider()
    groq_calls = []
    with patched_flags(True, True), common_patches(provider), patched(
        _invoke_groq=lambda *args, **kwargs: groq_calls.append((args, kwargs)) or "fast-visible",
    ):
        result = adapter.call_llm_router(
            "fast request",
            task="chat",
            prefer="groq",
            model_override="gpt-oss-120b",
            execution_mode="fast",
        )
    assert_equal(result["text"], "fast-visible", "Fast response")
    assert_equal(len(groq_calls), 1, "Fast Groq invocation")
    assert_equal(len(provider.complete_calls), 0, "Fast NVIDIA invocation count")


def test_tool_selection_routes_to_nvidia_when_enabled():
    with patched_flags(True, True), patched(SENTIQ_MODEL_TOOL_REGISTRY_ENABLED=True):
        assert_true(
            adapter._nemotron_intuitive_lane_enabled(
                "intuitive",
                "chat",
                sentiq_tool_request={
                    "allowed_tool_names": ["image_gen"],
                    "tools": [{"name": "image_gen", "input_schema": {"type": "object"}}],
                },
                required_capabilities=["sentiq_tools_buffered"],
            ),
            "tool-selection turn must route to the enabled native Intuitive provider",
        )
        assert_equal(
            adapter._apply_execution_mode_output_cap(
                "chat",
                None,
                "intuitive",
                nemotron_generation=False,
            ),
            3_500,
            "legacy Intuitive cap for non-generation turns",
        )
        assert_equal(
            adapter._apply_execution_mode_output_cap(
                "chat",
                None,
                "intuitive",
                nemotron_generation=True,
            ),
            8_000,
            "Nemotron Intuitive provider cap",
        )


def test_pollinations_only_after_primary_failure():
    provider = FakeNvidiaProvider(fail=True)
    pollinations_calls = []

    def fake_pollinations(prompt, model, **kwargs):
        pollinations_calls.append((prompt, model, kwargs))
        return "last-resort-visible", "stop", False

    with patched_flags(True, True), common_patches(provider), patched(
        POLLINATIONS_INTUITIVE_MODEL="verified-test-model",
        _call_pollinations=fake_pollinations,
    ):
        result = adapter.call_llm_router(
            "fallback request",
            task="chat",
            model_override="gpt-oss-120b",
            execution_mode="intuitive",
        )

    assert_equal(result["text"], "last-resort-visible", "last-resort response")
    assert_equal(result["model_used"], None, "last-resort branding hidden")
    assert_equal(result["fallback_reason"], "intuitive_primary_unavailable", "generic fallback reason")
    assert_equal(len(pollinations_calls), 1, "last-resort invocation count")
    assert_equal(pollinations_calls[0][1], "verified-test-model", "configured model identifier")

    pollinations_calls.clear()
    with patched_flags(True, True), common_patches(provider), patched(
        POLLINATIONS_INTUITIVE_MODEL="",
        _call_pollinations=fake_pollinations,
    ):
        unavailable = adapter.call_llm_router(
            "unconfigured fallback request",
            task="chat",
            model_override="gpt-oss-120b",
            execution_mode="intuitive",
        )
    assert_equal(unavailable["error"], "provider_failed", "unconfigured last-resort error")
    assert_true(
        "nvidia" not in str(unavailable.get("error_detail", "")).lower()
        and "nemotron" not in str(unavailable.get("error_detail", "")).lower(),
        "public failure detail hides provider branding",
    )
    assert_equal(len(pollinations_calls), 0, "unconfigured last-resort must not be guessed")


def test_stream_usage_without_hidden_text():
    provider = FakeNvidiaProvider()
    with patched_flags(True, True), common_patches(provider):
        items = list(adapter.stream_llm_router(
            "stream request",
            task="chat",
            model_override="gpt-oss-120b",
            max_output_tokens=8_000,
            execution_mode="intuitive",
            budget_policy={"reasoning_budget_tokens": 3_500},
        ))
    visible = "".join(item for item in items if isinstance(item, str))
    usage_events = [
        item for item in items
        if isinstance(item, dict) and item.get("kind") == "provider_usage"
    ]
    assert_equal(visible, "intuitive-visible", "visible stream")
    assert_equal(len(usage_events), 1, "internal usage event")
    assert_equal(usage_events[0]["usage"]["hidden_reasoning_tokens"], 100, "hidden usage count")
    assert_true("reasoning_content" not in repr(items), "hidden reasoning field must not leak")
    assert_equal(provider.stream_calls[0][1:], (8_000, 3_500), "stream budgets")


def test_stream_does_not_fallback_after_visible_output():
    provider = PartialFailureNvidiaProvider()
    pollinations_calls = []

    def fake_pollinations_stream(*args, **kwargs):
        pollinations_calls.append((args, kwargs))
        yield "must-not-run"

    with patched_flags(True, True), common_patches(provider), patched(
        POLLINATIONS_INTUITIVE_MODEL="verified-test-model",
        _call_pollinations_stream=fake_pollinations_stream,
    ):
        stream = adapter.stream_llm_router(
            "partial stream request",
            task="chat",
            model_override="gpt-oss-120b",
            execution_mode="intuitive",
        )
        assert_equal(next(stream), "partial-visible", "partial visible output")
        try:
            next(stream)
            raise AssertionError("stream failure after visible output should propagate")
        except RuntimeError as error:
            assert_true("disconnect" in str(error), "original visible-stream failure propagated")
    assert_equal(len(pollinations_calls), 0, "no provider fallback after visible output")


def main() -> int:
    tests = [
        test_flag_matrix_and_buffered_routing,
        test_fast_never_selects_nvidia,
        test_tool_selection_routes_to_nvidia_when_enabled,
        test_pollinations_only_after_primary_failure,
        test_stream_usage_without_hidden_text,
        test_stream_does_not_fallback_after_visible_output,
    ]
    for test in tests:
        test()
        print(f"PASS | {test.__name__}")
    print(f"Nemotron routing validation passed: {len(tests)} test(s).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
