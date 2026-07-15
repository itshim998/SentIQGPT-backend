import argparse
import sys
from contextlib import contextmanager
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import llm_adapter as adapter


class SkipSmoke(Exception):
    pass


@contextmanager
def patched(**attrs):
    originals = {name: getattr(adapter, name) for name in attrs}
    try:
        for name, value in attrs.items():
            setattr(adapter, name, value)
        yield
    finally:
        for name, value in originals.items():
            setattr(adapter, name, value)


def require_gemini_keys():
    if not adapter.GEMINI_KEY_RECORDS:
        raise SkipSmoke("No Gemini/Gemma keys configured.")


def sanitize_preview(text: str, limit: int = 120) -> str:
    text = adapter._redact_secrets(text or "").replace("\r", " ").replace("\n", " ").strip()
    return text[:limit]


def case_flash_lite_text():
    require_gemini_keys()
    text = adapter._invoke_gemini(
        "Reply with a short plain-text acknowledgement.",
        adapter.GEMINI_STANDARD_MODEL,
    )
    return f"model={adapter.GEMINI_STANDARD_MODEL} preview={sanitize_preview(text)}"


def case_gemma_31b_text():
    require_gemini_keys()
    text = adapter._invoke_gemini(
        "Reply with a short plain-text acknowledgement.",
        adapter.GEMMA_PRIMARY_MODEL,
    )
    return f"model={adapter.GEMMA_PRIMARY_MODEL} preview={sanitize_preview(text)}"


def case_gemma_26b_text():
    require_gemini_keys()
    text = adapter._invoke_gemini(
        "Reply with a short plain-text acknowledgement.",
        adapter.GEMMA_SECONDARY_MODEL,
    )
    return f"model={adapter.GEMMA_SECONDARY_MODEL} preview={sanitize_preview(text)}"


def case_stream():
    require_gemini_keys()
    chunks = []
    for chunk in adapter._stream_gemini_attempt_chain(
        "Reply with one short sentence.",
        [adapter.GeminiAttempt(adapter.GEMINI_STANDARD_MODEL)],
    ):
        if chunk:
            chunks.append(chunk)
    return f"model={adapter.GEMINI_STANDARD_MODEL} preview={sanitize_preview(''.join(chunks))}"


def case_forced_groq_fallback():
    require_gemini_keys()
    with patched(
        _cache_get=lambda _key: None,
        _cache_set=lambda _key, _value: None,
        _invoke_groq=lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("forced smoke Groq failure")),
    ):
        result = adapter.call_llm_router(
            "Reply with a short plain-text acknowledgement.",
            task="chat",
            prefer="groq",
            model_override="gpt-oss-120b",
        )
    return f"model={result.get('model_used')} fallback={result.get('fallback')} preview={sanitize_preview(result.get('text', ''))}"


def case_forced_gemini_pollinations():
    with patched(
        _cache_get=lambda _key: None,
        _cache_set=lambda _key, _value: None,
        _call_gemini=lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("forced smoke Gemini failure")),
    ):
        result = adapter.call_llm_router(
            "Reply with a short plain-text acknowledgement.",
            task="chat",
            model_override="gemini:gemini-lite",
        )
    return f"model={result.get('model_used')} fallback={result.get('fallback')} preview={sanitize_preview(result.get('text', ''))}"


CASES = {
    "flash-lite-text": lambda args: case_flash_lite_text(),
    "gemma-31b-text": lambda args: case_gemma_31b_text(),
    "gemma-26b-text": lambda args: case_gemma_26b_text(),
    "stream": lambda args: case_stream(),
    "forced-groq-fallback": lambda args: case_forced_groq_fallback(),
    "forced-gemini-pollinations": lambda args: case_forced_gemini_pollinations(),
}


def main() -> int:
    parser = argparse.ArgumentParser(description="Opt-in live Gemini/Gemma smoke tests.")
    parser.add_argument("--case", required=True, choices=sorted(CASES))
    args = parser.parse_args()

    try:
        summary = CASES[args.case](args)
        print(f"PASS | {args.case} | {summary}")
        return 0
    except SkipSmoke as exc:
        print(f"SKIP | {args.case} | {exc}")
        return 0
    except Exception as exc:
        print(f"FAIL | {args.case} | {adapter._redact_secrets(exc)}")
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
