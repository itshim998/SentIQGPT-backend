import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import llm_adapter as adapter


TOOL_REQUEST = {
    "registry_version": "2026-07-pass1-v1",
    "allowed_tool_fingerprint": "guest-tools",
    "tool_choice_policy": "Answer normally unless a tool is genuinely required.",
    "allowed_tool_names": ["web_surf", "image_gen"],
    "availability_context": {"authenticated": False},
    "tools": [
        {
            "name": "web_surf",
            "description": "Search current sources.",
            "input_schema": {
                "type": "object",
                "additionalProperties": False,
                "properties": {"query": {"type": "string"}},
                "required": ["query"],
            },
        }
    ],
}


class FakeRawResponse:
    headers = {}

    def __init__(self, value):
        self.value = value

    def parse(self):
        return self.value


class FakeRawCompletions:
    def __init__(self, owner):
        self.owner = owner

    def create(self, **kwargs):
        self.owner.calls.append(kwargs)
        return FakeRawResponse(self.owner.responses.pop(0))


class FakeCompletions:
    def __init__(self, responses):
        self.responses = list(responses)
        self.calls = []
        self.with_raw_response = FakeRawCompletions(self)


def groq_chunk(*, call_id="", name="", arguments="", content=None, finish_reason=None, include_tool_call=True):
    tool_calls = []
    if include_tool_call:
        function = SimpleNamespace(name=name, arguments=arguments)
        tool_calls = [SimpleNamespace(index=0, id=call_id, function=function)]
    delta = SimpleNamespace(tool_calls=tool_calls, content=content)
    return SimpleNamespace(choices=[SimpleNamespace(delta=delta, finish_reason=finish_reason)])


def test_capabilities_and_cache_dimensions():
    with patch.object(adapter, "SENTIQ_MODEL_TOOL_REGISTRY_ENABLED", True), patch.object(
        adapter, "SENTIQ_GROQ_TOOL_TRANSPORT_ENABLED", True
    ), patch.object(adapter, "SENTIQ_GEMINI_TOOL_TRANSPORT_ENABLED", True), patch.object(
        adapter, "GOOGLE_GENAI_MODULE", object()
    ):
        assert adapter.get_sentiq_tool_capability("groq", adapter.GROQ_CHAT_MODEL)["supported"] is True
        assert adapter.get_sentiq_tool_capability("gemini", adapter.GEMINI_STANDARD_MODEL)["supported"] is True
        assert adapter.get_sentiq_tool_capability("gemini", adapter.GEMMA_PRIMARY_MODEL)["supported"] is False
        assert adapter.get_sentiq_tool_capability("pollinations", "openai-large")["supported"] is False
        assert adapter._sentiq_tool_request_for_route(TOOL_REQUEST, "groq", adapter.GROQ_CHAT_MODEL) is TOOL_REQUEST
        assert adapter._sentiq_tool_request_for_route(TOOL_REQUEST, "gemini", adapter.GEMINI_STANDARD_MODEL) is TOOL_REQUEST
        assert adapter._sentiq_tool_request_for_route(TOOL_REQUEST, "gemini", adapter.GEMMA_PRIMARY_MODEL) is None
        assert adapter._sentiq_tool_request_for_route(TOOL_REQUEST, "pollinations", "openai-large") is None

    base = adapter._cache_key("hello", "chat", "model", "groq")
    registry = adapter._cache_key(
        "hello", "chat", "model", "groq",
        tool_registry_version="2026-07-pass5-v1",
        allowed_tool_fingerprint="guest-tools",
        tool_choice_policy="policy",
        tool_capability="openai_function_transport",
    )
    different_tools = adapter._cache_key(
        "hello", "chat", "model", "groq",
        tool_registry_version="2026-07-pass5-v1",
        allowed_tool_fingerprint="authenticated-tools",
        tool_choice_policy="policy",
        tool_capability="openai_function_transport",
    )
    assert len({base, registry, different_tools}) == 3

    writes = []
    fake_cache = SimpleNamespace(set=lambda key, value: writes.append((key, value)))
    with patch.object(adapter, "_memory_cache", fake_cache), patch.object(adapter.threading, "Thread") as thread:
        adapter._cache_set("tool", {"assistant_turn": {"kind": "tool_calls", "calls": []}})
        assert writes == []
        thread.assert_not_called()
        adapter._cache_set("text", {"assistant_turn": {"kind": "assistant_text", "text": "safe"}})
        assert len(writes) == 1
        thread.assert_called_once()


def test_gemini_multimodal_contents_and_hard_capabilities():
    with patch.object(adapter, "GOOGLE_GENAI_TYPES_MODULE", None):
        contents = adapter._build_gemini_contents("Describe this image", [{
            "filename": "sample.png",
            "mime_type": "image/png",
            "base64": "aGk=",
            "size_bytes": 2,
        }])
    assert contents[0] == "Describe this image"
    assert contents[1]["inline_data"]["mime_type"] == "image/png"
    assert contents[1]["inline_data"]["data"] == b"hi"
    assert adapter._route_supports_required_capabilities(
        "gemini", adapter.GEMINI_STANDARD_MODEL, ["image_input"], streaming=False
    ) is True
    assert adapter._route_supports_required_capabilities(
        "groq", adapter.GROQ_CHAT_MODEL, ["image_input"], streaming=False
    ) is False
    assert adapter._route_supports_required_capabilities(
        "gemini", adapter.GEMMA_PRIMARY_MODEL, ["image_input"], streaming=False
    ) is False
    assert adapter._route_supports_required_capabilities(
        "pollinations", "mistral", ["image_input"], streaming=False
    ) is False


def test_groq_buffered_and_fragmented_stream_transport():
    function = SimpleNamespace(name="web_surf", arguments='{"query":"latest release"}')
    message = SimpleNamespace(content=None, tool_calls=[SimpleNamespace(id="groq_1", function=function)])
    buffered = SimpleNamespace(choices=[SimpleNamespace(message=message)])
    streamed_tools = [
        groq_chunk(call_id="groq_2", name="web_surf", arguments='{"query":"lat'),
        groq_chunk(arguments='est release"}', finish_reason="tool_calls"),
    ]
    streamed_text = [groq_chunk(content="ordinary", finish_reason="stop", include_tool_call=False)]
    streamed_empty = [groq_chunk(finish_reason="stop", include_tool_call=False)]
    completions = FakeCompletions([buffered, streamed_tools, streamed_text, streamed_empty])
    client = SimpleNamespace(chat=SimpleNamespace(completions=completions))

    with patch.object(adapter, "GROQ_MODULE", object()), patch.object(
        adapter, "_get_groq_client", return_value=client
    ), patch.object(adapter.groq_bucket, "consume", return_value=True):
        result = adapter._call_groq(
            "Find the latest release",
            "test-key",
            adapter.GROQ_CHAT_MODEL,
            sentiq_tool_request=TOOL_REQUEST,
        )
        events = list(adapter._call_groq_stream(
            "Find the latest release",
            "test-key",
            adapter.GROQ_CHAT_MODEL,
            sentiq_tool_request=TOOL_REQUEST,
        ))
        text_events = list(adapter._call_groq_stream(
            "Say hello",
            "test-key",
            adapter.GROQ_CHAT_MODEL,
            sentiq_tool_request=TOOL_REQUEST,
        ))
        try:
            list(adapter._call_groq_stream(
                "Return nothing",
                "test-key",
                adapter.GROQ_CHAT_MODEL,
                sentiq_tool_request=TOOL_REQUEST,
            ))
        except RuntimeError as error:
            assert "neither assistant text nor a tool call" in str(error)
        else:
            raise AssertionError("an empty Groq registry stream must fail before fallback")

    assert result == {
        "kind": "tool_calls",
        "calls": [{
            "id": "groq_1",
            "name": "web_surf",
            "arguments": '{"query":"latest release"}',
            "index": 0,
        }],
    }
    for request_kwargs in completions.calls:
        assert request_kwargs["tools"] == [{
            "type": "function",
            "function": {
                "name": "web_surf",
                "description": "Search current sources.",
                "parameters": TOOL_REQUEST["tools"][0]["input_schema"],
            },
        }]
        assert {tool.get("type") for tool in request_kwargs["tools"]}.isdisjoint(
            {"browser_search", "code_interpreter"}
        )
        assert request_kwargs["tool_choice"] == "auto"
    assert events == [
        {"kind": "tool_call_start", "id": "groq_2", "name": "web_surf", "index": 0},
        {"kind": "tool_argument_delta", "id": "groq_2", "text": '{"query":"lat', "index": 0},
        {"kind": "tool_argument_delta", "id": "groq_2", "text": 'est release"}', "index": 0},
        {"kind": "done", "finishReason": "tool_calls"},
    ]
    assert text_events == [
        {"kind": "text_delta", "text": "ordinary"},
        {"kind": "done", "finishReason": "stop"},
    ]
    assert adapter._openai_assistant_turn(SimpleNamespace(content="ordinary", tool_calls=[])) == {
        "kind": "assistant_text", "text": "ordinary"
    }
    multiple = adapter._openai_assistant_turn(SimpleNamespace(content=None, tool_calls=[
        SimpleNamespace(id="multi_1", function=SimpleNamespace(name="web_surf", arguments='{"query":"one"}')),
        SimpleNamespace(id="multi_2", function=SimpleNamespace(name="image_gen", arguments='{"prompt":"two"}')),
    ]))
    assert [call["name"] for call in multiple["calls"]] == ["web_surf", "image_gen"]


class FakeGeminiTypes:
    class GenerateContentConfig:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

    class Tool:
        def __init__(self, **kwargs):
            self.kwargs = kwargs

def test_gemini_buffered_and_stream_transport():
    function_call = SimpleNamespace(id="gemini_1", name="web_surf", args={"query": "latest release"})
    buffered = SimpleNamespace(function_calls=[function_call], text="")
    stream_call = SimpleNamespace(id="gemini_2", name="web_surf", args={"query": "latest release"})
    streamed = [SimpleNamespace(function_calls=[stream_call], text="")]
    streamed_text = [SimpleNamespace(function_calls=[], text="ordinary")]
    streamed_empty = [SimpleNamespace(function_calls=[], text="")]

    class FakeModels:
        def __init__(self):
            self.calls = []
            self.stream_responses = [streamed, streamed_text, streamed_empty]

        def generate_content(self, **kwargs):
            self.calls.append(kwargs)
            return buffered

        def generate_content_stream(self, **kwargs):
            self.calls.append(kwargs)
            return iter(self.stream_responses.pop(0))

    models = FakeModels()
    client = SimpleNamespace(models=models)
    with patch.object(adapter, "GOOGLE_GENAI_MODULE", object()), patch.object(
        adapter, "GOOGLE_GENAI_TYPES_MODULE", FakeGeminiTypes
    ), patch.object(adapter, "_get_google_genai_client", return_value=client), patch.object(
        adapter, "_run_gemini_with_timeout", side_effect=lambda callback, _label: callback()
    ), patch.object(adapter.gemini_bucket, "consume", return_value=True):
        result = adapter._call_gemini(
            "Find the latest release",
            "test-key",
            adapter.GEMINI_STANDARD_MODEL,
            sentiq_tool_request=TOOL_REQUEST,
        )
        events = list(adapter._call_gemini_stream(
            "Find the latest release",
            "test-key",
            adapter.GEMINI_STANDARD_MODEL,
            sentiq_tool_request=TOOL_REQUEST,
        ))
        text_events = list(adapter._call_gemini_stream(
            "Say hello",
            "test-key",
            adapter.GEMINI_STANDARD_MODEL,
            sentiq_tool_request=TOOL_REQUEST,
        ))
        try:
            list(adapter._call_gemini_stream(
                "Return nothing",
                "test-key",
                adapter.GEMINI_STANDARD_MODEL,
                sentiq_tool_request=TOOL_REQUEST,
            ))
        except RuntimeError as error:
            assert "neither assistant text nor a tool call" in str(error)
        else:
            raise AssertionError("an empty Gemini registry stream must fail before fallback")

    assert result["kind"] == "tool_calls"
    assert result["calls"][0]["arguments"] == {"query": "latest release"}
    assert len(models.calls) == 4
    for call in models.calls:
        config = call["config"].kwargs
        assert config["tools"] == [{"function_declarations": [{
            "name": "web_surf",
            "description": "Search current sources.",
            "parameters": TOOL_REQUEST["tools"][0]["input_schema"],
        }]}]
        assert all(not isinstance(tool, FakeGeminiTypes.Tool) for tool in config["tools"])
        assert config["system_instruction"] == TOOL_REQUEST["tool_choice_policy"]
    assert events == [
        {"kind": "tool_call_start", "id": "gemini_2", "name": "web_surf", "index": 0},
        {"kind": "tool_argument_delta", "id": "gemini_2", "text": '{"query":"latest release"}', "index": 0},
        {"kind": "done"},
    ]
    assert text_events == [{"kind": "text_delta", "text": "ordinary"}, {"kind": "done"}]
    assert adapter._gemini_assistant_turn(SimpleNamespace(function_calls=[], text="ordinary")) == {
        "kind": "assistant_text", "text": "ordinary"
    }


def test_capability_aware_fallbacks():
    seen_requests = []

    def invoke_gemini(_prompt, model, **kwargs):
        seen_requests.append((model, kwargs.get("sentiq_tool_request")))
        if model == adapter.GEMMA_PRIMARY_MODEL:
            raise RuntimeError("text-only fallback unavailable")
        return {"kind": "tool_calls", "calls": [{
            "id": "fallback_1",
            "name": "web_surf",
            "arguments": {"query": "latest release"},
            "index": 0,
        }]}

    with patch.object(adapter, "_invoke_gemini", side_effect=invoke_gemini), patch.object(
        adapter, "SENTIQ_MODEL_TOOL_REGISTRY_ENABLED", True
    ), patch.object(adapter, "SENTIQ_GEMINI_TOOL_TRANSPORT_ENABLED", True), patch.object(
        adapter, "GOOGLE_GENAI_MODULE", object()
    ):
        result, model = adapter._invoke_gemini_attempt_chain(
            "Find the latest release",
            [adapter.GeminiAttempt(adapter.GEMMA_PRIMARY_MODEL), adapter.GeminiAttempt(adapter.GEMINI_STANDARD_MODEL)],
            sentiq_tool_request=TOOL_REQUEST,
            required_capabilities=["sentiq_tools_buffered"],
        )
    assert model == adapter.GEMINI_STANDARD_MODEL
    assert result["kind"] == "tool_calls"
    assert seen_requests == [(adapter.GEMINI_STANDARD_MODEL, TOOL_REQUEST)]

    fallback_called = {"value": False}

    def fail_before_output(*_args, **_kwargs):
        if False:
            yield None
        raise RuntimeError("primary failed before output")

    def capable_fallback(*_args, **kwargs):
        fallback_called["value"] = kwargs.get("sentiq_tool_request") is TOOL_REQUEST
        yield {"kind": "tool_call_start", "id": "fallback_stream_1", "name": "web_surf", "index": 0}
        yield {"kind": "tool_argument_delta", "id": "fallback_stream_1", "text": '{"query":"latest"}', "index": 0}
        yield {"kind": "done"}

    with patch.object(adapter, "resolve_model_override", return_value=("groq", adapter.GROQ_CHAT_MODEL)), patch.object(
        adapter, "_get_round_robin_groq_keys", return_value=["test-key"]
    ), patch.object(adapter, "_select_groq_capacity_allocation", return_value=(1024, False, None, None)), patch.object(
        adapter, "_release_groq_capacity_reservation", return_value=None
    ), patch.object(adapter, "_call_groq_stream", side_effect=fail_before_output), patch.object(
        adapter, "_stream_gemini_attempt_chain", side_effect=capable_fallback
    ), patch.object(adapter, "_mark_key_unhealthy", return_value=None), patch.object(
        adapter, "SENTIQ_MODEL_TOOL_REGISTRY_ENABLED", True
    ), patch.object(adapter, "SENTIQ_GROQ_TOOL_TRANSPORT_ENABLED", True), patch.object(
        adapter, "GEMINI_KEY_RECORDS", [SimpleNamespace(key="test-key")]
    ):
        events = list(adapter.stream_llm_router(
            "Find the latest release",
            model_override=adapter.GROQ_CHAT_MODEL,
            sentiq_tool_request=TOOL_REQUEST,
            required_capabilities=["sentiq_tools_streaming"],
        ))
    assert fallback_called["value"] is True
    assert events[0]["kind"] == "tool_call_start"


def test_stream_fallback_stops_after_tool_selection():
    fallback_called = {"value": False}

    def tool_then_fail(*_args, **_kwargs):
        yield {"kind": "tool_call_start", "id": "selected_1", "name": "web_surf", "index": 0}
        raise RuntimeError("provider disconnected")

    def forbidden_fallback(*_args, **_kwargs):
        fallback_called["value"] = True
        yield "fallback"

    with patch.object(adapter, "resolve_model_override", return_value=("groq", adapter.GROQ_CHAT_MODEL)), patch.object(
        adapter, "_get_round_robin_groq_keys", return_value=["test-key"]
    ), patch.object(adapter, "_select_groq_capacity_allocation", return_value=(1024, False, None, None)), patch.object(
        adapter, "_release_groq_capacity_reservation", return_value=None
    ), patch.object(adapter, "_call_groq_stream", side_effect=tool_then_fail), patch.object(
        adapter, "_stream_gemini_attempt_chain", side_effect=forbidden_fallback
    ), patch.object(adapter, "_mark_key_unhealthy", return_value=None), patch.object(
        adapter, "SENTIQ_MODEL_TOOL_REGISTRY_ENABLED", True
    ), patch.object(adapter, "SENTIQ_GROQ_TOOL_TRANSPORT_ENABLED", True):
        stream = adapter.stream_llm_router(
            "Find the latest release",
            model_override=adapter.GROQ_CHAT_MODEL,
            sentiq_tool_request=TOOL_REQUEST,
        )
        first = next(stream)
        assert first["kind"] == "tool_call_start"
        try:
            next(stream)
        except RuntimeError as error:
            assert "provider disconnected" in str(error)
        else:
            raise AssertionError("stream must fail rather than splice providers after tool selection")
    assert fallback_called["value"] is False


def main() -> int:
    test_capabilities_and_cache_dimensions()
    test_gemini_multimodal_contents_and_hard_capabilities()
    test_groq_buffered_and_fragmented_stream_transport()
    test_gemini_buffered_and_stream_transport()
    test_capability_aware_fallbacks()
    test_stream_fallback_stops_after_tool_selection()
    print("Provider-neutral model tool transport checks passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
