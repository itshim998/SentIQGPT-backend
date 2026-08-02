"""Redacted live verification for the Pollinations Intuitive fallback.

The production fallback uses provider SSE, so this verifier exercises the same
transport. It prints only status, response size, marker checks, and aggregate
usage. It never prints the API key, prompt, answer text, headers, endpoint, or
raw response body.
"""

from __future__ import annotations

import json
import os
import sys
import time
from typing import Any

import requests


PROMPT = "Reply with the single word OK."
FORBIDDEN_MARKERS = ("reasoning_content", "<think>", "</think>")
MAX_ATTEMPTS = 2
REQUEST_TIMEOUT_SECONDS = 75
CONNECT_TIMEOUT_SECONDS = 10
RETRY_BACKOFF_SECONDS = 1.0


def _safe_error_code(response: requests.Response) -> str | None:
    try:
        payload = response.json()
    except ValueError:
        return None
    if not isinstance(payload, dict):
        return None
    error = payload.get("error")
    if not isinstance(error, dict):
        return None
    code = error.get("code")
    return str(code)[:80] if isinstance(code, (str, int)) else None


def _safe_usage(payload: dict[str, Any]) -> dict[str, int | None]:
    usage = payload.get("usage") if isinstance(payload.get("usage"), dict) else {}
    return {
        "input_tokens": usage.get("prompt_tokens", usage.get("input_tokens")),
        "output_tokens": usage.get("completion_tokens", usage.get("output_tokens")),
        "total_tokens": usage.get("total_tokens"),
    }


def _visible_text(value: Any) -> str:
    if isinstance(value, str):
        return value
    if not isinstance(value, list):
        return ""
    parts: list[str] = []
    for item in value:
        if isinstance(item, dict) and isinstance(item.get("text"), str):
            parts.append(item["text"])
    return "".join(parts)


def _consume_stream(response: requests.Response) -> dict[str, Any]:
    visible_parts: list[str] = []
    usage: dict[str, int | None] = {
        "input_tokens": None,
        "output_tokens": None,
        "total_tokens": None,
    }
    hidden_reasoning_seen = False
    saw_done = False
    malformed_events = 0

    for raw_line in response.iter_lines(decode_unicode=True):
        line = raw_line.decode("utf8", errors="replace") if isinstance(raw_line, bytes) else str(raw_line or "")
        line = line.strip()
        if not line or line.startswith(":") or not line.startswith("data:"):
            continue
        data = line[5:].strip()
        if data == "[DONE]":
            saw_done = True
            break
        try:
            event = json.loads(data)
        except ValueError:
            malformed_events += 1
            continue
        if not isinstance(event, dict):
            malformed_events += 1
            continue

        candidate_usage = _safe_usage(event)
        if any(value is not None for value in candidate_usage.values()):
            usage = candidate_usage

        choices = event.get("choices")
        choice = choices[0] if isinstance(choices, list) and choices and isinstance(choices[0], dict) else None
        if not isinstance(choice, dict):
            continue
        message = choice.get("delta") if isinstance(choice.get("delta"), dict) else choice.get("message")
        if not isinstance(message, dict):
            continue
        hidden_reasoning_seen = hidden_reasoning_seen or bool(message.get("reasoning_content"))
        text = _visible_text(message.get("content"))
        if text:
            visible_parts.append(text)

    visible_text = "".join(visible_parts)
    marker_visible = any(marker in visible_text.lower() for marker in FORBIDDEN_MARKERS)
    return {
        "category": "stream",
        "status_code": response.status_code,
        "visible_chars": len(visible_text),
        "reasoning_marker_visible": marker_visible,
        "hidden_reasoning_seen": hidden_reasoning_seen,
        "usage": usage,
        "saw_done": saw_done,
        "malformed_events": malformed_events,
        "passed": bool(visible_text.strip()) and not marker_visible,
    }


def _run_attempt(
    endpoint: str,
    headers: dict[str, str],
    payload: dict[str, Any],
) -> dict[str, Any]:
    response = requests.post(
        endpoint,
        headers=headers,
        json=payload,
        stream=True,
        timeout=(CONNECT_TIMEOUT_SECONDS, REQUEST_TIMEOUT_SECONDS),
    )
    try:
        if response.status_code < 200 or response.status_code >= 300:
            return {
                "category": "http",
                "status_code": response.status_code,
                "error_code": _safe_error_code(response),
                "passed": False,
            }
        return _consume_stream(response)
    finally:
        response.close()


def _is_timeout_error(error: requests.RequestException) -> bool:
    if isinstance(error, requests.Timeout):
        return True
    pending: list[BaseException] = [error]
    seen: set[int] = set()
    while pending:
        current = pending.pop()
        if id(current) in seen:
            continue
        seen.add(id(current))
        if isinstance(current, requests.Timeout) or type(current).__name__ in {"ReadTimeoutError", "TimeoutError"}:
            return True
        pending.extend(argument for argument in current.args if isinstance(argument, BaseException))
        if isinstance(current.__cause__, BaseException):
            pending.append(current.__cause__)
        if isinstance(current.__context__, BaseException):
            pending.append(current.__context__)
    return False


def _request_verification(
    endpoint: str,
    headers: dict[str, str],
    payload: dict[str, Any],
) -> tuple[dict[str, Any] | None, int, requests.RequestException | None]:
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            return _run_attempt(endpoint, headers, payload), attempt, None
        except requests.RequestException as error:
            if _is_timeout_error(error) and attempt < MAX_ATTEMPTS:
                print(json.dumps({
                    "event": "pollinations_intuitive_verification_attempt",
                    "status": "retry",
                    "category": "transport_timeout",
                    "error_class": type(error).__name__,
                    "attempt": attempt,
                }))
                time.sleep(RETRY_BACKOFF_SECONDS)
                continue
            return None, attempt, error
    raise AssertionError("Pollinations verification attempt loop exhausted unexpectedly")


def main() -> int:
    endpoint = os.getenv(
        "POLLINATIONS_OPENAI_ENDPOINT",
        "https://gen.pollinations.ai/v1/chat/completions",
    ).strip()
    model = os.getenv("POLLINATIONS_INTUITIVE_MODEL", "").strip()
    api_key = os.getenv("POLLINATIONS_API_KEY", "").strip()

    if not endpoint.startswith("https://") or not model:
        print(json.dumps({
            "event": "pollinations_intuitive_verification",
            "status": "fail",
            "category": "configuration",
        }))
        return 2

    headers = {"Content-Type": "application/json"}
    if api_key:
        headers["Authorization"] = f"Bearer {api_key}"

    result, attempts, request_error = _request_verification(
        endpoint,
        headers,
        {
            "model": model,
            "messages": [{"role": "user", "content": PROMPT}],
            "max_tokens": 32,
            "stream": True,
            "reasoning_effort": "none",
        },
    )
    if request_error is not None or result is None:
        print(json.dumps({
            "event": "pollinations_intuitive_verification",
            "status": "fail",
            "category": "transport",
            "error_class": type(request_error).__name__ if request_error is not None else "RequestException",
            "attempts": attempts,
        }))
        return 1

    if result.get("category") == "http":
        print(json.dumps({
            "event": "pollinations_intuitive_verification",
            "status": "fail",
            "category": "http",
            "status_code": result.get("status_code"),
            "error_code": result.get("error_code"),
            "attempts": attempts,
        }))
        return 1

    passed = bool(result.get("passed"))

    print(json.dumps({
        "event": "pollinations_intuitive_verification",
        "status": "pass" if passed else "fail",
        "transport": "provider_sse",
        "status_code": result.get("status_code"),
        "visible_chars": result.get("visible_chars", 0),
        "reasoning_marker_visible": bool(result.get("reasoning_marker_visible")),
        "hidden_reasoning_seen": bool(result.get("hidden_reasoning_seen")),
        "usage": result.get("usage", _safe_usage({})),
        "saw_done": bool(result.get("saw_done")),
        "malformed_events": int(result.get("malformed_events", 0)),
        "attempts": attempts,
    }))
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
