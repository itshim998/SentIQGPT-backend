import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:sentiq_chat/core/network/network_status.dart';
import 'package:sentiq_chat/features/workspace/application/workspace_controller.dart';
import 'package:sentiq_chat/features/workspace/data/conversation_repository.dart';
import 'package:sentiq_chat/features/workspace/domain/conversation_summary.dart';

void main() {
  test('startup paints only five cached chats until cloud history arrives', () async {
    final _HydrationRepository repository = _HydrationRepository();
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
    expect(controller.state.conversations, hasLength(5));
    expect(
      controller.state.conversations.map((ConversationSummary item) => item.id),
      <String>['chat-0', 'chat-1', 'chat-2', 'chat-3', 'chat-4'],
    );

    repository.completeCloud();
    await _waitUntil(() => !controller.state.loading);

    expect(controller.state.conversations, hasLength(8));
    expect(controller.state.conversations.first.id, 'chat-0');
    expect(controller.state.conversations.last.id, 'chat-7');
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

class _HydrationRepository implements ConversationRepository {
  final Completer<ConversationLoadResult> _cloud =
      Completer<ConversationLoadResult>();

  late final List<ConversationSummary> _items =
      List<ConversationSummary>.generate(8, (int index) {
        final DateTime timestamp = DateTime.utc(
          2026,
          8,
          9,
          12,
        ).subtract(Duration(minutes: index));
        return ConversationSummary(
          id: 'chat-$index',
          ownerScope: 'user-1',
          title: 'Chat $index',
          createdAt: timestamp,
          updatedAt: timestamp,
          syncState: ConversationSyncState.synced,
        );
      });

  void completeCloud() {
    _cloud.complete(
      ConversationLoadResult(
        items: _items,
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
        items: _items,
        degraded: false,
        fromCache: true,
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
