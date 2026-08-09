import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:sentiq_chat/core/network/network_status.dart';
import 'package:sentiq_chat/features/workspace/application/workspace_controller.dart';
import 'package:sentiq_chat/features/workspace/data/conversation_repository.dart';
import 'package:sentiq_chat/features/workspace/domain/conversation_summary.dart';

void main() {
  test('refresh requested during startup refresh is never dropped', () async {
    final _QueuedConversationRepository repository =
        _QueuedConversationRepository();
    final WorkspaceController controller = WorkspaceController(
      session: const WorkspaceSession(
        ownerScope: 'user-1',
        cloudEnabled: true,
      ),
      repository: repository,
      networkMonitor: const _OnlineNetworkMonitor(),
    );

    await controller.initialize();
    expect(repository.cloudLoadCalls, 1);

    await controller.newConversation();
    expect(controller.state.selectedConversationId, 'local-new-chat');

    repository.completeNextCloud(<ConversationSummary>[repository.cachedChat]);
    await _waitUntil(() => repository.cloudLoadCalls == 2);

    repository.completeNextCloud(<ConversationSummary>[
      repository.localNewChat!,
      repository.cachedChat,
    ]);
    await _waitUntil(
      () => controller.state.conversations.any(
        (ConversationSummary item) => item.id == 'local-new-chat',
      ),
    );

    expect(repository.cloudLoadCalls, 2);
    expect(
      controller.state.conversations.any(
        (ConversationSummary item) => item.id == 'local-new-chat',
      ),
      isTrue,
    );
    controller.dispose();
  });

  test('empty signed-in cache waits for cloud restore after reinstall', () async {
    final _FreshInstallConversationRepository repository =
        _FreshInstallConversationRepository();
    final WorkspaceController controller = WorkspaceController(
      session: const WorkspaceSession(
        ownerScope: 'user-1',
        cloudEnabled: true,
      ),
      repository: repository,
      networkMonitor: const _OnlineNetworkMonitor(),
    );

    final Future<void> initialize = controller.initialize();
    await Future<void>.delayed(Duration.zero);
    expect(controller.state.loading, isTrue);
    expect(controller.state.conversations, isEmpty);

    repository.completeCloud();
    await initialize;

    expect(controller.state.loading, isFalse);
    expect(controller.state.conversations.single.id, 'restored-cloud-chat');
    expect(controller.state.selectedConversationId, 'restored-cloud-chat');
    controller.dispose();
  });
}

Future<void> _waitUntil(bool Function() condition) async {
  for (int attempt = 0; attempt < 50; attempt += 1) {
    if (condition()) return;
    await Future<void>.delayed(Duration.zero);
  }
  fail('Condition was not reached');
}

class _OnlineNetworkMonitor implements NetworkMonitor {
  const _OnlineNetworkMonitor();

  @override
  Stream<NetworkAvailability> get changes => const Stream.empty();

  @override
  Future<NetworkAvailability> current() async => NetworkAvailability.online;
}

class _QueuedConversationRepository implements ConversationRepository {
  final List<Completer<ConversationLoadResult>> _cloud =
      <Completer<ConversationLoadResult>>[];
  int cloudLoadCalls = 0;

  final ConversationSummary cachedChat = ConversationSummary(
    id: 'cached-chat',
    ownerScope: 'user-1',
    title: 'Cached chat',
    createdAt: DateTime.utc(2026, 8, 8),
    updatedAt: DateTime.utc(2026, 8, 8),
    syncState: ConversationSyncState.synced,
  );
  ConversationSummary? localNewChat;

  void completeNextCloud(List<ConversationSummary> items) {
    final Completer<ConversationLoadResult> completer = _cloud.firstWhere(
      (Completer<ConversationLoadResult> item) => !item.isCompleted,
    );
    completer.complete(
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
  }) {
    if (!networkAvailable) {
      return Future<ConversationLoadResult>.value(
        ConversationLoadResult(
          items: <ConversationSummary>[cachedChat],
          degraded: false,
          fromCache: true,
        ),
      );
    }
    cloudLoadCalls += 1;
    final Completer<ConversationLoadResult> completer =
        Completer<ConversationLoadResult>();
    _cloud.add(completer);
    return completer.future;
  }

  @override
  Future<ConversationSummary> create({
    required String ownerScope,
    required bool cloudEnabled,
    required bool networkAvailable,
    String title = 'New chat',
  }) async {
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
  }) async => conversation.copyWith(title: title);

  @override
  Future<void> delete({
    required ConversationSummary conversation,
    required bool cloudEnabled,
    required bool networkAvailable,
  }) async {}
}

class _FreshInstallConversationRepository implements ConversationRepository {
  final Completer<ConversationLoadResult> _cloud =
      Completer<ConversationLoadResult>();

  void completeCloud() {
    _cloud.complete(
      ConversationLoadResult(
        items: <ConversationSummary>[
          ConversationSummary(
            id: 'restored-cloud-chat',
            ownerScope: 'user-1',
            title: 'Restored chat',
            createdAt: DateTime.utc(2026, 8, 9),
            updatedAt: DateTime.utc(2026, 8, 9),
            syncState: ConversationSyncState.synced,
          ),
        ],
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
  }) {
    if (!networkAvailable) {
      return Future<ConversationLoadResult>.value(
        const ConversationLoadResult(
          items: <ConversationSummary>[],
          degraded: false,
          fromCache: true,
        ),
      );
    }
    return _cloud.future;
  }

  @override
  Future<ConversationSummary> create({
    required String ownerScope,
    required bool cloudEnabled,
    required bool networkAvailable,
    String title = 'New chat',
  }) {
    throw UnimplementedError();
  }

  @override
  Future<ConversationSummary> rename({
    required ConversationSummary conversation,
    required String title,
    required bool cloudEnabled,
    required bool networkAvailable,
  }) {
    throw UnimplementedError();
  }

  @override
  Future<void> delete({
    required ConversationSummary conversation,
    required bool cloudEnabled,
    required bool networkAvailable,
  }) {
    throw UnimplementedError();
  }
}
