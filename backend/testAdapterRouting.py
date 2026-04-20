from llm_adapter import CODING_MODEL, GENERAL_CHAT_MODEL, resolve_model_override


CASES = [
    ("qwen-coder", "gemini", ("pollinations", CODING_MODEL)),
    ("qwen3-coder", "gemini", ("pollinations", CODING_MODEL)),
    ("qwen3-coder-30b", "gemini", ("pollinations", CODING_MODEL)),
    ("gemini-fast", "gemini", ("pollinations", GENERAL_CHAT_MODEL)),
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

    if failures:
        print(f"Adapter routing validation failed: {failures} case(s) failed.")
        return 1

    print("Adapter routing validation passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
