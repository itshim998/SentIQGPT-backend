from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MODEL_ID = "vendouple/nemotron-3-ultra:free"
EXPECTED_LINE = f"POLLINATIONS_INTUITIVE_MODEL={MODEL_ID}"


def require_contains(path: Path, needle: str) -> None:
    content = path.read_text(encoding="utf-8")
    if needle not in content:
        raise AssertionError(f"{path.relative_to(ROOT)} does not contain the expected Intuitive model configuration")


def main() -> int:
    require_contains(ROOT / ".env.example", EXPECTED_LINE)
    require_contains(ROOT / ".env.template", EXPECTED_LINE)
    require_contains(ROOT / "docs" / "ai" / "NEMOTRON_INTUITIVE_PASS1.md", MODEL_ID)
    require_contains(ROOT / "llm_adapter.py", 'os.getenv("POLLINATIONS_INTUITIVE_MODEL", "").strip()')

    print(f"Pollinations Intuitive model configuration validated: {MODEL_ID}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
