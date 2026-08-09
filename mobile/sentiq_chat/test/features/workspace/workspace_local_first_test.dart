import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:sentiq_chat/core/network/network_status.dart';
import 'package:sentiq_chat/features/workspace/application/workspace_controller.dart';
import 'package:sentiq_chat/features/workspace/data/conversation_repository.dart';
import 'package:sentiq_chat/features/workspace/domain/conversation_summary.dart';

void main() {
  test('workspace paints cache and creates chats before cloud reconciliation', () async {
    final _FakeConversationRepository repository = _FakeConversationRepository();
    final WorkspaceController controller = WorkspaceController(
      session: const WorkspaceSession(
        ownerScope: 'user-1',
        cloudEnabled: true,
      ),
      repository: repository,
      networkMonitor: const _OnlineNetworkMonitor(),
    );

    await controller.initialize();

    expect(controller.state.loading, isTrue);
    expect(controller.state.selectedConversationId, 'cached-chat');
    expect(repository.cloudLoadStarted, isTrue);
    expect(repository.cloudLoadCompleted, isFalse);

    await controller.newConversation();

    expect(repository.createUsedNetwork, isFalse);
    expect(controller.state.selectedConversationId, 'local-new-chat');
    expect(
      controller.state.conversations.any(
        (ConversationSummary item) => item.id == 'local-new-chat',
      ),
      isTrue,
    );

    repository.completeCloud(<ConversationSummary>[
      repository.localNewChat!,
      repository.cachedChat,
    ]);
    await Future<void>.delayed(Duration.zero);
    await Future<void>.delayed(Duration.zero);

    expect(controller.state.loading, isFalse);
    expect(controller.state.selectedConversationId, 'local-new-chat');
    controller.dispose();
  });
}

class _OnlineNetworkMonitor implements NetworkMonitor {
  const _OnlineNetworkMonitor();

  @override
  Stream<NetworkAvailability> get changes => const Stream.empty();

  @override
  Future<NetworkAvailability> current() async => NetworkAvailability.online;
}

class _FakeConversationRepository implements ConversationRepository {
  final Completer<ConversationLoadResult> _cloud =
      Completer<ConversationLoadResult>();

  final ConversationSummary cachedChat = ConversationSummary(
    id: 'cached-chat',
    ownerScope: 'user-1',
    title: 'Cached chat',
    createdAt: DateTime.utc(2026, 8, 8),
    updatedAt: DateTime.utc(2026, 8, 8),
    syncState: ConversationSyncState.synced,
  );

  ConversationSummary? localNewChat;
  bool cloudLoadStarted = false;
  bool cloudLoadCompleted = false;
  bool? createUsedNetwork;

  void completeCloud(List<ConversationSummary> items) {
    if (_cloud.isCompleted) return;
    cloudLoadCompleted = true;
    _cloud.complete(
      ConversationLoadResult(
        items: items,
        degraded: false,
        fromCache: false,
      ),
    );
  }

  @override
  Future<ConversationLoadResult> load({
    required String ownerScope,
    required bool cloudEnabled,
    required bool networkAvailable,
  }) async {
    if (!networkAvailable) {
      return ConversationLoadResult(
        items: <ConversationSummary>[cachedChat],
        degraded: false,
        fromCache: true,
      );
    }
    cloudLoadStarted = true;
    return _cloud.future;
  }

  @override
  Future<ConversationSummary> create({
    required String ownerScope,
    required bool cloudEnabled,
    required bool networkAvailable,
    String title = 'New chat',
  }) async {
    createUsedNetwork = networkAvailable;
    localNewChat = ConversationSummary(
      id: 'local-new-chat',
      ownerScope: ownerScope,
      title: title,
      createdAt: DateTime.utc(2026, 8, 8, 1),
      updatedAt: DateTime.utc(2026, 8, 8, 1),
      syncState: ConversationSyncState.localOnly,
    );
    return localNewChat!;
  }

  @override
  Future<ConversationSummary> rename({
    required ConversationSummary conversation,
    required String title,
    required bool cloudEnabled,
    required bool networkAvailable,
  }) async {
    return conversation.copyWith(title: title);
  }

  @override
  Future<void> delete({
    required ConversationSummary conversation,
    required bool cloudEnabled,
    required bool networkAvailable,
  }) async {}
}
