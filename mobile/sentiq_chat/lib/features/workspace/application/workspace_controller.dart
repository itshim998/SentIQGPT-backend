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
  }) : _session = session,
       _repository = repository,
       _networkMonitor = networkMonitor,
       super(const WorkspaceState()) {
    _networkSubscription = _networkMonitor.changes.listen(_handleNetworkChange);
  }

  static const int startupCachedConversationCount = 5;

  final WorkspaceSession _session;
  final ConversationRepository _repository;
  final NetworkMonitor _networkMonitor;
  late final StreamSubscription<NetworkAvailability> _networkSubscription;
  bool _networkAvailable = true;
  bool _refreshRequested = false;
  bool _disposed = false;
  bool _initialCloudHydrationPending = false;
  Future<void>? _refreshFuture;

  Future<void> initialize() async {
    final NetworkAvailability availability = await _networkMonitor.current();
    _networkAvailable = availability == NetworkAvailability.online;

    // Only the five most recent cached conversations are painted during cold
    // start. They provide an instant drawer while the authoritative server list
    // is restored. SQLite may retain additional rows for offline durability and
    // pending-operation safety, but they are not surfaced as current history
    // until a successful cloud snapshot confirms them.
    final ConversationLoadResult cached = await _repository.load(
      ownerScope: _session.ownerScope,
      cloudEnabled: _session.cloudEnabled,
      networkAvailable: false,
    );
    final List<ConversationSummary> instant = cached.items
        .take(startupCachedConversationCount)
        .toList(growable: false);
    final String? selected = instant.isEmpty ? null : instant.first.id;
    _initialCloudHydrationPending = _session.cloudEnabled;

    state = state.copyWith(
      conversations: instant,
      selectedConversationId: selected,
      clearSelection: selected == null,
      networkState: _networkAvailable
          ? WorkspaceNetworkState.online
          : WorkspaceNetworkState.offline,
      loading: _initialCloudHydrationPending && _networkAvailable,
      clearMessage: true,
    );

    if (_session.cloudEnabled && _networkAvailable) {
      if (instant.isEmpty) {
        await refresh();
      } else {
        unawaited(refresh());
      }
    }
  }

  /// Coalesces event-driven refresh requests instead of dropping them.
  ///
  /// Reconciliation is intentionally triggered by meaningful events (startup,
  /// app resume, reconnect, local conversation actions and query lifecycle), not
  /// by fixed polling intervals. Multiple simultaneous triggers collapse into
  /// the smallest number of cloud-list requests needed to reach the latest state.
  Future<void> refresh() {
    if (_disposed) return Future<void>.value();
    _refreshRequested = true;
    final Future<void>? running = _refreshFuture;
    if (running != null) return running;
    final Future<void> future = _drainRefreshQueue();
    _refreshFuture = future;
    return future;
  }

  Future<void> _drainRefreshQueue() async {
    try {
      while (_refreshRequested && !_disposed) {
        _refreshRequested = false;
        await _refreshOnce();
      }
    } finally {
      _refreshFuture = null;
      if (_refreshRequested && !_disposed) unawaited(refresh());
    }
  }

  Future<void> _refreshOnce() async {
    final ConversationLoadResult result = await _repository.load(
      ownerScope: _session.ownerScope,
      cloudEnabled: _session.cloudEnabled,
      networkAvailable: _networkAvailable,
    );
    if (_disposed) return;

    // During first hydration, a failed server request returns the durable cache.
    // Keep only the already-painted five rows and the loader instead of making a
    // stale 50-row cache look authoritative. The next event will retry silently.
    if (_initialCloudHydrationPending &&
        _session.cloudEnabled &&
        _networkAvailable &&
        result.fromCache) {
      state = state.copyWith(
        networkState: WorkspaceNetworkState.online,
        loading: true,
        clearMessage: true,
      );
      return;
    }

    if (_session.cloudEnabled && _networkAvailable && !result.fromCache) {
      _initialCloudHydrationPending = false;
    }

    final List<ConversationSummary> conversations = _preservePendingLocalRows(
      result.items,
    );
    final bool selectedStillExists = state.selectedConversationId != null &&
        conversations.any(
          (ConversationSummary item) => item.id == state.selectedConversationId,
        );
    final String? selected = selectedStillExists
        ? state.selectedConversationId
        : (conversations.isEmpty ? null : conversations.first.id);
    state = state.copyWith(
      conversations: conversations,
      selectedConversationId: selected,
      clearSelection: selected == null,
      // A transient cloud request/replay failure is an internal recovery state,
      // not user-facing product language. Only actual connectivity loss changes
      // the visible network state.
      networkState: _networkAvailable
          ? WorkspaceNetworkState.online
          : WorkspaceNetworkState.offline,
      loading: _initialCloudHydrationPending && _networkAvailable,
      clearMessage: true,
    );
  }

  List<ConversationSummary> _preservePendingLocalRows(
    List<ConversationSummary> incoming,
  ) {
    final Set<String> incomingIds = incoming
        .map((ConversationSummary item) => item.id)
        .toSet();
    final List<ConversationSummary> pending = state.conversations
        .where(
          (ConversationSummary item) =>
              item.syncState != ConversationSyncState.synced &&
              !incomingIds.contains(item.id),
        )
        .toList(growable: false);
    if (pending.isEmpty) return incoming;
    return <ConversationSummary>[
      ...pending,
      ...incoming,
    ].take(50).toList(growable: false);
  }

  Future<void> newConversation() async {
    final ConversationSummary created = await _repository.create(
      ownerScope: _session.ownerScope,
      cloudEnabled: _session.cloudEnabled,
      networkAvailable: false,
    );
    if (_disposed) return;
    state = state.copyWith(
      conversations: <ConversationSummary>[
        created,
        ...state.conversations.where(
          (ConversationSummary item) => item.id != created.id,
        ),
      ].take(50).toList(growable: false),
      selectedConversationId: created.id,
      clearMessage: true,
    );
    if (_session.cloudEnabled && _networkAvailable) {
      unawaited(refresh());
    }
  }

  void selectConversation(String id) {
    state = state.copyWith(selectedConversationId: id, clearMessage: true);
  }

  void clearSelection() {
    state = state.copyWith(clearSelection: true, clearMessage: true);
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
      networkAvailable: false,
    );
    if (_disposed) return;
    state = state.copyWith(
      conversations: state.conversations
          .map(
            (ConversationSummary item) =>
                item.id == updated.id ? updated : item,
          )
          .toList(),
      clearMessage: true,
    );
    if (_session.cloudEnabled && _networkAvailable) {
      unawaited(refresh());
    }
  }

  Future<void> deleteConversation(ConversationSummary conversation) async {
    await _repository.delete(
      conversation: conversation,
      cloudEnabled: _session.cloudEnabled,
      networkAvailable: false,
    );
    if (_disposed) return;
    final List<ConversationSummary> remaining = state.conversations
        .where((ConversationSummary item) => item.id != conversation.id)
        .toList();
    state = state.copyWith(
      conversations: remaining,
      selectedConversationId: remaining.isEmpty ? null : remaining.first.id,
      clearSelection: remaining.isEmpty,
      clearMessage: true,
    );
    if (_session.cloudEnabled && _networkAvailable) {
      unawaited(refresh());
    }
  }

  void _handleNetworkChange(NetworkAvailability availability) {
    final bool wasAvailable = _networkAvailable;
    _networkAvailable = availability == NetworkAvailability.online;
    state = state.copyWith(
      networkState: _networkAvailable
          ? WorkspaceNetworkState.online
          : WorkspaceNetworkState.offline,
      loading: _initialCloudHydrationPending && _networkAvailable,
      clearMessage: true,
    );
    if (!wasAvailable && _networkAvailable) unawaited(refresh());
  }

  @override
  void dispose() {
    _disposed = true;
    unawaited(_networkSubscription.cancel());
    super.dispose();
  }
}
