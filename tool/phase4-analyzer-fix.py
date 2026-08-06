import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1] / "mobile" / "sentiq_chat"


def replace_once(path: Path, old: str, new: str) -> None:
    content = path.read_text(encoding="utf-8")
    count = content.count(old)
    if count != 1:
        raise RuntimeError(f"Expected one match in {path}: found {count}: {old!r}")
    path.write_text(content.replace(old, new, 1), encoding="utf-8")


def remove_once(path: Path, value: str) -> None:
    replace_once(path, value, "")


def main() -> None:
    controller = ROOT / "lib/features/chat/application/chat_controller.dart"
    remove_once(controller, "import 'dart:typed_data';\n\n")
    replace_once(
        controller,
        "      if (!image.valid) throw Exception('The image provider returned no usable image.');",
        "      if (!image.valid) {\n"
        "        throw Exception('The image provider returned no usable image.');\n"
        "      }",
    )
    replace_once(
        controller,
        "  Future<void> _markMetadataDeleted(\n"
        "    String conversationId,\n"
        "    String messageId,\n"
        "    String key,\n"
        "  ) {\n"
        "    final ChatMessage? message = _message(conversationId, messageId);\n"
        "    if (message == null) return;",
        "  Future<void> _markMetadataDeleted(\n"
        "    String conversationId,\n"
        "    String messageId,\n"
        "    String key,\n"
        "  ) async {\n"
        "    final ChatMessage? message = _message(conversationId, messageId);\n"
        "    if (message == null) {\n"
        "      return;\n"
        "    }",
    )

    remote = ROOT / "lib/features/chat/data/chat_remote_source.dart"
    replace_once(
        remote,
        "        if (conversationId != null) 'conversationId': conversationId,",
        "        'conversationId': ?conversationId,",
    )
    replace_once(
        remote,
        "        if (analysisId != null) 'analysis_id': analysisId,",
        "        'analysis_id': ?analysisId,",
    )
    replace_once(
        remote,
        "        if (version != null) 'version': version,",
        "        'version': ?version,",
    )

    message_list = ROOT / "lib/features/chat/presentation/chat_message_list.dart"
    replace_once(
        message_list,
        "  final VoidCallback? onRetry;\n"
        "  final VoidCallback? onContinue;\n"
        "  final Future<void> Function(GeneratedImagePayload, ArtifactAction)? onImageAction;\n"
        "  final Future<void> Function(GeneratedArtifactPayload, ArtifactAction)? onArtifactAction;\n"
        "  final Future<void> Function(ChatMessage, GeneratedImagePayload)? onDeleteImage;\n"
        "  final Future<void> Function(ChatMessage, GeneratedArtifactPayload)? onDeleteArtifact;\n"
        "  final Future<GeneratedArtifactPayload> Function(GeneratedArtifactPayload, String)?\n"
        "      onSaveArtifactHtml;\n",
        "  final VoidCallback? onRetry;\n"
        "  final VoidCallback? onContinue;\n",
    )
    replace_once(
        message_list,
        "(GeneratedImagePayload _, ArtifactAction __) async {}",
        "(GeneratedImagePayload _, ArtifactAction _) async {}",
    )
    replace_once(
        message_list,
        "(GeneratedArtifactPayload _, ArtifactAction __) async {}",
        "(GeneratedArtifactPayload _, ArtifactAction _) async {}",
    )

    models = ROOT / "lib/features/multimodal/domain/multimodal_models.dart"
    content = models.read_text(encoding="utf-8")
    if content.startswith("// ignore_for_file: sort_constructors_first"):
        raise RuntimeError("Constructor-order ignore already present")
    models.write_text(
        "// ignore_for_file: sort_constructors_first\n\n" + content,
        encoding="utf-8",
    )

    platform = ROOT / "lib/features/multimodal/platform/artifact_platform_service.dart"
    remove_once(platform, "import 'dart:typed_data';\n\n")

    extras = ROOT / "lib/features/multimodal/presentation/multimodal_message_extras.dart"
    replace_once(
        extras,
        "    if (!payload.valid) return _Failure(payload.error ?? 'Malformed chart data.');",
        "    if (!payload.valid) {\n"
        "      return _Failure(payload.error ?? 'Malformed chart data.');\n"
        "    }",
    )
    replace_once(
        extras,
        "  if (value is! Map) return <String, Object?>{};",
        "  if (value is! Map) {\n"
        "    return <String, Object?>{};\n"
        "  }",
    )
    extras_content = extras.read_text(encoding="utf-8")
    single_line_if = re.compile(
        r"^(?P<indent>[ \t]*)if \((?P<condition>[^\n]+)\) "
        r"(?P<statement>(?:return|continue|break|throw)\b[^\n]*;)$",
        re.MULTILINE,
    )
    matches = list(single_line_if.finditer(extras_content))
    if len(matches) != 1:
        raise RuntimeError(
            "Expected exactly one remaining unbraced flow-control statement "
            f"in {extras}; found {len(matches)}"
        )
    match = matches[0]
    indent = match.group("indent")
    replacement = (
        f"{indent}if ({match.group('condition')}) {{\n"
        f"{indent}  {match.group('statement')}\n"
        f"{indent}}}"
    )
    extras.write_text(
        extras_content[: match.start()] + replacement + extras_content[match.end() :],
        encoding="utf-8",
    )

    remove_once(
        ROOT / "test/features/chat/chat_controller_continuity_test.dart",
        "import 'dart:typed_data';\n\n",
    )
    remove_once(
        ROOT / "test/features/multimodal/artifact_platform_service_test.dart",
        "import 'dart:typed_data';\n\n",
    )


if __name__ == "__main__":
    main()
