from contextlib import contextmanager
from typing import Iterator

from fastapi.testclient import TestClient

import llm_service


TEST_TOKEN = "safety-timeout-test-token"
TOKEN_HEADER = {"X-SentIQ-Internal-Token": TEST_TOKEN}


def assert_true(condition: bool, label: str) -> None:
    if not condition:
        raise AssertionError(label)
    print(f"PASS | {label}")


@contextmanager
def patched_gateway(
    *,
    input_classification: str,
    output_classification: str | None = None,
) -> Iterator[list[dict[str, str]]]:
    original_token = llm_service.INTERNAL_SERVICE_TOKEN
    original_unsafe = llm_service.UNSAFE_INTERNAL_ENDPOINTS_ENABLED
    original_call_safety_model = llm_service.call_safety_model
    original_call_llm_router = llm_service.call_llm_router
    original_stream_llm_router = llm_service.stream_llm_router
    original_log_safety_event = llm_service.log_safety_event

    events: list[dict[str, str]] = []

    def fake_safety_model(_text: str, *_, check_type: str = "input", **__) -> tuple[str, str]:
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

    def capture_safety_event(event_name: str, **kwargs: str) -> None:
        events.append({"event": event_name, **{k: str(v) for k, v in kwargs.items()}})

    llm_service.INTERNAL_SERVICE_TOKEN = TEST_TOKEN
    llm_service.UNSAFE_INTERNAL_ENDPOINTS_ENABLED = False
    llm_service.call_safety_model = fake_safety_model
    llm_service.call_llm_router = fake_llm_router
    llm_service.stream_llm_router = fake_stream_router
    llm_service.log_safety_event = capture_safety_event

    try:
        yield events
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
        with patched_gateway(input_classification=llm_service.SafetyResult.SAFE):
            response = post_invoke(client, task="chat", safety_mode=llm_service.SAFETY_MODE_LOW_RISK_TEXT)
            assert_true(response.status_code == 200, "normal chat safety SAFE succeeds")
            assert_true("Cloudflare" in response.json()["result"]["text"], "normal chat returns model text")

        with patched_gateway(input_classification=llm_service.SafetyResult.TIMEOUT) as events:
            response = post_invoke(client, task="chat", safety_mode=llm_service.SAFETY_MODE_LOW_RISK_TEXT)
            assert_true(response.status_code == 200, "normal chat safety TIMEOUT succeeds degraded")
            assert_true(
                any(event["event"] == "safety.input.timeout.allow_degraded" for event in events),
                "normal chat timeout emits degraded-open safety event",
            )

        with patched_gateway(input_classification=llm_service.SafetyResult.UNSAFE) as events:
            response = post_invoke(client, task="chat", safety_mode=llm_service.SAFETY_MODE_LOW_RISK_TEXT)
            assert_true(response.status_code == 400, "normal chat safety UNSAFE blocks")
            assert_true(response.json()["detail"]["reason"] == "safety_violation", "unsafe block keeps violation reason")
            assert_true(
                any(event["event"] == "safety.input.blocked.explicit" for event in events),
                "unsafe input emits explicit blocked safety event",
            )

        for task in ["file_generate", "memory_classify", "web_search_synthesis", "image_generate"]:
            with patched_gateway(input_classification=llm_service.SafetyResult.TIMEOUT):
                response = post_invoke(client, task=task)
                assert_true(response.status_code == 400, f"{task} safety TIMEOUT remains fail-closed")
                assert_true(response.json()["detail"]["reason"] == "safety_degraded", f"{task} timeout uses degraded reason")

        with patched_gateway(
            input_classification=llm_service.SafetyResult.SAFE,
            output_classification=llm_service.SafetyResult.TIMEOUT,
        ) as events:
            response = post_stream(client, safety_mode=llm_service.SAFETY_MODE_LOW_RISK_TEXT)
            text = response.text
            assert_true(response.status_code == 200, "streaming chat starts normally")
            assert_true("Cloudflare" in text, "streaming chat emits normal text")
            assert_true("Response blocked due to safety concerns" not in text, "output safety TIMEOUT does not emit generic safety failure")
            assert_true("data: [DONE]" in text, "output safety TIMEOUT completes stream")
            assert_true(
                any(event["event"] == "safety.output.timeout.degraded" for event in events),
                "output timeout emits degraded output safety event",
            )

    print("\nSafety timeout policy validation passed.")


if __name__ == "__main__":
    main()
