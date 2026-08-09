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

  static const List<Duration> _retryDelays = <Duration>[
    Duration(seconds: 1),
    Duration(seconds: 3),
    Duration(seconds: 8),
    Duration(seconds: 20),
    Duration(seconds: 60),
  ];

  final WorkspaceSession _session;
  final ConversationRepository _repository;
  final NetworkMonitor _networkMonitor;
  late final StreamSubscription<NetworkAvailability> _networkSubscription;
  bool _networkAvailable = true;
  bool _refreshRequested = false;
  bool _disposed = false;
  Future<void>? _refreshFuture;
  Timer? _retryTimer;
  int _retryAttempt = 0;
  Timer? _titleRepairRefreshTimer;

  Future<void> initialize() async {
    final NetworkAvailability availability = await _networkMonitor.current();
    _networkAvailable = availability == NetworkAvailability.online;

    // Paint durable local state first. A signed-in user with a populated cache
    // should not wait for the network. After reinstall/storage clear there is
    // no durable local truth, so keep the loading state until the first cloud
    // reconciliation has had a chance to restore server history.
    final ConversationLoadResult cached = await _repository.load(
      ownerScope: _session.ownerScope,
      cloudEnabled: _session.cloudEnabled,
      networkAvailable: false,
    );
    final String? selected = cached.items.isEmpty ? null : cached.items.first.id;
    final bool awaitingInitialCloud =
        cached.items.isEmpty && _session.cloudEnabled && _networkAvailable;
    state = state.copyWith(
      conversations: cached.items,
      selectedConversationId: selected,
      clearSelection: selected == null,
      networkState: _networkAvailable
          ? WorkspaceNetworkState.online
          : WorkspaceNetworkState.offline,
      loading: awaitingInitialCloud,
      clearMessage: true,
    );

    if (_session.cloudEnabled && _networkAvailable) {
      if (awaitingInitialCloud) {
        await refresh();
      } else {
        unawaited(refresh());
      }
    }
  }

  /// Coalesces refresh requests instead of dropping them.
  ///
  /// The old `_refreshing` guard returned immediately when a refresh was in
  /// flight. A newly-created local conversation could therefore miss its only
  /// cloud replay if startup reconciliation happened to overlap the tap. Every
  /// request now guarantees at least one pass after the request was observed.
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

    final bool selectedStillExists = state.selectedConversationId != null &&
        result.items.any(
          (ConversationSummary item) => item.id == state.selectedConversationId,
        );
    final String? selected = selectedStillExists
        ? state.selectedConversationId
        : (result.items.isEmpty ? null : result.items.first.id);
    state = state.copyWith(
      conversations: result.items,
      selectedConversationId: selected,
      clearSelection: selected == null,
      networkState: !_networkAvailable
          ? WorkspaceNetworkState.offline
          : result.degraded
          ? WorkspaceNetworkState.degraded
          : WorkspaceNetworkState.online,
      loading: false,
    );

    if (_networkAvailable && _session.cloudEnabled && result.degraded) {
      _scheduleRetry();
    } else if (!result.degraded) {
      _resetRetry();
    }
    _scheduleTitleRepairRefresh(result.items);
  }

  Future<void> newConversation() async {
    // Create and select locally first. The repository replays the exact UUID to
    // the backend so chat streaming and conversation-list sync share one
    // identity even if the network response arrives later.
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
      loading: false,
    );
    if (_session.cloudEnabled && _networkAvailable) {
      await refresh();
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
      message: !_networkAvailable && _session.cloudEnabled
          ? 'The new title will update when you reconnect.'
          : null,
      clearMessage: _networkAvailable || !_session.cloudEnabled,
    );
    if (_session.cloudEnabled && _networkAvailable) {
      await refresh();
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
      message: !_networkAvailable && _session.cloudEnabled
          ? 'This conversation will be removed when you reconnect.'
          : null,
      clearMessage: _networkAvailable || !_session.cloudEnabled,
      loading: false,
    );
    if (_session.cloudEnabled && _networkAvailable) {
      await refresh();
    }
  }

  void _scheduleRetry() {
    if (_retryTimer != null ||
        !_networkAvailable ||
        !_session.cloudEnabled ||
        _disposed) {
      return;
    }
    final int index = _retryAttempt < _retryDelays.length
        ? _retryAttempt
        : _retryDelays.length - 1;
    final Duration delay = _retryDelays[index];
    if (_retryAttempt < _retryDelays.length - 1) _retryAttempt += 1;
    _retryTimer = Timer(delay, () {
      _retryTimer = null;
      if (!_disposed && _networkAvailable) unawaited(refresh());
    });
  }

  void _resetRetry() {
    _retryTimer?.cancel();
    _retryTimer = null;
    _retryAttempt = 0;
  }

  void _scheduleTitleRepairRefresh(List<ConversationSummary> conversations) {
    final bool hasRepairCandidate = conversations.any(
      (ConversationSummary item) =>
          item.messageCount >= 2 && item.needsGeneratedTitle,
    );
    if (!hasRepairCandidate ||
        !_networkAvailable ||
        !_session.cloudEnabled ||
        _disposed) {
      _titleRepairRefreshTimer?.cancel();
      _titleRepairRefreshTimer = null;
      return;
    }
    if (_titleRepairRefreshTimer != null) return;

    // `/api/chat/title` has a bounded backend generation timeout. Re-read after
    // that window so the asynchronously persisted summarized title becomes
    // visible without requiring an app restart or manual refresh.
    _titleRepairRefreshTimer = Timer(const Duration(seconds: 13), () {
      _titleRepairRefreshTimer = null;
      if (!_disposed && _networkAvailable) unawaited(refresh());
    });
  }

  void _handleNetworkChange(NetworkAvailability availability) {
    final bool wasAvailable = _networkAvailable;
    _networkAvailable = availability == NetworkAvailability.online;
    if (!_networkAvailable) {
      _retryTimer?.cancel();
      _retryTimer = null;
    }
    state = state.copyWith(
      networkState: _networkAvailable
          ? WorkspaceNetworkState.online
          : WorkspaceNetworkState.offline,
    );
    if (!wasAvailable && _networkAvailable) unawaited(refresh());
  }

  @override
  void dispose() {
    _disposed = true;
    _retryTimer?.cancel();
    _titleRepairRefreshTimer?.cancel();
    unawaited(_networkSubscription.cancel());
    super.dispose();
  }
}
