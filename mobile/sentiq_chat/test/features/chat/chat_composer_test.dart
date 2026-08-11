import 'dart:io';
import 'dart:typed_data';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sentiq_chat/core/design_system/sentiq_theme.dart';
import 'package:sentiq_chat/features/chat/domain/chat_models.dart';
import 'package:sentiq_chat/features/chat/presentation/chat_attachment_picker_support.dart';
import 'package:sentiq_chat/features/chat/presentation/chat_composer.dart';
import 'package:sentiq_chat/features/chat/presentation/compact_chat_composer.dart';
import 'package:sentiq_chat/features/multimodal/domain/multimodal_models.dart';

Widget app({
  required bool generating,
  bool imageGenerationMode = false,
  ValueChanged<bool>? onImageGenerationModeChanged,
  ValueChanged<ChatAttachment>? onAttachmentAdded,
  bool attachmentsEnabled = true,
}) {
  return MaterialApp(
    theme: SentIQTheme.light(),
    home: Scaffold(
      body: Align(
        alignment: Alignment.bottomCenter,
        child: ChatComposer(
          executionMode: ChatExecutionMode.fast,
          quota: const ChatQuotaState(),
          generating: generating,
          attachments: const <ChatAttachment>[],
          webSearchEnabled: false,
          enabled: true,
          attachmentsEnabled: attachmentsEnabled,
          imageGenerationMode: imageGenerationMode,
          imageQuota: const ImageQuotaState(remaining: 2, limit: 2),
          onExecutionModeChanged: (_) {},
          onWebSearchChanged: (_) {},
          onAttachmentAdded: onAttachmentAdded ?? (_) {},
          onImageGenerationModeChanged: onImageGenerationModeChanged ?? (_) {},
          onAttachmentRemoved: (_) {},
          onAttachmentRetry: (_) {},
          onSend: (_) async => true,
          onStop: () {},
        ),
      ),
    ),
  );
}

Widget compactApp({
  required ValueChanged<ChatAttachment> onAttachmentAdded,
  bool attachmentsEnabled = true,
}) {
  return MaterialApp(
    theme: SentIQTheme.light(),
    home: Scaffold(
      body: Align(
        alignment: Alignment.bottomCenter,
        child: CompactChatComposer(
          executionMode: ChatExecutionMode.fast,
          quota: const ChatQuotaState(),
          generating: false,
          attachments: const <ChatAttachment>[],
          webSearchEnabled: false,
          enabled: true,
          attachmentsEnabled: attachmentsEnabled,
          imageQuota: const ImageQuotaState(remaining: 2, limit: 2),
          onWebSearchChanged: (_) {},
          onAttachmentAdded: onAttachmentAdded,
          onAttachmentRemoved: (_) {},
          onAttachmentRetry: (_) {},
          onSend: (_) async => true,
          onStop: () {},
        ),
      ),
    ),
  );
}

void main() {
  test(
    'attachment picker helper reads Android cached paths without bytes',
    () async {
      final _PickedPathFixture fixture = await _PickedPathFixture.create();
      addTearDown(fixture.dispose);

      final List<PickedChatAttachmentResult> results =
          await pickedChatAttachmentsFromFiles(fixture.result.files);

      expect(results, hasLength(1));
      expect(results.single.accepted, isTrue);
      expect(results.single.attachment?.name, 'android-note.txt');
      expect(results.single.attachment?.bytes, orderedEquals(fixture.bytes));
    },
  );

  testWidgets('grows automatically for multiline input', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(app(generating: false));
    final double before = tester.getSize(find.byType(TextField)).height;
    await tester.enterText(
      find.byType(TextField),
      'One\nTwo\nThree\nFour\nFive',
    );
    await tester.pump();
    final double after = tester.getSize(find.byType(TextField)).height;
    expect(after, greaterThan(before));
  });

  testWidgets('switches from send to stop while generating', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(app(generating: false));
    expect(find.byTooltip('Send message'), findsOneWidget);
    await tester.pumpWidget(app(generating: true));
    await tester.pump();
    expect(find.byTooltip('Stop generating'), findsOneWidget);
  });

  testWidgets('Visualize lives in the plus menu instead of a dedicated chip', (
    WidgetTester tester,
  ) async {
    bool? visualize;
    await tester.pumpWidget(
      app(
        generating: false,
        onImageGenerationModeChanged: (bool value) => visualize = value,
      ),
    );

    expect(find.text('Image'), findsNothing);
    await tester.tap(find.byTooltip('Tools and attachments'));
    await tester.pumpAndSettle();
    expect(find.text('Visualize'), findsOneWidget);
    expect(find.text('Create an image from your description'), findsOneWidget);
    await tester.tap(find.text('Visualize'));
    await tester.pumpAndSettle();
    expect(visualize, isTrue);
  });

  testWidgets('expanded composer omits attachment pickers when disabled', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(app(generating: false, attachmentsEnabled: false));

    await tester.tap(find.byTooltip('Tools and attachments'));
    await tester.pumpAndSettle();

    expect(find.text('Attach files'), findsNothing);
    expect(find.text('Choose images'), findsNothing);
    expect(find.text('Take a photo'), findsNothing);
    expect(find.text('Search the web'), findsOneWidget);
  });

  testWidgets('compact composer omits attachment pickers when disabled', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(
      compactApp(onAttachmentAdded: (_) {}, attachmentsEnabled: false),
    );

    await tester.tap(find.byTooltip('Tools and attachments'));
    await tester.pumpAndSettle();

    expect(find.text('Attach files'), findsNothing);
    expect(find.text('Choose images'), findsNothing);
    expect(find.text('Take a photo'), findsNothing);
    expect(find.text('Search the web'), findsOneWidget);
  });

  testWidgets('expanded composer attaches picker files', (
    WidgetTester tester,
  ) async {
    final List<int> bytes = 'hello from picker'.codeUnits;
    final _FakeFilePicker picker = _FakeFilePicker(_memoryPickerResult(bytes));
    FilePicker.platform = picker;
    ChatAttachment? attachment;

    await tester.pumpWidget(
      app(
        generating: false,
        onAttachmentAdded: (ChatAttachment value) => attachment = value,
      ),
    );
    await tester.tap(find.byTooltip('Tools and attachments'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Attach files'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 250));

    expect(picker.withData, isFalse);
    expect(attachment?.name, 'memory-note.txt');
    expect(attachment?.bytes, orderedEquals(bytes));
    expect(tester.takeException(), isNull);
  });

  testWidgets('compact composer attaches picker files', (
    WidgetTester tester,
  ) async {
    final List<int> bytes = 'hello from picker'.codeUnits;
    final _FakeFilePicker picker = _FakeFilePicker(_memoryPickerResult(bytes));
    FilePicker.platform = picker;
    ChatAttachment? attachment;

    await tester.pumpWidget(
      compactApp(
        onAttachmentAdded: (ChatAttachment value) => attachment = value,
      ),
    );
    await tester.tap(find.byTooltip('Tools and attachments'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Attach files'));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 250));

    expect(picker.withData, isFalse);
    expect(attachment?.name, 'memory-note.txt');
    expect(attachment?.bytes, orderedEquals(bytes));
    expect(tester.takeException(), isNull);
  });
}

FilePickerResult _memoryPickerResult(List<int> bytes) {
  return FilePickerResult(<PlatformFile>[
    PlatformFile(
      name: 'memory-note.txt',
      size: bytes.length,
      bytes: Uint8List.fromList(bytes),
    ),
  ]);
}

class _PickedPathFixture {
  const _PickedPathFixture({
    required this.directory,
    required this.bytes,
    required this.result,
  });

  final Directory directory;
  final List<int> bytes;
  final FilePickerResult result;

  static Future<_PickedPathFixture> create({bool includeBytes = false}) async {
    final Directory directory = await Directory.systemTemp.createTemp(
      'sentiq-chat-picker-',
    );
    final File file = File('${directory.path}/android-note.txt');
    final List<int> bytes = 'hello from android'.codeUnits;
    await file.writeAsBytes(bytes);
    return _PickedPathFixture(
      directory: directory,
      bytes: bytes,
      result: FilePickerResult(<PlatformFile>[
        PlatformFile(
          name: 'android-note.txt',
          size: bytes.length,
          path: file.path,
          bytes: includeBytes ? Uint8List.fromList(bytes) : null,
        ),
      ]),
    );
  }

  Future<void> dispose() async {
    if (await directory.exists()) {
      await directory.delete(recursive: true);
    }
  }
}

class _FakeFilePicker extends FilePicker {
  _FakeFilePicker(this.result);

  final FilePickerResult result;
  bool? withData;

  @override
  Future<FilePickerResult?> pickFiles({
    String? dialogTitle,
    String? initialDirectory,
    FileType type = FileType.any,
    List<String>? allowedExtensions,
    Function(FilePickerStatus)? onFileLoading,
    bool allowCompression = false,
    int compressionQuality = 0,
    bool allowMultiple = false,
    bool withData = false,
    bool withReadStream = false,
    bool lockParentWindow = false,
    bool readSequential = false,
  }) async {
    this.withData = withData;
    return result;
  }
}
