import 'dart:async';
import 'dart:typed_data';

import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sentiq_chat/core/network/api_client.dart';
import 'package:sentiq_chat/core/network/network_status.dart';
import 'package:sentiq_chat/core/network/sse_event.dart';
import 'package:sentiq_chat/features/chat/application/chat_controller.dart';
import 'package:sentiq_chat/features/chat/data/chat_repository.dart';
import 'package:sentiq_chat/features/chat/domain/chat_models.dart';
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
  FakeNetworkMonitor network,
) async {
  final ChatController controller = ChatController(
    session: const WorkspaceSession(ownerScope: 'user-1', cloudEnabled: true),
    repository: repository,
    networkMonitor: network,
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
}
