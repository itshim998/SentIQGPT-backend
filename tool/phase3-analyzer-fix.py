from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def replace_once(path: str, old: str, new: str) -> None:
    target = ROOT / path
    content = target.read_text(encoding="utf-8")
    count = content.count(old)
    if count != 1:
        raise RuntimeError(f"Expected exactly one match in {path}: {old!r}; found {count}")
    target.write_text(content.replace(old, new, 1), encoding="utf-8")


def add_overrides() -> None:
    path = ROOT / "mobile/sentiq_chat/lib/features/chat/data/chat_repository.dart"
    content = path.read_text(encoding="utf-8")
    implementation = content.index("class ChatRepository implements ChatRepositoryContract")
    head, body = content[:implementation], content[implementation:]
    declarations = (
        "  Future<ChatLoadResult> load({",
        "  Future<void> save(String ownerScope, ChatMessage message) {",
        "  Future<void> saveAll(String ownerScope, List<ChatMessage> messages) {",
        "  Future<void> recordTurn({",
        "  Future<void> updateTurnState(String clientRequestId, String state) {",
        "  Future<Set<String>> knownRequestIds(String ownerScope) {",
        "  Future<SentIQSseConnection> stream(ChatTurnRequest request) {",
        "  Future<ChatAttachment> upload(ChatAttachment attachment) {",
        "  Future<Map<String, Object?>> askAboutSelection({",
        "  Future<ChatQuotaState> quota() => _remote.quota();",
        "  Future<void> syncPending({",
    )
    for declaration in declarations:
        needle = f"\n{declaration}"
        if body.count(needle) != 1:
            raise RuntimeError(
                f"Expected exactly one implementation declaration in {path}: {declaration!r}"
            )
        body = body.replace(needle, f"\n  @override\n{declaration}", 1)
    path.write_text(head + body, encoding="utf-8")


def main() -> None:
    add_overrides()

    models = "mobile/sentiq_chat/lib/features/chat/domain/chat_models.dart"
    replace_once(
        models,
        "import 'dart:convert';",
        "// ignore_for_file: sort_constructors_first\n\nimport 'dart:convert';",
    )
    replace_once(models, "'${roleValue}-", "'$roleValue-")

    composer = "mobile/sentiq_chat/lib/features/chat/presentation/chat_composer.dart"
    replace_once(composer, "FilePicker.platform.pickFiles(", "FilePicker.pickFiles(")
    replace_once(composer, "separatorBuilder: (_, __) =>", "separatorBuilder: (_, _) =>")

    message_list = (
        "mobile/sentiq_chat/lib/features/chat/presentation/chat_message_list.dart"
    )
    replace_once(
        message_list,
        "import 'package:flutter/material.dart';",
        "import 'package:flutter/material.dart';\n"
        "import 'package:flutter/rendering.dart' show SelectedContent;",
    )
    replace_once(message_list, "cacheExtent: 900,", "scrollCacheExtent: 900,")

    rich_text = "mobile/sentiq_chat/lib/features/chat/presentation/native_rich_text.dart"
    replace_once(
        rich_text,
        "import 'package:flutter/material.dart';",
        "import 'package:flutter/material.dart';\n"
        "import 'package:flutter/rendering.dart' show SelectedContent;",
    )

    workspace = (
        "mobile/sentiq_chat/lib/features/workspace/presentation/workspace_screen.dart"
    )
    replace_once(
        workspace,
        "Icons.progress_activity_rounded",
        "Icons.sync_rounded",
    )


if __name__ == "__main__":
    main()
