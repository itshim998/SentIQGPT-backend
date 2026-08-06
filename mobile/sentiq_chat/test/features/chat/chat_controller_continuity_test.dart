import 'dart:async';
import 'package:flutter/services.dart';
import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sentiq_chat/core/network/api_client.dart';
import 'package:sentiq_chat/core/network/network_status.dart';
import 'package:sentiq_chat/core/network/sse_event.dart';
import 'package:sentiq_chat/features/chat/application/chat_controller.dart';
import 'package:sentiq_chat/features/chat/data/chat_repository.dart';
import 'package:sentiq_chat/features/chat/domain/chat_models.dart';
import 'package:sentiq_chat/features/multimodal/domain/multimodal_models.dart';
import 'package:sentiq_chat/features/multimodal/platform/artifact_platform_service.dart';
import 'package:sentiq_chat/features/workspace/application/workspace_controller.dart';

class FakeNetworkMonitor implements NetworkMonitor {
  FakeNetworkMonitor(this.value);

  NetworkAvailability value;
  final StreamController<NetworkAvailability> controller =
      StreamController<NetworkAvailability>.broadcast();

  @override
  Stream<NetworkAvailability> get changes => controller.stream;

  @override
  Future<NetworkAvailability> current() async => value;

  void emit(NetworkAvailability next) {
    value = next;
    controller.add(next);
  }

  Future<void> close() => controller.close();
}

class FakeChatRepository implements ChatRepositoryContract {
  ChatQuotaState quotaState = const ChatQuotaState();
  final Map<String, List<ChatMessage>> cached = <String, List<ChatMessage>>{};
  final List<StreamController<SentIQSseEvent>> streams =
      <StreamController<SentIQSseEvent>>[];
  Completer<SentIQSseConnection>? connectionGate;
  int syncCalls = 0;
  int cancelCalls = 0;
  final Set<String> requestIds = <String>{};
  final List<StreamController<SentIQSseEvent>> fileUpdateStreams =
      <StreamController<SentIQSseEvent>>[];
  SentIQMultipartUpload? activeUpload;
  bool holdUploads = false;
  Completer<Map<String, Object?>>? pendingUploadResponse;

  StreamController<SentIQSseEvent> get fileUpdateStream =>
      fileUpdateStreams.last;

  StreamController<SentIQSseEvent> newStream() {
    final StreamController<SentIQSseEvent> controller =
        StreamController<SentIQSseEvent>();
    streams.add(controller);
    return controller;
  }

  @override
  Future<Map<String, Object?>> askAboutSelection({
    required String conversationId,
    required String selectedText,
    required List<ChatMessage> recentMessages,
  }) async => <String, Object?>{'answer': 'About $selectedText'};

  @override
  Future<Set<String>> knownRequestIds(String ownerScope) async => requestIds;

  @override
  Future<ChatLoadResult> load({
    required String ownerScope,
    required String conversationId,
    required bool cloudEnabled,
    required bool networkAvailable,
  }) async => ChatLoadResult(
    messages: cached[conversationId] ?? const <ChatMessage>[],
    fromCache: true,
    degraded: !networkAvailable,
  );

  @override
  Future<ChatQuotaState> quota() async => quotaState;

  @override
  Future<void> recordTurn({
    required String ownerScope,
    required String conversationId,
    required String clientRequestId,
    required String userMessageId,
    required String assistantMessageId,
    required ChatExecutionMode executionMode,
    required String state,
  }) async {
    requestIds.add(clientRequestId);
  }

  @override
  Future<void> save(String ownerScope, ChatMessage message) async {
    final List<ChatMessage> values = <ChatMessage>[
      ...(cached[message.conversationId] ?? const <ChatMessage>[]),
    ];
    final int index = values.indexWhere(
      (ChatMessage item) => item.id == message.id,
    );
    if (index < 0) {
      values.add(message);
    } else {
      values[index] = message;
    }
    cached[message.conversationId] = values;
  }

  @override
  Future<void> saveAll(String ownerScope, List<ChatMessage> messages) async {
    for (final ChatMessage message in messages) {
      await save(ownerScope, message);
    }
  }

  @override
  Future<SentIQSseConnection> stream(ChatTurnRequest request) async {
    final Completer<SentIQSseConnection>? gate = connectionGate;
    if (gate != null) return gate.future;
    final StreamController<SentIQSseEvent> controller = newStream();
    return SentIQSseConnection(
      events: controller.stream,
      onCancel: () async {
        cancelCalls += 1;
        if (!controller.isClosed) await controller.close();
      },
    );
  }

  @override
  Future<void> syncPending({
    required String ownerScope,
    required bool cloudEnabled,
    required bool networkAvailable,
  }) async {
    syncCalls += 1;
  }

  @override
  Future<void> updateTurnState(String clientRequestId, String state) async {}

  @override
  Future<SentIQMultipartUpload> startUpload(
    ChatAttachment attachment, {
    String? conversationId,
  }) async {
    final Completer<Map<String, Object?>> response =
        Completer<Map<String, Object?>>();
    final StreamController<double> progress =
        StreamController<double>.broadcast();
    final SentIQMultipartUpload upload = SentIQMultipartUpload(
      response: response.future,
      progress: progress.stream,
      onCancel: () async {
        if (!response.isCompleted) {
          response.completeError(Exception('cancelled'));
        }
        if (!progress.isClosed) await progress.close();
      },
    );
    activeUpload = upload;
    progress.add(.5);
    if (holdUploads) {
      pendingUploadResponse = response;
    } else {
      response.complete(<String, Object?>{
        'filename': attachment.name,
        'extracted_text': 'Ready',
        'analysis_id': 'analysis-${attachment.id}',
      });
      await progress.close();
    }
    return upload;
  }

  @override
  ChatAttachment attachmentFromUpload(
    ChatAttachment attachment,
    Map<String, Object?> payload,
  ) => attachment.copyWith(
    uploading: false,
    progress: 1,
    extractedText: payload['extracted_text']?.toString(),
    analysisId: payload['analysis_id']?.toString(),
  );

  @override
  Future<SentIQSseConnection> fileUpdates() async {
    final StreamController<SentIQSseEvent> controller =
        StreamController<SentIQSseEvent>.broadcast();
    fileUpdateStreams.add(controller);
    return SentIQSseConnection(
      events: controller.stream,
      onCancel: () async {
        if (!controller.isClosed) await controller.close();
      },
    );
  }

  @override
  Future<void> clearFileSession(String? analysisId) async {}

  @override
  Future<ImageQuotaState> imageQuota() async =>
      const ImageQuotaState(remaining: 2, limit: 2);

  @override
  Future<Map<String, Object?>> generateImage({
    required String prompt,
    required String conversationId,
    required String clientRequestId,
    required ChatExecutionMode executionMode,
  }) async => <String, Object?>{
    'type': 'image',
    'image_id': 'image-1',
    'image_url': 'https://cdn.example/image.png',
    'prompt': prompt,
    'remaining': 1,
    'limit': 2,
  };

  @override
  Future<void> deleteImage(String id) async {}

  @override
  Future<Map<String, Object?>> artifactDownload(String id) async =>
      <String, Object?>{'url': 'https://cdn.example/file'};

  @override
  Future<Map<String, Object?>> artifactPreview(String id) async =>
      <String, Object?>{};

  @override
  Future<Map<String, Object?>> updateArtifactHtml({
    required String id,
    required String html,
    int? version,
  }) async => <String, Object?>{
    'file_id': id,
    'file_name': 'file.html',
    'format': 'html',
    'mime_type': 'text/html',
    'html': html,
  };

  @override
  Future<void> deleteArtifact(String id) async {}

  @override
  Future<SentIQBinaryResponse> downloadRemote(
    String url, {
    int maximumBytes = 64 * 1024 * 1024,
  }) async => SentIQBinaryResponse(
    bytes: Uint8List.fromList(<int>[1, 2, 3]),
    contentType: 'application/octet-stream',
    filename: 'file.bin',
  );

  @override
  Future<ChatAttachment> upload(ChatAttachment attachment) async =>
      attachment.copyWith(uploading: false, failed: false);
}

SentIQSseEvent event(
  String type, [
  Map<String, Object?> payload = const <String, Object?>{},
]) {
  return SentIQSseEvent(
    type: type,
    version: 1,
    kind: SentIQSseEvent.classify(type),
    payload: <String, Object?>{'type': type, ...payload},
    rawData: '',
  );
}

Future<ChatController> createController(
  FakeChatRepository repository,
  FakeNetworkMonitor network, {
  ArtifactPlatformService artifactPlatform = const ArtifactPlatformService(),
}) async {
  final ChatController controller = ChatController(
    session: const WorkspaceSession(ownerScope: 'user-1', cloudEnabled: true),
    repository: repository,
    networkMonitor: network,
    artifactPlatform: artifactPlatform,
  );
  await controller.initialize();
  return controller;
}

void main() {
  test('cancels cleanly before the first token arrives', () async {
    final FakeChatRepository repository = FakeChatRepository();
    final FakeNetworkMonitor network = FakeNetworkMonitor(
      NetworkAvailability.online,
    );
    final ChatController controller = await createController(
      repository,
      network,
    );
    repository.connectionGate = Completer<SentIQSseConnection>();

    expect(await controller.send(conversationId: 'a', text: 'Hello'), isTrue);
    await controller.stop('a');
    expect(controller.state.thread('a').generating, isFalse);
    expect(
      controller.state.thread('a').lastAssistant?.status,
      ChatMessageStatus.cancelled,
    );

    final StreamController<SentIQSseEvent> late = repository.newStream();
    repository.connectionGate!.complete(
      SentIQSseConnection(
        events: late.stream,
        onCancel: () async => late.close(),
      ),
    );
    await Future<void>.delayed(Duration.zero);
    await late.close();
    controller.dispose();
    await network.close();
  });

  test('cancels after the first token and preserves partial content', () async {
    final FakeChatRepository repository = FakeChatRepository();
    final FakeNetworkMonitor network = FakeNetworkMonitor(
      NetworkAvailability.online,
    );
    final ChatController controller = await createController(
      repository,
      network,
    );

    await controller.send(conversationId: 'a', text: 'Hello');
    await Future<void>.delayed(Duration.zero);
    repository.streams.single.add(
      event('token', <String, Object?>{'text': 'Partial'}),
    );
    await Future<void>.delayed(const Duration(milliseconds: 45));
    await controller.stop('a');

    expect(controller.state.thread('a').lastAssistant?.content, 'Partial');
    expect(controller.state.thread('a').lastAssistant?.canContinue, isTrue);
    expect(repository.cancelCalls, 1);
    controller.dispose();
    await network.close();
  });

  test(
    'marks a response interrupted when the network ends mid-stream',
    () async {
      final FakeChatRepository repository = FakeChatRepository();
      final FakeNetworkMonitor network = FakeNetworkMonitor(
        NetworkAvailability.online,
      );
      final ChatController controller = await createController(
        repository,
        network,
      );

      await controller.send(conversationId: 'a', text: 'Hello');
      await Future<void>.delayed(Duration.zero);
      final StreamController<SentIQSseEvent> stream = repository.streams.single;
      stream.add(event('token', <String, Object?>{'text': 'Started'}));
      await Future<void>.delayed(const Duration(milliseconds: 45));
      stream.addError(Exception('connection lost'));
      await stream.close();
      await Future<void>.delayed(const Duration(milliseconds: 20));

      expect(
        controller.state.thread('a').lastAssistant?.status,
        ChatMessageStatus.interrupted,
      );
      expect(controller.state.thread('a').lastAssistant?.content, 'Started');
      controller.dispose();
      await network.close();
    },
  );

  test(
    'keeps one conversation generating while another is selected and loaded',
    () async {
      final FakeChatRepository repository = FakeChatRepository();
      final FakeNetworkMonitor network = FakeNetworkMonitor(
        NetworkAvailability.online,
      );
      final ChatController controller = await createController(
        repository,
        network,
      );

      await controller.send(conversationId: 'a', text: 'Long answer');
      await Future<void>.delayed(Duration.zero);
      await controller.loadConversation('b');

      expect(controller.state.thread('a').generating, isTrue);
      expect(controller.state.thread('b').loaded, isTrue);
      await controller.stop('a');
      controller.dispose();
      await network.close();
    },
  );

  test('enforces Fast and Intuitive quota state independently', () async {
    final FakeChatRepository repository = FakeChatRepository()
      ..quotaState = const ChatQuotaState(
        fastAvailable: true,
        intuitiveAvailable: false,
      );
    final FakeNetworkMonitor network = FakeNetworkMonitor(
      NetworkAvailability.online,
    );
    final ChatController controller = await createController(
      repository,
      network,
    );

    controller.setExecutionMode(ChatExecutionMode.intuitive);
    expect(controller.state.executionMode, ChatExecutionMode.fast);
    expect(
      await controller.send(
        conversationId: 'a',
        text: 'Hello',
        executionMode: ChatExecutionMode.intuitive,
      ),
      isFalse,
    );
    controller.dispose();
    await network.close();
  });

  test('persists on background and reconciles on foreground', () async {
    final FakeChatRepository repository = FakeChatRepository();
    final FakeNetworkMonitor network = FakeNetworkMonitor(
      NetworkAvailability.online,
    );
    final ChatController controller = await createController(
      repository,
      network,
    );

    await controller.send(conversationId: 'a', text: 'Hello');
    await Future<void>.delayed(Duration.zero);
    await controller.handleLifecycle(AppLifecycleState.paused);
    final int beforeResume = repository.syncCalls;
    await controller.handleLifecycle(AppLifecycleState.resumed);

    expect(repository.syncCalls, greaterThan(beforeResume));
    await controller.stop('a');
    controller.dispose();
    await network.close();
  });

  test('accepts image attachment bytes without uploading', () async {
    final FakeChatRepository repository = FakeChatRepository();
    final FakeNetworkMonitor network = FakeNetworkMonitor(
      NetworkAvailability.online,
    );
    final ChatController controller = await createController(
      repository,
      network,
    );

    await controller.addAttachment(
      ChatAttachment(
        id: 'image',
        name: 'photo.png',
        mimeType: 'image/png',
        sizeBytes: 3,
        bytes: Uint8List.fromList(<int>[1, 2, 3]),
      ),
    );

    expect(controller.state.attachments.single.isImage, isTrue);
    controller.dispose();
    await network.close();
  });

  test(
    'file analysis updates reconnect to uploaded attachment state',
    () async {
      final FakeChatRepository repository = FakeChatRepository();
      final FakeNetworkMonitor network = FakeNetworkMonitor(
        NetworkAvailability.online,
      );
      final ChatController controller = await createController(
        repository,
        network,
      );
      await controller.addAttachment(
        ChatAttachment(
          id: 'pdf-1',
          name: 'report.pdf',
          mimeType: 'application/pdf',
          sizeBytes: 128,
          bytes: Uint8List.fromList(<int>[1, 2, 3]),
        ),
        conversationId: 'a',
      );
      await Future<void>.delayed(Duration.zero);
      expect(controller.state.attachments.single.analysisId, 'analysis-pdf-1');
      repository.fileUpdateStream.add(
        event('file_analysis', <String, Object?>{
          'analysis_id': 'analysis-pdf-1',
          'status': 'error',
          'error': 'Analysis disconnected.',
        }),
      );
      await Future<void>.delayed(Duration.zero);
      expect(controller.state.attachments.single.failed, isTrue);
      expect(
        controller.state.attachments.single.statusMessage,
        contains('disconnected'),
      );
      controller.dispose();
      await network.close();
    },
  );

  test(
    'image mode creates a persisted image response and updates quota',
    () async {
      final FakeChatRepository repository = FakeChatRepository();
      final FakeNetworkMonitor network = FakeNetworkMonitor(
        NetworkAvailability.online,
      );
      final ChatController controller = await createController(
        repository,
        network,
      );
      controller.setImageGenerationMode(true);
      expect(
        await controller.send(conversationId: 'a', text: 'A quiet lake'),
        isTrue,
      );
      final ChatMessage? assistant = controller.state.thread('a').lastAssistant;
      expect(assistant?.metadata['image'], isA<Map<String, Object?>>());
      expect(controller.state.imageQuota.remaining, 1);
      controller.dispose();
      await network.close();
    },
  );

  test(
    'cancels an active attachment upload without leaving a failed item',
    () async {
      final FakeChatRepository repository = FakeChatRepository()
        ..holdUploads = true;
      final FakeNetworkMonitor network = FakeNetworkMonitor(
        NetworkAvailability.online,
      );
      final ChatController controller = await createController(
        repository,
        network,
      );
      unawaited(
        controller.addAttachment(
          ChatAttachment(
            id: 'pending-pdf',
            name: 'pending.pdf',
            mimeType: 'application/pdf',
            sizeBytes: 128,
            bytes: Uint8List.fromList(<int>[1, 2, 3]),
          ),
          conversationId: 'a',
        ),
      );
      await Future<void>.delayed(Duration.zero);
      expect(controller.state.attachments.single.uploading, isTrue);
      await controller.cancelAttachmentUpload('pending-pdf');
      await Future<void>.delayed(Duration.zero);
      final ChatAttachment cancelled = controller.state.attachments.single;
      expect(cancelled.cancelled, isTrue);
      expect(cancelled.failed, isFalse);
      expect(cancelled.statusMessage, 'Upload cancelled');
      controller.dispose();
      await network.close();
    },
  );

  test('reconnects file analysis updates after network loss', () async {
    final FakeChatRepository repository = FakeChatRepository();
    final FakeNetworkMonitor network = FakeNetworkMonitor(
      NetworkAvailability.online,
    );
    final ChatController controller = await createController(
      repository,
      network,
    );
    await controller.addAttachment(
      ChatAttachment(
        id: 'reconnect-pdf',
        name: 'reconnect.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 128,
        bytes: Uint8List.fromList(<int>[1, 2, 3]),
      ),
      conversationId: 'a',
    );
    await Future<void>.delayed(Duration.zero);
    final int beforeReconnect = repository.fileUpdateStreams.length;
    network.emit(NetworkAvailability.offline);
    await Future<void>.delayed(Duration.zero);
    network.emit(NetworkAvailability.online);
    await Future<void>.delayed(Duration.zero);
    expect(repository.fileUpdateStreams.length, greaterThan(beforeReconnect));
    repository.fileUpdateStream.add(
      event('file_analysis', <String, Object?>{
        'analysis_id': 'analysis-reconnect-pdf',
        'status': 'complete',
      }),
    );
    await Future<void>.delayed(Duration.zero);
    expect(controller.state.attachments.single.failed, isFalse);
    expect(controller.state.attachments.single.statusMessage, 'Ready');
    controller.dispose();
    await network.close();
  });

  test(
    'downloads generated images and artifacts through the native boundary',
    () async {
      TestWidgetsFlutterBinding.ensureInitialized();
      const MethodChannel channel = MethodChannel(
        'phase4-controller-artifacts',
      );
      final List<MethodCall> calls = <MethodCall>[];
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, (MethodCall call) async {
            calls.add(call);
            return call.method == 'saveFile' ? 'content://saved/item' : null;
          });
      final FakeChatRepository repository = FakeChatRepository();
      final FakeNetworkMonitor network = FakeNetworkMonitor(
        NetworkAvailability.online,
      );
      final ChatController controller = await createController(
        repository,
        network,
        artifactPlatform: const ArtifactPlatformService(channel: channel),
      );
      await controller.performImageAction(
        const GeneratedImagePayload(
          id: 'image-download',
          url: 'https://cdn.example/image.png',
        ),
        ArtifactAction.download,
      );
      await controller.performArtifactAction(
        const GeneratedArtifactPayload(
          id: 'artifact-download',
          fileName: 'report.pdf',
          format: 'pdf',
          mimeType: 'application/pdf',
        ),
        ArtifactAction.download,
      );
      expect(
        calls.where((MethodCall call) => call.method == 'saveFile'),
        hasLength(2),
      );
      controller.dispose();
      await network.close();
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, null);
    },
  );

  test('merges WebSurf streaming sources, images and completion', () async {
    final FakeChatRepository repository = FakeChatRepository();
    final FakeNetworkMonitor network = FakeNetworkMonitor(
      NetworkAvailability.online,
    );
    final ChatController controller = await createController(
      repository,
      network,
    );
    expect(
      await controller.send(conversationId: 'web', text: 'Current result'),
      isTrue,
    );
    await Future<void>.delayed(Duration.zero);
    final StreamController<SentIQSseEvent> stream = repository.streams.single;
    final Map<String, Object?> web = <String, Object?>{
      'version': 2,
      'query': 'Current result',
      'sources': <Object?>[
        <String, Object?>{
          'id': 'S1',
          'title': 'Source one',
          'url': 'https://example.com/one',
          'domain': 'example.com',
          'snippet': 'Evidence',
        },
      ],
    };
    stream.add(
      event('websurf_sources', <String, Object?>{
        'web_search': web,
        'images': <String>['https://images.example/result.jpg'],
      }),
    );
    stream.add(
      event('websurf_complete', <String, Object?>{
        'answer': 'Grounded completion.',
        'web_search': web,
        'images': <String>['https://images.example/result.jpg'],
      }),
    );
    stream.add(event('done'));
    await stream.close();
    await Future<void>.delayed(Duration.zero);
    final ChatMessage? assistant = controller.state.thread('web').lastAssistant;
    final WebSurfPayload payload = WebSurfPayload.fromJson(
      (assistant?.metadata['websurf_v2'] as Map).map(
        (Object? key, Object? value) => MapEntry(key.toString(), value),
      ),
    );
    expect(payload.sources, hasLength(1));
    expect(payload.imageUrls, hasLength(1));
    expect(assistant?.content, contains('Grounded completion.'));
    controller.dispose();
    await network.close();
  });
}
