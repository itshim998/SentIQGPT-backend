from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def main() -> None:
    path = ROOT / (
        "mobile/sentiq_chat/lib/features/chat/presentation/chat_message_list.dart"
    )
    content = path.read_text(encoding="utf-8")
    old = "scrollCacheExtent: 900,"
    new = "scrollCacheExtent: const ScrollCacheExtent.pixels(900),"
    count = content.count(old)
    if count != 1:
        raise RuntimeError(
            f"Expected exactly one typed cache-extent migration target; found {count}"
        )
    path.write_text(content.replace(old, new, 1), encoding="utf-8")


if __name__ == "__main__":
    main()
