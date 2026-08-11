import 'dart:async';
import 'dart:io';
import 'dart:typed_data';

import 'package:file_picker/file_picker.dart';
import 'package:sentiq_chat/features/chat/domain/chat_models.dart';
import 'package:sentiq_chat/features/multimodal/data/content_policy.dart';
import 'package:uuid/uuid.dart';

const List<String> sentIQAllowedAttachmentExtensions = <String>[
  'pdf',
  'txt',
  'md',
  'csv',
  'json',
  'html',
  'htm',
  'xml',
  'yaml',
  'yml',
  'dart',
  'js',
  'ts',
  'py',
  'java',
  'kt',
  'c',
  'cpp',
  'h',
  'css',
  'sql',
  'png',
  'jpg',
  'jpeg',
  'webp',
];

class PickedChatAttachmentResult {
  const PickedChatAttachmentResult({
    required this.name,
    this.attachment,
    this.error,
  });

  final String name;
  final ChatAttachment? attachment;
  final String? error;

  bool get accepted => attachment != null;
}

Future<List<PickedChatAttachmentResult>> pickedChatAttachmentsFromFiles(
  Iterable<PlatformFile> files, {
  Uuid uuid = const Uuid(),
}) async {
  final List<PickedChatAttachmentResult> results =
      <PickedChatAttachmentResult>[];
  for (final PlatformFile file in files) {
    final String name = file.name.trim().isEmpty ? 'attachment' : file.name;
    final String? extension = chatAttachmentExtension(name);
    final String mimeType = chatAttachmentMimeType(extension);
    if (file.size > AttachmentPolicy.maximumBytes) {
      results.add(
        PickedChatAttachmentResult(
          name: name,
          error: AttachmentPolicy.validate(
            filename: name,
            mimeType: mimeType,
            sizeBytes: file.size,
          ),
        ),
      );
      continue;
    }

    Uint8List? bytes;
    try {
      bytes = await pickedPlatformFileBytes(file);
    } on ContentPolicyException catch (error) {
      results.add(PickedChatAttachmentResult(name: name, error: error.message));
      continue;
    } on FileSystemException {
      bytes = null;
    }

    if (bytes == null) {
      results.add(
        PickedChatAttachmentResult(
          name: name,
          error:
              'Could not read this file from Android storage. Try selecting a local copy.',
        ),
      );
      continue;
    }

    final String? validation = AttachmentPolicy.validate(
      filename: name,
      mimeType: mimeType,
      sizeBytes: bytes.length,
    );
    if (validation != null) {
      results.add(PickedChatAttachmentResult(name: name, error: validation));
      continue;
    }

    results.add(
      PickedChatAttachmentResult(
        name: name,
        attachment: ChatAttachment(
          id: uuid.v4(),
          name: name,
          mimeType: mimeType,
          sizeBytes: bytes.length,
          bytes: bytes,
        ),
      ),
    );
  }
  return results;
}

Future<Uint8List?> pickedPlatformFileBytes(PlatformFile file) async {
  final Uint8List? inMemory = file.bytes;
  if (inMemory != null && inMemory.isNotEmpty) return inMemory;

  final Stream<List<int>>? readStream = file.readStream;
  if (readStream != null) return _readBounded(readStream);

  final String? path = file.path;
  if (path == null || path.isEmpty) return inMemory;
  final File cached = File(path);
  if (!await cached.exists()) return inMemory;
  final int length = await cached.length();
  if (length > AttachmentPolicy.maximumBytes) {
    throw const ContentPolicyException('Files must be 10 MB or smaller.');
  }
  return cached.readAsBytes();
}

String? chatAttachmentExtension(String name) {
  final int dot = name.lastIndexOf('.');
  if (dot < 0 || dot == name.length - 1) return null;
  return name.substring(dot + 1);
}

String chatAttachmentMimeType(String? extension) {
  return switch (extension?.toLowerCase()) {
    'png' => 'image/png',
    'jpg' || 'jpeg' => 'image/jpeg',
    'webp' => 'image/webp',
    'pdf' => 'application/pdf',
    'csv' => 'text/csv',
    'json' => 'application/json',
    'md' => 'text/markdown',
    'txt' => 'text/plain',
    _ => 'application/octet-stream',
  };
}

Future<Uint8List> _readBounded(Stream<List<int>> stream) async {
  final BytesBuilder builder = BytesBuilder(copy: false);
  int received = 0;
  await for (final List<int> chunk in stream) {
    received += chunk.length;
    if (received > AttachmentPolicy.maximumBytes) {
      throw const ContentPolicyException('Files must be 10 MB or smaller.');
    }
    builder.add(chunk);
  }
  return builder.takeBytes();
}
