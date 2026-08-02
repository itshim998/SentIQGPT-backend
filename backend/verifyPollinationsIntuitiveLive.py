"""Redacted live verification for the Pollinations Intuitive fallback.

The script prints only status, response size, marker checks, and aggregate usage.
It never prints the API key, prompt, answer text, headers, or raw response body.
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


def _request_completion(
    endpoint: str,
    headers: dict[str, str],
    payload: dict[str, Any],
) -> tuple[requests.Response | None, int, requests.RequestException | None]:
    for attempt in range(1, MAX_ATTEMPTS + 1):
        try:
            return requests.post(
                endpoint,
                headers=headers,
                json=payload,
                timeout=REQUEST_TIMEOUT_SECONDS,
            ), attempt, None
        except requests.Timeout as error:
            if attempt >= MAX_ATTEMPTS:
                return None, attempt, error
            print(json.dumps({
                "event": "pollinations_intuitive_verification_attempt",
                "status": "retry",
                "category": "transport_timeout",
                "error_class": type(error).__name__,
                "attempt": attempt,
            }))
            time.sleep(RETRY_BACKOFF_SECONDS)
        except requests.RequestException as error:
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

    response, attempts, request_error = _request_completion(
        endpoint,
        headers,
        {
            "model": model,
            "messages": [{"role": "user", "content": PROMPT}],
            "max_tokens": 32,
            "stream": False,
        },
    )
    if request_error is not None or response is None:
        print(json.dumps({
            "event": "pollinations_intuitive_verification",
            "status": "fail",
            "category": "transport",
            "error_class": type(request_error).__name__ if request_error is not None else "RequestException",
            "attempts": attempts,
        }))
        return 1

    if response.status_code < 200 or response.status_code >= 300:
        print(json.dumps({
            "event": "pollinations_intuitive_verification",
            "status": "fail",
            "category": "http",
            "status_code": response.status_code,
            "error_code": _safe_error_code(response),
            "attempts": attempts,
        }))
        return 1

    try:
        payload = response.json()
    except ValueError:
        print(json.dumps({
            "event": "pollinations_intuitive_verification",
            "status": "fail",
            "category": "invalid_json",
            "status_code": response.status_code,
            "attempts": attempts,
        }))
        return 1

    choices = payload.get("choices") if isinstance(payload, dict) else None
    message = choices[0].get("message") if isinstance(choices, list) and choices and isinstance(choices[0], dict) else None
    text = message.get("content", "") if isinstance(message, dict) else ""
    normalized = str(text).lower()
    marker_visible = any(marker in normalized for marker in FORBIDDEN_MARKERS)
    passed = bool(str(text).strip()) and not marker_visible

    print(json.dumps({
        "event": "pollinations_intuitive_verification",
        "status": "pass" if passed else "fail",
        "status_code": response.status_code,
        "visible_chars": len(str(text)),
        "reasoning_marker_visible": marker_visible,
        "usage": _safe_usage(payload if isinstance(payload, dict) else {}),
        "attempts": attempts,
    }))
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
