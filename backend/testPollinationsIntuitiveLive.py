from __future__ import annotations

import io
import json
import os
import unittest
from contextlib import redirect_stdout
from unittest.mock import patch

import requests

import verifyPollinationsIntuitiveLive as verifier


SAFE_ENV = {
    "POLLINATIONS_OPENAI_ENDPOINT": "https://example.test/v1/chat/completions",
    "POLLINATIONS_INTUITIVE_MODEL": "verified-test-model",
    "POLLINATIONS_API_KEY": "must-not-appear-in-output",
}


class FakeResponse:
    def __init__(self, lines=None, status_code=200, error_payload=None, line_error=None):
        self.status_code = status_code
        self.lines = lines or [
            'data: {"choices":[{"delta":{"reasoning_content":"hidden"}}]}',
            'data: {"choices":[{"delta":{"content":"OK"}}]}',
            'data: {"choices":[],"usage":{"prompt_tokens":4,"completion_tokens":1,"total_tokens":5}}',
            "data: [DONE]",
        ]
        self.error_payload = error_payload or {}
        self.line_error = line_error
        self.closed = False

    def json(self):
        return self.error_payload

    def iter_lines(self, decode_unicode=True):
        if self.line_error is not None:
            raise self.line_error
        yield from self.lines

    def close(self):
        self.closed = True


def run_verifier() -> tuple[int, list[dict]]:
    output = io.StringIO()
    with redirect_stdout(output):
        status = verifier.main()
    serialized = output.getvalue()
    if SAFE_ENV["POLLINATIONS_API_KEY"] in serialized or SAFE_ENV["POLLINATIONS_OPENAI_ENDPOINT"] in serialized:
        raise AssertionError("live verifier output exposed credentials or the configured endpoint")
    return status, [json.loads(line) for line in serialized.splitlines() if line.strip()]


class PollinationsIntuitiveLiveVerifierTests(unittest.TestCase):
    def test_read_timeout_retries_once_then_requires_a_valid_response(self):
        with patch.dict(os.environ, SAFE_ENV, clear=False), patch.object(
            verifier.requests,
            "post",
            side_effect=[requests.ReadTimeout("synthetic timeout"), FakeResponse()],
        ) as post, patch.object(verifier.time, "sleep") as sleep:
            status, events = run_verifier()

        self.assertEqual(status, 0)
        self.assertEqual(post.call_count, 2)
        self.assertEqual([call.kwargs["timeout"] for call in post.call_args_list], [(10, 75), (10, 75)])
        self.assertEqual([call.kwargs["stream"] for call in post.call_args_list], [True, True])
        self.assertEqual(post.call_args.kwargs["json"]["stream"], True)
        self.assertEqual(post.call_args.kwargs["json"]["max_tokens"], 32)
        self.assertEqual(post.call_args.kwargs["json"]["reasoning_effort"], "none")
        sleep.assert_called_once_with(1.0)
        self.assertEqual(events[0]["status"], "retry")
        self.assertEqual(events[0]["category"], "transport_timeout")
        self.assertEqual(events[-1]["status"], "pass")
        self.assertEqual(events[-1]["transport"], "provider_sse")
        self.assertTrue(events[-1]["hidden_reasoning_seen"])
        self.assertFalse(events[-1]["reasoning_marker_visible"])
        self.assertEqual(events[-1]["attempts"], 2)

    def test_persistent_read_timeout_still_fails_closed(self):
        with patch.dict(os.environ, SAFE_ENV, clear=False), patch.object(
            verifier.requests,
            "post",
            side_effect=[requests.ReadTimeout("first"), requests.ReadTimeout("second")],
        ) as post, patch.object(verifier.time, "sleep"):
            status, events = run_verifier()

        self.assertEqual(status, 1)
        self.assertEqual(post.call_count, 2)
        self.assertEqual(events[-1]["status"], "fail")
        self.assertEqual(events[-1]["category"], "transport")
        self.assertEqual(events[-1]["error_class"], "ReadTimeout")
        self.assertEqual(events[-1]["attempts"], 2)

    def test_non_timeout_transport_error_is_not_retried(self):
        with patch.dict(os.environ, SAFE_ENV, clear=False), patch.object(
            verifier.requests,
            "post",
            side_effect=requests.ConnectionError("synthetic connection error"),
        ) as post, patch.object(verifier.time, "sleep") as sleep:
            status, events = run_verifier()

        self.assertEqual(status, 1)
        self.assertEqual(post.call_count, 1)
        sleep.assert_not_called()
        self.assertEqual(events[-1]["category"], "transport")
        self.assertEqual(events[-1]["attempts"], 1)

    def test_read_timeout_wrapped_during_sse_iteration_is_retried(self):
        wrapped_timeout = requests.ConnectionError(requests.ReadTimeout("synthetic stream timeout"))
        first_response = FakeResponse(line_error=wrapped_timeout)
        second_response = FakeResponse()
        with patch.dict(os.environ, SAFE_ENV, clear=False), patch.object(
            verifier.requests,
            "post",
            side_effect=[first_response, second_response],
        ) as post, patch.object(verifier.time, "sleep") as sleep:
            status, events = run_verifier()

        self.assertEqual(status, 0)
        self.assertEqual(post.call_count, 2)
        self.assertTrue(first_response.closed)
        self.assertTrue(second_response.closed)
        sleep.assert_called_once_with(1.0)
        self.assertEqual(events[0]["category"], "transport_timeout")
        self.assertEqual(events[-1]["status"], "pass")
        self.assertEqual(events[-1]["attempts"], 2)

    def test_visible_reasoning_marker_fails_closed(self):
        response = FakeResponse(lines=[
            'data: {"choices":[{"delta":{"content":"<think>hidden"}}]}',
            "data: [DONE]",
        ])
        with patch.dict(os.environ, SAFE_ENV, clear=False), patch.object(
            verifier.requests,
            "post",
            return_value=response,
        ):
            status, events = run_verifier()

        self.assertEqual(status, 1)
        self.assertEqual(events[-1]["status"], "fail")
        self.assertTrue(events[-1]["reasoning_marker_visible"])
        self.assertTrue(response.closed)

    def test_http_failure_is_not_retried_and_exposes_only_safe_error_code(self):
        response = FakeResponse(
            status_code=401,
            error_payload={"error": {"code": "invalid_api_key", "message": SAFE_ENV["POLLINATIONS_API_KEY"]}},
        )
        with patch.dict(os.environ, SAFE_ENV, clear=False), patch.object(
            verifier.requests,
            "post",
            return_value=response,
        ) as post:
            status, events = run_verifier()

        self.assertEqual(status, 1)
        self.assertEqual(post.call_count, 1)
        self.assertEqual(events[-1]["category"], "http")
        self.assertEqual(events[-1]["status_code"], 401)
        self.assertEqual(events[-1]["error_code"], "invalid_api_key")
        self.assertTrue(response.closed)


if __name__ == "__main__":
    unittest.main(verbosity=2)
