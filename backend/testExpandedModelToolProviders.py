import json
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import llm_adapter as adapter
from backend.nvidia_nemotron import (
    NvidiaKeyPool,
    NvidiaKeyRecord,
    NvidiaNemotronProvider,
    NvidiaProviderSettings,
)

TOOL_REQUEST = {
    "registry_version": "2026-08-paid-image-text-routing-v1",
    "allowed_tool_fingerprint": "image-only",
    "tool_choice_policy": "Call image_gen for this explicit image request.",
    "allowed_tool_names": ["image_gen"],
    "availability_context": {"authenticated": True, "executionMode": "fast"},
    "tools": [{
        "name": "image_gen",
        "description": "Generate an image and classify text rendering.",
        "input_schema": {
            "type": "object",
            "additionalProperties": False,
            "properties": {
                "prompt": {"type": "string"},
                "requires_text_rendering": {"type": "boolean"},
            },
            "required": ["prompt", "requires_text_rendering"],
        },
    }],
}


def test_pollinations_buffered_tool_payload_and_response():
    payload = adapter._build_pollinations_payload(
        "Create a poster reading Welcome",
        "mistral",
        0.1,
        200,
        None,
        TOOL_REQUEST,
    )
    assert payload["tool_choice"] == "auto"
    assert payload["parallel_tool_calls"] is False
    assert payload["tools"][0]["function"]["name"] == "image_gen"
    assert payload["messages"][0]["role"] == "system"

    response = SimpleNamespace(
        json=lambda: {
            "choices": [{
                "finish_reason": "tool_calls",
                "message": {
                    "content": None,
                    "tool_calls": [{
                        "id": "poll_1",
                        "type": "function",
                        "function": {
                            "name": "image_gen",
                            "arguments": json.dumps({
                                "prompt": "Create a poster reading Welcome",
                                "requires_text_rendering": True,
                            }),
                        },
                    }],
                },
            }],
        },
        text="",
    )
    turn, finish = adapter._extract_pollinations_response(response, TOOL_REQUEST)
    assert finish == "tool_calls"
    assert turn["kind"] == "tool_calls"
    assert turn["calls"][0]["name"] == "image_gen"


def test_pollinations_stream_tool_fragments():
    first = adapter._parse_pollinations_sse_event("data: " + json.dumps({
        "choices": [{"delta": {"tool_calls": [{
            "index": 0,
            "id": "poll_stream_1",
            "function": {"name": "image_gen", "arguments": '{"prompt":"poster",'},
        }]}}],
    }))
    second = adapter._parse_pollinations_sse_event("data: " + json.dumps({
        "choices": [{"finish_reason": "tool_calls", "delta": {"tool_calls": [{
            "index": 0,
            "function": {"arguments": '"requires_text_rendering":true}'},
        }]}}],
    }))
    assert first["tool_calls"][0]["function"]["name"] == "image_gen"
    assert second["finish_reason"] == "tool_calls"


class FakeResponse:
    status_code = 200
    headers = {}

    def __init__(self, events):
        self.events = events

    def iter_lines(self, decode_unicode=True):
        for event in self.events:
            yield "data: " + json.dumps(event)
        yield "data: [DONE]"

    def close(self):
        pass


def test_nvidia_native_tool_transport():
    events = [
        {"choices": [{"delta": {"tool_calls": [{
            "index": 0,
            "id": "nvidia_1",
            "function": {"name": "image_gen", "arguments": '{"prompt":"poster",'},
        }]}}]},
        {"choices": [{"finish_reason": "tool_calls", "delta": {"tool_calls": [{
            "index": 0,
            "function": {"arguments": '"requires_text_rendering":true}'},
        }]}}]},
        {"choices": [], "usage": {"prompt_tokens": 10, "completion_tokens": 8, "total_tokens": 18}},
    ]
    requests = []

    def fake_request(*args, **kwargs):
        requests.append(kwargs)
        return FakeResponse(events)

    provider = NvidiaNemotronProvider(
        NvidiaProviderSettings(enabled=True),
        NvidiaKeyPool([NvidiaKeyRecord(index=1, env_name="NVIDIA_API_KEY_1", key="secret")]),
        request=fake_request,
    )
    turn, usage, slot = provider.complete(
        "Create a poster",
        max_tokens=200,
        reasoning_budget=0,
        sentiq_tool_request=TOOL_REQUEST,
    )
    assert turn["kind"] == "tool_calls"
    assert turn["calls"][0]["name"] == "image_gen"
    assert json.loads(turn["calls"][0]["arguments"])["requires_text_rendering"] is True
    assert usage.total_tokens >= 18
    assert slot == "nvidia-slot-1"
    assert requests[0]["json"]["tool_choice"] == "auto"
    assert requests[0]["json"]["tools"][0]["function"]["name"] == "image_gen"


if __name__ == "__main__":
    with patch.object(adapter, "SENTIQ_MODEL_TOOL_REGISTRY_ENABLED", True), patch.object(
        adapter, "SENTIQ_POLLINATIONS_TOOL_TRANSPORT_ENABLED", True
    ), patch.dict("os.environ", {
        "SENTIQ_NVIDIA_PROVIDER_ENABLED": "true",
        "SENTIQ_NEMOTRON_INTUITIVE_ENABLED": "true",
    }):
        assert adapter.get_sentiq_tool_capability("pollinations", "mistral", True)["supported"] is True
        assert adapter.get_sentiq_tool_capability("nvidia", adapter.NVIDIA_NEMOTRON_MODEL, True)["supported"] is True
    test_pollinations_buffered_tool_payload_and_response()
    test_pollinations_stream_tool_fragments()
    test_nvidia_native_tool_transport()
    print("Expanded Pollinations and Nvidia tool transport checks passed.")
