import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sentiq_chat/core/design_system/sentiq_theme.dart';
import 'package:sentiq_chat/core/network/network_status.dart';
import 'package:sentiq_chat/features/auth/domain/auth_models.dart';
import 'package:sentiq_chat/features/workspace/application/workspace_controller.dart';
import 'package:sentiq_chat/features/workspace/data/conversation_repository.dart';
import 'package:sentiq_chat/features/workspace/domain/conversation_summary.dart';
import 'package:sentiq_chat/features/workspace/presentation/conversation_sidebar.dart';

void main() {
  testWidgets('first hydration shows only a minimal conversation loader', (
    WidgetTester tester,
  ) async {
    final WorkspaceController controller = _controller();
    await tester.pumpWidget(
      _sidebar(
        controller: controller,
        state: const WorkspaceState(loading: true),
      ),
    );

    expect(find.byType(CircularProgressIndicator), findsOneWidget);
    expect(find.text('Waiting to sync'), findsNothing);
    controller.dispose();
  });

  testWidgets('cached conversations remain visible with loader below them', (
    WidgetTester tester,
  ) async {
    final WorkspaceController controller = _controller();
    final ConversationSummary cached = ConversationSummary(
      id: 'cached-chat',
      ownerScope: 'user-1',
      title: 'Cached chat',
      createdAt: DateTime.utc(2026, 8, 9),
      updatedAt: DateTime.utc(2026, 8, 9),
      syncState: ConversationSyncState.localOnly,
    );
    await tester.pumpWidget(
      _sidebar(
        controller: controller,
        state: WorkspaceState(
          conversations: <ConversationSummary>[cached],
          selectedConversationId: cached.id,
          loading: true,
        ),
      ),
    );

    expect(find.text('Cached chat'), findsOneWidget);
    expect(find.byType(CircularProgressIndicator), findsOneWidget);
    expect(find.text('Waiting to sync'), findsNothing);
    controller.dispose();
  });
}

Widget _sidebar({
  required WorkspaceController controller,
  required WorkspaceState state,
}) {
  return MaterialApp(
    theme: SentIQTheme.dark(),
    home: Scaffold(
      body: SizedBox(
        width: 330,
        child: ConversationSidebar(
          identity: const AppIdentity(
            id: 'user-1',
            email: 'user@example.com',
            displayName: 'User',
            isGuest: false,
          ),
          state: state,
          controller: controller,
          onRename: (_) {},
          onDelete: (_) {},
          onAccount: () {},
          onSettings: () {},
        ),
      ),
    ),
  );
}

WorkspaceController _controller() {
  return WorkspaceController(
    session: const WorkspaceSession(ownerScope: 'user-1', cloudEnabled: true),
    repository: _NoopConversationRepository(),
    networkMonitor: const _OnlineNetworkMonitor(),
  );
}

class _OnlineNetworkMonitor implements NetworkMonitor {
  const _OnlineNetworkMonitor();

  @override
  Stream<NetworkAvailability> get changes => const Stream.empty();

  @override
  Future<NetworkAvailability> current() async => NetworkAvailability.online;
}

class _NoopConversationRepository implements ConversationRepository {
  @override
  Future<ConversationLoadResult> load({
    required String ownerScope,
    required bool cloudEnabled,
    required bool networkAvailable,
  }) async {
    return const ConversationLoadResult(
      items: <ConversationSummary>[],
      degraded: false,
      fromCache: true,
    );
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
