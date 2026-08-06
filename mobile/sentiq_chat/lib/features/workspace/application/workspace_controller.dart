import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:sentiq_chat/core/network/network_status.dart';
import 'package:sentiq_chat/features/workspace/data/conversation_repository.dart';
import 'package:sentiq_chat/features/workspace/domain/conversation_summary.dart';

enum WorkspaceNetworkState { online, offline, degraded }

class WorkspaceSession {
  const WorkspaceSession({
    required this.ownerScope,
    required this.cloudEnabled,
  });

  final String ownerScope;
  final bool cloudEnabled;

  @override
  bool operator ==(Object other) =>
      other is WorkspaceSession &&
      other.ownerScope == ownerScope &&
      other.cloudEnabled == cloudEnabled;

  @override
  int get hashCode => Object.hash(ownerScope, cloudEnabled);
}

class WorkspaceState {
  const WorkspaceState({
    this.conversations = const <ConversationSummary>[],
    this.selectedConversationId,
    this.searchQuery = '',
    this.networkState = WorkspaceNetworkState.online,
    this.loading = true,
    this.message,
  });

  final List<ConversationSummary> conversations;
  final String? selectedConversationId;
  final String searchQuery;
  final WorkspaceNetworkState networkState;
  final bool loading;
  final String? message;

  List<ConversationSummary> get visibleConversations {
    final String query = searchQuery.trim().toLowerCase();
    if (query.isEmpty) return conversations;
    return conversations
        .where(
          (ConversationSummary item) =>
              item.title.toLowerCase().contains(query) ||
              (item.lastMessagePreview?.toLowerCase().contains(query) ?? false),
        )
        .toList();
  }

  ConversationSummary? get selected {
    for (final ConversationSummary item in conversations) {
      if (item.id == selectedConversationId) return item;
    }
    return null;
  }

  WorkspaceState copyWith({
    List<ConversationSummary>? conversations,
    String? selectedConversationId,
    String? searchQuery,
    WorkspaceNetworkState? networkState,
    bool? loading,
    String? message,
    bool clearSelection = false,
    bool clearMessage = false,
  }) {
    return WorkspaceState(
      conversations: conversations ?? this.conversations,
      selectedConversationId: clearSelection
          ? null
          : selectedConversationId ?? this.selectedConversationId,
      searchQuery: searchQuery ?? this.searchQuery,
      networkState: networkState ?? this.networkState,
      loading: loading ?? this.loading,
      message: clearMessage ? null : message ?? this.message,
    );
  }
}

class WorkspaceController extends StateNotifier<WorkspaceState> {
  WorkspaceController({
    required WorkspaceSession session,
    required ConversationRepository repository,
    required NetworkMonitor networkMonitor,
  })  : _session = session,
        _repository = repository,
        _networkMonitor = networkMonitor,
        super(const WorkspaceState()) {
    _networkSubscription = _networkMonitor.changes.listen(_handleNetworkChange);
  }

  final WorkspaceSession _session;
  final ConversationRepository _repository;
  final NetworkMonitor _networkMonitor;
  late final StreamSubscription<NetworkAvailability> _networkSubscription;
  bool _networkAvailable = true;

  Future<void> initialize() async {
    final NetworkAvailability availability = await _networkMonitor.current();
    _networkAvailable = availability == NetworkAvailability.online;
    await refresh();
  }

  Future<void> refresh() async {
    state = state.copyWith(loading: true, clearMessage: true);
    final ConversationLoadResult result = await _repository.load(
      ownerScope: _session.ownerScope,
      cloudEnabled: _session.cloudEnabled,
      networkAvailable: _networkAvailable,
    );
    final String? selected = state.selectedConversationId ??
        (result.items.isEmpty ? null : result.items.first.id);
    state = state.copyWith(
      conversations: result.items,
      selectedConversationId: selected,
      networkState: !_networkAvailable
          ? WorkspaceNetworkState.offline
          : result.degraded
              ? WorkspaceNetworkState.degraded
              : WorkspaceNetworkState.online,
      loading: false,
    );
  }

  Future<void> newConversation() async {
    final ConversationSummary created = await _repository.create(
      ownerScope: _session.ownerScope,
      cloudEnabled: _session.cloudEnabled,
      networkAvailable: _networkAvailable,
    );
    state = state.copyWith(
      conversations: <ConversationSummary>[
        created,
        ...state.conversations.where(
          (ConversationSummary item) => item.id != created.id,
        ),
      ],
      selectedConversationId: created.id,
      clearMessage: true,
    );
  }

  void selectConversation(String id) {
    state = state.copyWith(selectedConversationId: id);
  }

  void clearSelection() {
    state = state.copyWith(clearSelection: true);
  }

  void search(String query) {
    state = state.copyWith(searchQuery: query);
  }

  Future<void> renameConversation(
    ConversationSummary conversation,
    String title,
  ) async {
    final ConversationSummary updated = await _repository.rename(
      conversation: conversation,
      title: title,
      cloudEnabled: _session.cloudEnabled,
      networkAvailable: _networkAvailable,
    );
    state = state.copyWith(
      conversations: state.conversations
          .map(
            (ConversationSummary item) =>
                item.id == updated.id ? updated : item,
          )
          .toList(),
      message: updated.syncState == ConversationSyncState.pendingRename
          ? 'The new title will sync when your connection returns.'
          : null,
      clearMessage: updated.syncState != ConversationSyncState.pendingRename,
    );
  }

  Future<void> deleteConversation(ConversationSummary conversation) async {
    await _repository.delete(
      conversation: conversation,
      cloudEnabled: _session.cloudEnabled,
      networkAvailable: _networkAvailable,
    );
    final List<ConversationSummary> remaining = state.conversations
        .where((ConversationSummary item) => item.id != conversation.id)
        .toList();
    state = state.copyWith(
      conversations: remaining,
      selectedConversationId: remaining.isEmpty ? null : remaining.first.id,
      clearSelection: remaining.isEmpty,
      message: !_networkAvailable && _session.cloudEnabled
          ? 'This conversation will be removed from your account when you reconnect.'
          : null,
      clearMessage: _networkAvailable || !_session.cloudEnabled,
    );
  }

  void _handleNetworkChange(NetworkAvailability availability) {
    final bool wasAvailable = _networkAvailable;
    _networkAvailable = availability == NetworkAvailability.online;
    state = state.copyWith(
      networkState: _networkAvailable
          ? WorkspaceNetworkState.online
          : WorkspaceNetworkState.offline,
    );
    if (!wasAvailable && _networkAvailable) unawaited(refresh());
  }

  @override
  void dispose() {
    unawaited(_networkSubscription.cancel());
    super.dispose();
  }
}
