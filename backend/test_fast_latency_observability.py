import contextlib
import io
import json
import os
import sys

os.environ["SENTIQ_FAST_LATENCY_OBSERVABILITY_ENABLED"] = "true"
sys.path.insert(0, os.path.dirname(__file__))

import httpx

import fast_latency_observability as observability


def parse_logs(buffer: io.StringIO) -> list[dict]:
    output = []
    for line in buffer.getvalue().splitlines():
        try:
            output.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return output


def main() -> None:
    assert observability._safe_trace_id("11111111-2222-4333-8444-555555555555")
    assert not observability._safe_trace_id("bad trace with spaces")
    assert observability._line_has_visible_delta(
        'data: {"choices":[{"delta":{"content":"Hello"}}]}'
    )
    assert not observability._line_has_visible_delta(
        'data: {"choices":[{"delta":{"reasoning":"thinking"}}]}'
    )

    trace_id = "11111111-2222-4333-8444-555555555555"

    class TestStream(httpx.SyncByteStream):
        def __iter__(self):
            yield b'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n'
            yield b'data: [DONE]\n\n'

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, request=request, stream=TestStream())

    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        observability.install()
        with observability.latency_trace_context(trace_id):
            with httpx.Client(transport=httpx.MockTransport(handler)) as client:
                request = client.build_request(
                    "POST",
                    "https://api.groq.com/openai/v1/chat/completions",
                    json={"model": "openai/gpt-oss-120b", "stream": True},
                )
                response = client.send(request, stream=True)
                list(response.iter_lines())

    logs = parse_logs(output)
    phases = {item.get("phase") for item in logs}
    required = {
        "python.provider_request_started",
        "python.provider_response_headers_received",
        "python.provider_first_sse_event",
        "python.provider_first_visible_delta",
    }
    assert required.issubset(phases), (required - phases, logs)
    for item in logs:
        assert "prompt" not in item
        assert "response" not in item
        assert "content" not in item

    print("Fast latency Python observability test passed.")


if __name__ == "__main__":
    main()
