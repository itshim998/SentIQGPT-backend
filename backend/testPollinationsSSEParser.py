import os
import sys

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PARENT_DIR = os.path.dirname(BASE_DIR)
sys.path.insert(0, PARENT_DIR)

import llm_adapter  # noqa: E402
from llm_adapter import _call_pollinations_stream, _parse_pollinations_sse_event  # noqa: E402


def assert_equal(actual, expected, label: str) -> None:
    if actual != expected:
        raise AssertionError(f"{label}: expected {expected!r}, got {actual!r}")


def main() -> None:
    cases = [
        ("blank", "", {"kind": "skip"}),
        ("non_data", "event: message", {"kind": "skip"}),
        ("done", "data: [DONE]", {"kind": "done"}),
        (
            "empty_role_delta",
            'data: {"choices":[{"delta":{"role":"assistant","content":""}}]}',
            {"kind": "chunk", "text": "", "finish_reason": None},
        ),
        (
            "text_delta",
            'data: {"choices":[{"delta":{"content":"hello"}}]}',
            {"kind": "chunk", "text": "hello", "finish_reason": None},
        ),
        (
            "leading_space_delta",
            'data: {"choices":[{"delta":{"content":" hello"}}]}',
            {"kind": "chunk", "text": " hello", "finish_reason": None},
        ),
        (
            "newline_only_delta",
            'data: {"choices":[{"delta":{"content":"\\n"}}]}',
            {"kind": "chunk", "text": "\n", "finish_reason": None},
        ),
        (
            "indentation_delta",
            'data: {"choices":[{"delta":{"content":"    "}}]}',
            {"kind": "chunk", "text": "    ", "finish_reason": None},
        ),
        (
            "mixed_whitespace_delta",
            'data: {"choices":[{"delta":{"content":"\\n  const answer = 42;"}}]}',
            {"kind": "chunk", "text": "\n  const answer = 42;", "finish_reason": None},
        ),
        (
            "finish_reason_chunk",
            'data: {"choices":[{"delta":{"content":""},"finish_reason":"stop"}]}',
            {"kind": "chunk", "text": "", "finish_reason": "stop"},
        ),
        (
            "usage_chunk",
            'data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}',
            {"kind": "chunk", "text": "", "finish_reason": None},
        ),
        (
            "malformed_json",
            'data: {"choices":',
            {"kind": "malformed"},
        ),
    ]

    for name, line, expected in cases:
        parsed = _parse_pollinations_sse_event(line)
        assert_equal(parsed["kind"], expected["kind"], f"{name}.kind")
        if "text" in expected:
            assert_equal(parsed.get("text"), expected["text"], f"{name}.text")
        if "finish_reason" in expected:
            assert_equal(parsed.get("finish_reason"), expected["finish_reason"], f"{name}.finish_reason")

    captured_payloads = []

    class FakeBucket:
        def consume(self) -> bool:
            return True

    class FakeResponse:
        status_code = 200

        def iter_lines(self, decode_unicode=True):
            yield 'data: {"choices":[{"delta":{"content":"hello"}}]}'
            yield "data: [DONE]"

        def close(self) -> None:
            pass

    def fake_post_pollinations(payload, headers, *, timeout=None, stream=False):
        captured_payloads.append(payload)
        return "https://example.test/v1/chat/completions", FakeResponse()

    original_bucket = llm_adapter.pollinations_bucket
    original_post = llm_adapter._post_pollinations
    try:
        llm_adapter.pollinations_bucket = FakeBucket()
        llm_adapter._post_pollinations = fake_post_pollinations
        chunks = list(_call_pollinations_stream("solve x", "openai-large", max_output_tokens=4321))
    finally:
        llm_adapter.pollinations_bucket = original_bucket
        llm_adapter._post_pollinations = original_post

    assert_equal(chunks, ["hello"], "stream.max_tokens.chunks")
    assert_equal(captured_payloads[0].get("stream"), True, "stream.max_tokens.stream_flag")
    assert_equal(captured_payloads[0].get("max_tokens"), 4321, "stream.max_tokens.forwarded")

    print("Pollinations SSE parser tests passed.")


if __name__ == "__main__":
    main()
