import sys
from collections.abc import Generator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from fastapi.testclient import TestClient

_ROOT = Path(__file__).resolve().parents[1]
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from backend import llm_service


TEST_TOKEN = "safety-timeout-test-token"
TOKEN_HEADER = {"X-SentIQ-Internal-Token": TEST_TOKEN}


def assert_true(condition: bool, label: str) -> None:
    if not condition:
        raise AssertionError(label)
    print(f"PASS | {label}")


@contextmanager
def patched_gateway(
    *,
    input_classification: str = llm_service.SafetyResult.SAFE,
    output_classification: str | None = None,
) -> Generator[dict[str, list[Any]], None, None]:
    original_token = llm_service.INTERNAL_SERVICE_TOKEN
    original_unsafe = llm_service.UNSAFE_INTERNAL_ENDPOINTS_ENABLED
    original_call_safety_model = llm_service.call_safety_model
    original_call_llm_router = llm_service.call_llm_router
    original_stream_llm_router = llm_service.stream_llm_router
    original_log_safety_event = llm_service.log_safety_event

    events: list[dict[str, str]] = []
    safety_calls: list[dict[str, Any]] = []

    def fake_safety_model(text: str, *_, check_type: str = "input", **kwargs: Any) -> tuple[str, str]:
        safety_calls.append({"text": text, "check_type": check_type, **kwargs})
        if check_type == "output":
            return output_classification or llm_service.SafetyResult.SAFE, "synthetic-output"
        return input_classification, "synthetic-input"

    def fake_llm_router(*_, **__) -> dict[str, object]:
        return {
            "text": "Cloudflare is a web infrastructure and security company.",
            "model_used": "test-model",
            "fallback": False,
            "fallback_reason": None,
            "finish_reason": None,
            "truncated": False,
            "error": None,
            "error_detail": None,
        }

    def fake_stream_router(*_, **__):
        yield "Cloudflare is a web infrastructure and security company."

    def capture_safety_event(event_name: str, **kwargs: Any) -> None:
        events.append({"event": event_name, **{k: str(v) for k, v in kwargs.items()}})

    llm_service.INTERNAL_SERVICE_TOKEN = TEST_TOKEN
    llm_service.UNSAFE_INTERNAL_ENDPOINTS_ENABLED = False
    llm_service.call_safety_model = fake_safety_model
    llm_service.call_llm_router = fake_llm_router
    llm_service.stream_llm_router = fake_stream_router
    llm_service.log_safety_event = capture_safety_event

    ctx: dict[str, list[Any]] = {"events": events, "safety_calls": safety_calls}

    try:
        yield ctx
    finally:
        llm_service.INTERNAL_SERVICE_TOKEN = original_token
        llm_service.UNSAFE_INTERNAL_ENDPOINTS_ENABLED = original_unsafe
        llm_service.call_safety_model = original_call_safety_model
        llm_service.call_llm_router = original_call_llm_router
        llm_service.stream_llm_router = original_stream_llm_router
        llm_service.log_safety_event = original_log_safety_event


def post_invoke(client: TestClient, *, task: str, safety_mode: str | None = None):
    payload = {
        "prompt": "Do you know about Cloudflare?",
        "task": task,
        "user_id": "guest",
    }
    if safety_mode:
        payload["safety_mode"] = safety_mode
    return client.post("/llm/invoke", headers=TOKEN_HEADER, json=payload)


def post_stream(client: TestClient, *, safety_mode: str | None = None):
    payload = {
        "prompt": "Do you know about Cloudflare?",
        "task": "chat",
        "user_id": "guest",
    }
    if safety_mode:
        payload["safety_mode"] = safety_mode
    return client.post("/llm/stream", headers=TOKEN_HEADER, json=payload)


def main() -> None:
    with TestClient(llm_service.app) as client:
        # 1. Normal chat invoke with SAFE does not invoke safety model
        with patched_gateway(input_classification=llm_service.SafetyResult.SAFE) as ctx:
            response = post_invoke(client, task="chat", safety_mode=llm_service.SAFETY_MODE_LOW_RISK_TEXT)
            assert_true(response.status_code == 200, "normal chat invoke succeeds")
            assert_true("Cloudflare" in response.json()["result"]["text"], "normal chat returns model text")
            assert_true(len(ctx["safety_calls"]) == 0, "normal chat invoke does not call safety model")

        # 2. Normal chat invoke with synthetic TIMEOUT does not invoke safety model
        with patched_gateway(input_classification=llm_service.SafetyResult.TIMEOUT) as ctx:
            response = post_invoke(client, task="chat", safety_mode=llm_service.SAFETY_MODE_LOW_RISK_TEXT)
            assert_true(response.status_code == 200, "chat invoke succeeds without safety timeout block")
            assert_true(len(ctx["safety_calls"]) == 0, "chat invoke bypasses safety call on timeout")

        # 3. Normal chat invoke with synthetic UNSAFE does not invoke safety model
        with patched_gateway(input_classification=llm_service.SafetyResult.UNSAFE) as ctx:
            response = post_invoke(client, task="chat", safety_mode=llm_service.SAFETY_MODE_LOW_RISK_TEXT)
            assert_true(response.status_code == 200, "chat invoke proceeds directly without safety check")
            assert_true(len(ctx["safety_calls"]) == 0, "chat invoke does not invoke safety model")

        # 4. Specialized tasks proceed without safety calls
        for task in ["file_generate", "memory_classify", "web_search_synthesis", "image_generate"]:
            with patched_gateway(input_classification=llm_service.SafetyResult.UNSAFE) as ctx:
                response = post_invoke(client, task=task)
                assert_true(response.status_code == 200, f"{task} invoke succeeds directly")
                assert_true(len(ctx["safety_calls"]) == 0, f"{task} does not invoke safety model")

        # 5. Streaming does not execute input safety, StreamingSafetyMonitor, or output safety
        with patched_gateway(
            input_classification=llm_service.SafetyResult.UNSAFE,
            output_classification=llm_service.SafetyResult.UNSAFE,
        ) as ctx:
            response = post_stream(client, safety_mode=llm_service.SAFETY_MODE_LOW_RISK_TEXT)
            text = response.text
            assert_true(response.status_code == 200, "streaming chat starts normally")
            assert_true("Cloudflare" in text, "streaming chat emits normal text")
            assert_true("Response blocked due to safety concerns" not in text, "output safety does not block stream")
            assert_true("data: [DONE]" in text, "stream completes normally with [DONE]")
            assert_true(len(ctx["safety_calls"]) == 0, "stream does not call safety model")

        # 6. Retained helper function contracts remain intact when called directly
        with patched_gateway(input_classification=llm_service.SafetyResult.UNSAFE) as ctx:
            safe, classification, _ = llm_service.check_input_safety(
                "harmful text",
                "guest",
                "/direct_check",
            )
            assert_true(not safe, "retained check_input_safety helper detects unsafe text")
            assert_true(len(ctx["safety_calls"]) == 1, "retained helper executes underlying model when invoked directly")

    print("\nSafety timeout policy validation passed.")


if __name__ == "__main__":
    main()
