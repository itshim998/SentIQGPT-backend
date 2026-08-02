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
    status_code = 200

    def json(self):
        return {
            "choices": [{"message": {"content": "OK"}}],
            "usage": {"prompt_tokens": 4, "completion_tokens": 1, "total_tokens": 5},
        }


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
        self.assertEqual([call.kwargs["timeout"] for call in post.call_args_list], [75, 75])
        sleep.assert_called_once_with(1.0)
        self.assertEqual(events[0]["status"], "retry")
        self.assertEqual(events[0]["category"], "transport_timeout")
        self.assertEqual(events[-1]["status"], "pass")
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


if __name__ == "__main__":
    unittest.main(verbosity=2)
