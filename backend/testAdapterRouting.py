import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import llm_adapter as adapter
from llm_adapter import (
    CODING_MODEL,
    GROQ_CHAT_MODEL,
    SEARCH_MODEL,
    _cache_key,
    _normalize_gpt_oss_reasoning_effort,
    resolve_model_override,
)


CASES = [
    ("qwen-coder", "gemini", ("pollinations", CODING_MODEL)),
    ("qwen3-coder", "gemini", ("pollinations", CODING_MODEL)),
    ("qwen3-coder-30b", "gemini", ("pollinations", CODING_MODEL)),
    ("gemini-search", "gemini", ("pollinations", SEARCH_MODEL)),
    ("gpt-oss-120b", "gemini", ("groq", GROQ_CHAT_MODEL)),
    ("openai-large", "gemini", ("pollinations", "openai-large")),
]


def main() -> int:
    failures = 0
    for logical_name, default_provider, expected in CASES:
        resolved = resolve_model_override(logical_name, default_provider)
        ok = resolved == expected
        print(
            f"{'PASS' if ok else 'FAIL'} | override={logical_name} default={default_provider} "
            f"resolved={resolved} expected={expected}"
        )
        if not ok:
            failures += 1

    EFFORT_CASES = [
        ("low", "low"),
        ("medium", "medium"),
        ("LOW", "low"),
        ("high", "medium"),
        (None, "medium"),
    ]
    for raw_effort, expected in EFFORT_CASES:
        resolved_effort = _normalize_gpt_oss_reasoning_effort(raw_effort)
        ok = resolved_effort == expected
        print(
            f"{'PASS' if ok else 'FAIL'} | reasoning_effort={raw_effort} "
            f"resolved={resolved_effort} expected={expected}"
        )
        if not ok:
            failures += 1

    low_key = _cache_key(
        "hello",
        "chat",
        GROQ_CHAT_MODEL,
        "groq",
        reasoning_effort="low",
    )
    medium_key = _cache_key(
        "hello",
        "chat",
        GROQ_CHAT_MODEL,
        "groq",
        reasoning_effort="medium",
    )
    if low_key != medium_key:
        print("PASS | cache key separates low and medium reasoning effort")
    else:
        print("FAIL | cache key should separate low and medium reasoning effort")
        failures += 1

    class FakeMessage:
        content = "ok"

    class FakeDelta:
        content = "stream-ok"

    class FakeChoice:
        message = FakeMessage()
        delta = FakeDelta()

    class FakeResponse:
        choices = [FakeChoice()]

    class FakeCompletions:
        def __init__(self):
            self.calls = []

        def create(self, **kwargs):
            self.calls.append(kwargs)
            if kwargs.get("stream"):
                return [FakeResponse()]
            return FakeResponse()

    class FakeChat:
        def __init__(self, completions):
            self.completions = completions

    class FakeClient:
        def __init__(self):
            self.completions = FakeCompletions()
            self.chat = FakeChat(self.completions)

    fake_client = FakeClient()
    original_module = adapter.GROQ_MODULE
    original_get_client = adapter._get_groq_client
    original_consume = adapter.groq_bucket.consume
    try:
        adapter.GROQ_MODULE = object()
        adapter._get_groq_client = lambda _api_key: fake_client
        adapter.groq_bucket.consume = lambda _n=1: True
        adapter._call_groq("hello", "key", GROQ_CHAT_MODEL, reasoning_effort="low")
        list(adapter._call_groq_stream("hello", "key", GROQ_CHAT_MODEL, reasoning_effort="medium"))
    finally:
        adapter.GROQ_MODULE = original_module
        adapter._get_groq_client = original_get_client
        adapter.groq_bucket.consume = original_consume

    effort_calls = [call.get("reasoning_effort") for call in fake_client.completions.calls]
    if effort_calls == ["low", "medium"]:
        print("PASS | GPT-OSS helpers pass low and medium reasoning effort")
    else:
        print(f"FAIL | GPT-OSS helper efforts were {effort_calls}, expected ['low', 'medium']")
        failures += 1

    if failures:
        print(f"Adapter routing validation failed: {failures} case(s) failed.")
        return 1

    print("Adapter routing validation passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
