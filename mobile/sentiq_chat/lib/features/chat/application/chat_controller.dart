import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:sentiq_chat/core/network/api_client.dart';
import 'package:sentiq_chat/core/network/network_status.dart';
import 'package:sentiq_chat/core/network/sse_event.dart';
import 'package:sentiq_chat/features/chat/application/token_batcher.dart';
import 'package:sentiq_chat/features/chat/data/chat_repository.dart';
import 'package:sentiq_chat/features/chat/domain/chat_models.dart';
import 'package:sentiq_chat/features/workspace/application/workspace_controller.dart';
import 'package:uuid/uuid.dart';

class ChatThreadState {
  const ChatThreadState({
    this.messages = const <ChatMessage>[],
    this.progress = const <ChatProgressEvent>[],
    this.loading = false,
    this.loaded = false,
    this.generating = false,
    this.degraded = false,
    this.activeRequestId,
    this.route,
    this.errorMessage,
    this.memoryNotice,
    this.syncNotice,
  });

  final List<ChatMessage> messages;
  final List<ChatProgressEvent> progress;
  final bool loading;
  final bool loaded;
  final bool generating;
  final bool degraded;
  final String? activeRequestId;
  final String? route;
  final String? errorMessage;
  final String? memoryNotice;
  final String? syncNotice;

  ChatMessage? get lastAssistant {
    for (int index = messages.length - 1; index >= 0; index -= 1) {
      if (messages[index].role == ChatMessageRole.assistant) {
        return messages[index];
      }
    }
    return null;
  }

  ChatThreadState copyWith({
    List<ChatMessage>? messages,
    List<ChatProgressEvent>? progress,
    bool? loading,
    bool? loaded,
    bool? generating,
    bool? degraded,
    String? activeRequestId,
    String? route,
    String? errorMessage,
    String? memoryNotice,
    String? syncNotice,
    bool clearActiveRequest = false,
    bool clearRoute = false,
    bool clearError = false,
    bool clearMemoryNotice = false,
    bool clearSyncNotice = false,
  }) {
    return ChatThreadState(
      messages: messages ?? this.messages,
      progress: progress ?? this.progress,
      loading: loading ?? this.loading,
      loaded: loaded ?? this.loaded,
      generating: generating ?? this.generating,
      degraded: degraded ?? this.degraded,
      activeRequestId: clearActiveRequest
          ? null
          : activeRequestId ?? this.activeRequestId,
      route: clearRoute ? null : route ?? this.route,
      errorMessage: clearError ? null : errorMessage ?? this.errorMessage,
      memoryNotice: clearMemoryNotice
          ? null
          : memoryNotice ?? this.memoryNotice,
      syncNotice: clearSyncNotice ? null : syncNotice ?? this.syncNotice,
    );
  }
}

class ChatState {
  const ChatState({
    this.threads = const <String, ChatThreadState>{},
    this.executionMode = ChatExecutionMode.fast,
    this.attachments = const <ChatAttachment>[],
    this.webSearchEnabled = false,
    this.quota = const ChatQuotaState(),
    this.networkAvailable = true,
  });

  final Map<String, ChatThreadState> threads;
  final ChatExecutionMode executionMode;
  final List<ChatAttachment> attachments;
  final bool webSearchEnabled;
  final ChatQuotaState quota;
  final bool networkAvailable;

  ChatThreadState thread(String conversationId) =>
      threads[conversationId] ?? const ChatThreadState();

  bool get attachmentsReady => attachments.every(
    (ChatAttachment item) => !item.uploading && !item.failed,
  );

  ChatState copyWith({
    Map<String, ChatThreadState>? threads,
    ChatExecutionMode? executionMode,
    List<ChatAttachment>? attachments,
    bool? webSearchEnabled,
    ChatQuotaState? quota,
    bool? networkAvailable,
  }) {
    return ChatState(
      threads: threads ?? this.threads,
      executionMode: executionMode ?? this.executionMode,
      attachments: attachments ?? this.attachments,
      webSearchEnabled: webSearchEnabled ?? this.webSearchEnabled,
      quota: quota ?? this.quota,
      networkAvailable: networkAvailable ?? this.networkAvailable,
    );
  }
}

class ChatController extends StateNotifier<ChatState> {
  ChatController({
    required WorkspaceSession session,
    required ChatRepositoryContract repository,
    required NetworkMonitor networkMonitor,
    Uuid uuid = const Uuid(),
  }) : _session = session,
       _repository = repository,
       _networkMonitor = networkMonitor,
       _uuid = uuid,
       super(const ChatState()) {
    _networkSubscription = _networkMonitor.changes.listen(_onNetworkChange);
  }

  final WorkspaceSession _session;
  final ChatRepositoryContract _repository;
  final NetworkMonitor _networkMonitor;
  final Uuid _uuid;
  late final StreamSubscription<NetworkAvailability> _networkSubscription;
  final Map<String, SentIQSseConnection> _connections =
      <String, SentIQSseConnection>{};
  final Set<String> _cancelledRequestIds = <String>{};
  Set<String> _knownRequestIds = <String>{};
  bool _initialized = false;

  Future<void> initialize() async {
    if (_initialized) return;
    _initialized = true;
    final NetworkAvailability availability = await _networkMonitor.current();
    state = state.copyWith(
      networkAvailable: availability == NetworkAvailability.online,
    );
    _knownRequestIds = await _repository.knownRequestIds(_session.ownerScope);
    await Future.wait(<Future<void>>[
      refreshQuota(),
      _repository.syncPending(
        ownerScope: _session.ownerScope,
        cloudEnabled: _session.cloudEnabled,
        networkAvailable: state.networkAvailable,
      ),
    ]);
  }

  Future<void> refreshQuota() async {
    final ChatQuotaState quota = await _repository.quota();
    if (mounted) state = state.copyWith(quota: quota);
  }

  Future<void> loadConversation(
    String conversationId, {
    bool force = false,
  }) async {
    final ChatThreadState current = state.thread(conversationId);
    if (current.loading || (current.loaded && !force)) return;
    _setThread(
      conversationId,
      current.copyWith(loading: true, clearError: true),
    );
    final ChatLoadResult result = await _repository.load(
      ownerScope: _session.ownerScope,
      conversationId: conversationId,
      cloudEnabled: _session.cloudEnabled,
      networkAvailable: state.networkAvailable,
    );
    if (!mounted) return;
    final ChatThreadState latest = state.thread(conversationId);
    final List<ChatMessage> merged = reconcileMessages(
      latest.messages,
      result.messages,
    );
    _setThread(
      conversationId,
      latest.copyWith(
        messages: merged,
        loading: false,
        loaded: true,
        degraded: result.degraded,
      ),
    );
  }

  void setExecutionMode(ChatExecutionMode mode) {
    if (!state.quota.allows(mode)) return;
    state = state.copyWith(executionMode: mode);
  }

  void setWebSearchEnabled(bool enabled) {
    state = state.copyWith(webSearchEnabled: enabled);
  }

  Future<void> addAttachment(ChatAttachment attachment) async {
    if (state.attachments.length >= 10) return;
    ChatAttachment next = attachment;
    if (!attachment.isImage) next = attachment.copyWith(uploading: true);
    state = state.copyWith(
      attachments: <ChatAttachment>[...state.attachments, next],
    );
    if (attachment.isImage) return;
    if (!state.networkAvailable) {
      _replaceAttachment(next.copyWith(uploading: false, failed: true));
      return;
    }
    try {
      final ChatAttachment uploaded = await _repository.upload(attachment);
      if (mounted) _replaceAttachment(uploaded);
    } catch (_) {
      if (mounted) {
        _replaceAttachment(next.copyWith(uploading: false, failed: true));
      }
    }
  }

  void removeAttachment(String id) {
    state = state.copyWith(
      attachments: state.attachments
          .where((ChatAttachment item) => item.id != id)
          .toList(),
    );
  }

  Future<void> retryAttachment(String id) async {
    final ChatAttachment? attachment = _attachment(id);
    if (attachment == null || attachment.isImage) return;
    _replaceAttachment(attachment.copyWith(uploading: true, failed: false));
    try {
      final ChatAttachment uploaded = await _repository.upload(attachment);
      if (mounted) _replaceAttachment(uploaded);
    } catch (_) {
      if (mounted) {
        _replaceAttachment(attachment.copyWith(uploading: false, failed: true));
      }
    }
  }

  Future<bool> send({
    required String conversationId,
    required String text,
    String? trustedDisplayName,
    ChatExecutionMode? executionMode,
    bool preserveAttachments = false,
  }) async {
    final String trimmed = text.trim();
    if (trimmed.isEmpty || !state.attachmentsReady) return false;
    final ChatExecutionMode mode = executionMode ?? state.executionMode;
    if (!state.quota.allows(mode)) return false;
    final ChatThreadState current = state.thread(conversationId);
    if (current.generating) return false;

    String requestId;
    do {
      requestId = _uuid.v4();
    } while (_knownRequestIds.contains(requestId));
    _knownRequestIds.add(requestId);

    final DateTime now = DateTime.now().toUtc();
    final ChatMessage userMessage = ChatMessage(
      id: 'local-user-$requestId',
      conversationId: conversationId,
      role: ChatMessageRole.user,
      content: trimmed,
      createdAt: now,
      status: ChatMessageStatus.pending,
      clientRequestId: requestId,
      executionMode: mode,
      locallyCreated: true,
    );
    final ChatMessage assistantMessage = ChatMessage(
      id: 'local-assistant-$requestId',
      conversationId: conversationId,
      role: ChatMessageRole.assistant,
      content: '',
      createdAt: now.add(const Duration(microseconds: 1)),
      status: ChatMessageStatus.streaming,
      clientRequestId: requestId,
      executionMode: mode,
      locallyCreated: true,
    );
    final List<ChatAttachment> attachments = List<ChatAttachment>.unmodifiable(
      state.attachments,
    );
    final List<ChatMessage> nextMessages = <ChatMessage>[
      ...current.messages,
      userMessage,
      assistantMessage,
    ];
    _setThread(
      conversationId,
      current.copyWith(
        messages: nextMessages,
        progress: const <ChatProgressEvent>[],
        generating: true,
        activeRequestId: requestId,
        clearError: true,
        clearRoute: true,
        clearMemoryNotice: true,
        clearSyncNotice: true,
      ),
    );
    if (!preserveAttachments) {
      state = state.copyWith(attachments: const <ChatAttachment>[]);
    }
    await _repository.saveAll(_session.ownerScope, <ChatMessage>[
      userMessage,
      assistantMessage,
    ]);
    await _repository.recordTurn(
      ownerScope: _session.ownerScope,
      conversationId: conversationId,
      clientRequestId: requestId,
      userMessageId: userMessage.id,
      assistantMessageId: assistantMessage.id,
      executionMode: mode,
      state: 'streaming',
    );

    unawaited(
      _runTurn(
        request: ChatTurnRequest(
          conversationId: conversationId,
          clientRequestId: requestId,
          message: trimmed,
          executionMode: mode,
          recentMessages: current.messages.length <= 50
              ? current.messages
              : current.messages.sublist(current.messages.length - 50),
          attachments: attachments,
          webSearchEnabled: state.webSearchEnabled,
          trustedDisplayName: trustedDisplayName,
        ),
        assistantMessageId: assistantMessage.id,
      ),
    );
    return true;
  }

  Future<void> stop(String conversationId) async {
    final ChatThreadState thread = state.thread(conversationId);
    final String? requestId = thread.activeRequestId;
    if (requestId == null) return;
    _cancelledRequestIds.add(requestId);
    await _connections[requestId]?.cancel();
    await _finalizeTurn(
      conversationId: conversationId,
      requestId: requestId,
      assistantStatus: ChatMessageStatus.cancelled,
      userStatus: ChatMessageStatus.cancelled,
      errorMessage: null,
    );
  }

  Future<void> retry({
    required String conversationId,
    required ChatMessage userMessage,
    String? trustedDisplayName,
  }) async {
    await send(
      conversationId: conversationId,
      text: userMessage.content,
      trustedDisplayName: trustedDisplayName,
      executionMode: userMessage.executionMode,
    );
  }

  Future<void> continueGenerating({
    required String conversationId,
    required ChatMessage partialAssistantMessage,
    String? trustedDisplayName,
  }) async {
    await send(
      conversationId: conversationId,
      text:
          'Continue generating from exactly where the previous response stopped. Do not repeat completed text.',
      trustedDisplayName: trustedDisplayName,
      executionMode: partialAssistantMessage.executionMode,
    );
  }

  Future<void> askAboutSelectedText({
    required String conversationId,
    required String selectedText,
  }) async {
    final String selected = selectedText.trim();
    if (selected.isEmpty || !state.networkAvailable) return;
    final ChatThreadState current = state.thread(conversationId);
    final String requestId = _uuid.v4();
    final DateTime now = DateTime.now().toUtc();
    final ChatMessage user = ChatMessage(
      id: 'selection-user-$requestId',
      conversationId: conversationId,
      role: ChatMessageRole.user,
      content: 'Ask about selected text:\n\n> $selected',
      createdAt: now,
      status: ChatMessageStatus.pending,
      clientRequestId: requestId,
      executionMode: state.executionMode,
      locallyCreated: true,
    );
    final ChatMessage assistant = ChatMessage(
      id: 'selection-assistant-$requestId',
      conversationId: conversationId,
      role: ChatMessageRole.assistant,
      content: '',
      createdAt: now.add(const Duration(microseconds: 1)),
      status: ChatMessageStatus.streaming,
      clientRequestId: requestId,
      executionMode: state.executionMode,
      locallyCreated: true,
    );
    _setThread(
      conversationId,
      current.copyWith(
        messages: <ChatMessage>[...current.messages, user, assistant],
        generating: true,
        activeRequestId: requestId,
        clearError: true,
      ),
    );
    await _repository.saveAll(_session.ownerScope, <ChatMessage>[
      user,
      assistant,
    ]);
    try {
      final Map<String, Object?> payload = await _repository.askAboutSelection(
        conversationId: conversationId,
        selectedText: selected,
        recentMessages: current.messages.length <= 50
            ? current.messages
            : current.messages.sublist(current.messages.length - 50),
      );
      final String answer = _answerFrom(payload);
      _replaceMessage(
        conversationId,
        assistant.id,
        assistant.copyWith(
          content: answer,
          status: ChatMessageStatus.complete,
          locallyCreated: !_session.cloudEnabled,
        ),
      );
      _replaceMessage(
        conversationId,
        user.id,
        user.copyWith(
          status: ChatMessageStatus.complete,
          locallyCreated: !_session.cloudEnabled,
        ),
      );
      await _finalizeTurn(
        conversationId: conversationId,
        requestId: requestId,
        assistantStatus: ChatMessageStatus.complete,
        userStatus: ChatMessageStatus.complete,
        errorMessage: null,
      );
    } catch (error) {
      await _finalizeTurn(
        conversationId: conversationId,
        requestId: requestId,
        assistantStatus: ChatMessageStatus.failed,
        userStatus: ChatMessageStatus.failed,
        errorMessage: _friendlyError(error),
      );
    }
  }

  Future<void> handleLifecycle(AppLifecycleState lifecycleState) async {
    if (lifecycleState == AppLifecycleState.paused ||
        lifecycleState == AppLifecycleState.detached) {
      for (final MapEntry<String, ChatThreadState> entry
          in state.threads.entries) {
        if (entry.value.generating) {
          await _repository.saveAll(_session.ownerScope, entry.value.messages);
        }
      }
      return;
    }
    if (lifecycleState == AppLifecycleState.resumed) {
      await _repository.syncPending(
        ownerScope: _session.ownerScope,
        cloudEnabled: _session.cloudEnabled,
        networkAvailable: state.networkAvailable,
      );
      for (final String conversationId in state.threads.keys) {
        if (!state.thread(conversationId).generating) {
          await loadConversation(conversationId, force: true);
        }
      }
      await refreshQuota();
    }
  }

  Future<void> _runTurn({
    required ChatTurnRequest request,
    required String assistantMessageId,
  }) async {
    bool done = false;
    bool receivedContent = false;
    String? terminalError;
    final TokenBatcher batcher = TokenBatcher(
      onFlush: (String text) {
        receivedContent = true;
        _appendAssistantText(request.conversationId, assistantMessageId, text);
      },
    );
    try {
      final SentIQSseConnection connection = await _repository.stream(request);
      _connections[request.clientRequestId] = connection;
      await for (final SentIQSseEvent event in connection.events) {
        if (_cancelledRequestIds.contains(request.clientRequestId)) break;
        if (event.unsupportedVersion) {
          _addProgress(
            request.conversationId,
            ChatProgressEvent(
              kind: ChatProgressKind.sync,
              label: 'A newer stream event was safely skipped',
              timestamp: DateTime.now().toUtc(),
              payload: event.payload,
            ),
          );
          continue;
        }
        switch (event.kind) {
          case SentIQSseEventKind.token:
          case SentIQSseEventKind.fileToken:
            batcher.add((event.payload['text'] ?? '').toString());
            break;
          case SentIQSseEventKind.fileArtifact:
            _addProgress(
              request.conversationId,
              _progressFrom(
                ChatProgressKind.toolResult,
                'File ready',
                event.payload,
                terminal: true,
              ),
            );
            break;
          case SentIQSseEventKind.thinking:
            _addProgress(
              request.conversationId,
              _progressFrom(
                ChatProgressKind.thinking,
                'Thinking',
                event.payload,
              ),
            );
            break;
          case SentIQSseEventKind.structuredResponse:
            final Map<String, Object?> structured = _map(
              event.payload['response'] ?? event.payload,
            );
            final String answer = _answerFrom(structured);
            if (answer.isNotEmpty) batcher.add(answer);
            _mergeAssistantMetadata(
              request.conversationId,
              assistantMessageId,
              structured,
            );
            done = true;
            break;
          case SentIQSseEventKind.route:
            final String route =
                (event.payload['route'] ?? event.payload['value'] ?? 'chat')
                    .toString();
            final ChatThreadState thread = state.thread(request.conversationId);
            _setThread(request.conversationId, thread.copyWith(route: route));
            _addProgress(
              request.conversationId,
              _progressFrom(
                ChatProgressKind.route,
                _routeLabel(route),
                event.payload,
              ),
            );
            break;
          case SentIQSseEventKind.toolSelected:
            _addProgress(
              request.conversationId,
              _progressFrom(
                ChatProgressKind.toolSelected,
                'Preparing the right tool',
                event.payload,
              ),
            );
            break;
          case SentIQSseEventKind.toolStarted:
            _addProgress(
              request.conversationId,
              _progressFrom(
                ChatProgressKind.toolStarted,
                'Working with the selected tool',
                event.payload,
              ),
            );
            break;
          case SentIQSseEventKind.toolResult:
            _addProgress(
              request.conversationId,
              _progressFrom(
                ChatProgressKind.toolResult,
                'Tool completed',
                event.payload,
                terminal: true,
              ),
            );
            break;
          case SentIQSseEventKind.toolError:
            _addProgress(
              request.conversationId,
              _progressFrom(
                ChatProgressKind.toolError,
                'A tool could not finish',
                event.payload,
                terminal: true,
                error: true,
              ),
            );
            break;
          case SentIQSseEventKind.webSurfSources:
          case SentIQSseEventKind.webSurfComplete:
            _addProgress(
              request.conversationId,
              _progressFrom(
                ChatProgressKind.sources,
                event.kind == SentIQSseEventKind.webSurfComplete
                    ? 'Sources checked'
                    : 'Checking sources',
                event.payload,
                terminal: event.kind == SentIQSseEventKind.webSurfComplete,
              ),
            );
            _mergeCitations(
              request.conversationId,
              assistantMessageId,
              event.payload,
            );
            break;
          case SentIQSseEventKind.memory:
            final String notice = _eventText(
              event.payload,
              fallback: 'Memory updated',
            );
            _setThread(
              request.conversationId,
              state
                  .thread(request.conversationId)
                  .copyWith(memoryNotice: notice),
            );
            _addProgress(
              request.conversationId,
              _progressFrom(
                ChatProgressKind.memory,
                notice,
                event.payload,
                terminal: true,
              ),
            );
            break;
          case SentIQSseEventKind.sync:
            final String notice = _eventText(
              _map(event.payload['sync'] ?? event.payload),
              fallback: 'Conversation synced',
            );
            _setThread(
              request.conversationId,
              state.thread(request.conversationId).copyWith(syncNotice: notice),
            );
            _addProgress(
              request.conversationId,
              _progressFrom(
                ChatProgressKind.sync,
                notice,
                event.payload,
                terminal: true,
              ),
            );
            break;
          case SentIQSseEventKind.fileAnalysis:
            _addProgress(
              request.conversationId,
              _progressFrom(
                ChatProgressKind.fileAnalysis,
                'Reading attachment',
                event.payload,
              ),
            );
            break;
          case SentIQSseEventKind.deepResearch:
            _addProgress(
              request.conversationId,
              _progressFrom(
                ChatProgressKind.deepResearch,
                _eventText(event.payload, fallback: 'Researching'),
                event.payload,
                terminal:
                    event.type == 'deep_research_complete' ||
                    event.type == 'deep_research_error',
                error: event.type == 'deep_research_error',
              ),
            );
            break;
          case SentIQSseEventKind.error:
            terminalError = _eventText(
              event.payload,
              fallback: 'The response could not finish.',
            );
            break;
          case SentIQSseEventKind.done:
            done = true;
            break;
          case SentIQSseEventKind.unknown:
            break;
        }
        if (terminalError != null || done) break;
      }
    } catch (error) {
      if (!_cancelledRequestIds.contains(request.clientRequestId)) {
        terminalError = _friendlyError(error);
      }
    } finally {
      batcher.close();
      _connections.remove(request.clientRequestId);
    }

    if (_cancelledRequestIds.remove(request.clientRequestId)) return;
    final ChatMessage? assistant = _message(
      request.conversationId,
      assistantMessageId,
    );
    receivedContent =
        receivedContent || (assistant?.content.trim().isNotEmpty ?? false);
    final ChatMessageStatus assistantStatus = terminalError != null
        ? (receivedContent
              ? ChatMessageStatus.interrupted
              : ChatMessageStatus.failed)
        : done
        ? ChatMessageStatus.complete
        : receivedContent
        ? ChatMessageStatus.interrupted
        : ChatMessageStatus.failed;
    await _finalizeTurn(
      conversationId: request.conversationId,
      requestId: request.clientRequestId,
      assistantStatus: assistantStatus,
      userStatus: terminalError == null
          ? ChatMessageStatus.complete
          : ChatMessageStatus.failed,
      errorMessage:
          terminalError ??
          (done ? null : 'The connection ended before the response completed.'),
    );
    unawaited(refreshQuota());
  }

  Future<void> _finalizeTurn({
    required String conversationId,
    required String requestId,
    required ChatMessageStatus assistantStatus,
    required ChatMessageStatus userStatus,
    required String? errorMessage,
  }) async {
    final ChatThreadState thread = state.thread(conversationId);
    final List<ChatMessage> messages = thread.messages.map((
      ChatMessage message,
    ) {
      if (message.clientRequestId != requestId) return message;
      final ChatMessageStatus status = message.role == ChatMessageRole.assistant
          ? assistantStatus
          : userStatus;
      return message.copyWith(
        status: status,
        errorMessage: message.role == ChatMessageRole.assistant
            ? errorMessage
            : null,
        clearError: errorMessage == null,
        locallyCreated:
            !_session.cloudEnabled ||
            !state.networkAvailable ||
            status == ChatMessageStatus.interrupted ||
            status == ChatMessageStatus.cancelled ||
            status == ChatMessageStatus.failed,
      );
    }).toList();
    _setThread(
      conversationId,
      thread.copyWith(
        messages: messages,
        generating: false,
        errorMessage: errorMessage,
        clearError: errorMessage == null,
        clearActiveRequest: true,
      ),
    );
    await _repository.saveAll(_session.ownerScope, messages);
    await _repository.updateTurnState(requestId, assistantStatus.name);
  }

  void _appendAssistantText(
    String conversationId,
    String messageId,
    String text,
  ) {
    final ChatMessage? message = _message(conversationId, messageId);
    if (message == null) return;
    final ChatMessage updated = message.copyWith(
      content: '${message.content}$text',
      status: ChatMessageStatus.streaming,
      clearError: true,
    );
    _replaceMessage(conversationId, messageId, updated);
    unawaited(_repository.save(_session.ownerScope, updated));
  }

  void _mergeAssistantMetadata(
    String conversationId,
    String messageId,
    Map<String, Object?> metadata,
  ) {
    final ChatMessage? message = _message(conversationId, messageId);
    if (message == null) return;
    _replaceMessage(
      conversationId,
      messageId,
      message.copyWith(
        metadata: <String, Object?>{...message.metadata, ...metadata},
      ),
    );
  }

  void _mergeCitations(
    String conversationId,
    String messageId,
    Map<String, Object?> payload,
  ) {
    final ChatMessage? message = _message(conversationId, messageId);
    if (message == null) return;
    final Object? raw = payload['sources'] ?? payload['citations'];
    if (raw is! List) return;
    final List<ChatCitation> citations = raw
        .whereType<Map>()
        .toList()
        .asMap()
        .entries
        .map(
          (MapEntry<int, Map> entry) => ChatCitation.fromJson(
            entry.value.map(
              (Object? key, Object? value) => MapEntry(key.toString(), value),
            ),
            entry.key,
          ),
        )
        .toList();
    _replaceMessage(
      conversationId,
      messageId,
      message.copyWith(citations: citations),
    );
  }

  void _replaceMessage(
    String conversationId,
    String messageId,
    ChatMessage replacement,
  ) {
    final ChatThreadState thread = state.thread(conversationId);
    _setThread(
      conversationId,
      thread.copyWith(
        messages: thread.messages
            .map(
              (ChatMessage message) =>
                  message.id == messageId ? replacement : message,
            )
            .toList(),
      ),
    );
  }

  ChatMessage? _message(String conversationId, String messageId) {
    for (final ChatMessage message in state.thread(conversationId).messages) {
      if (message.id == messageId) return message;
    }
    return null;
  }

  void _addProgress(String conversationId, ChatProgressEvent event) {
    final ChatThreadState thread = state.thread(conversationId);
    final List<ChatProgressEvent> progress = <ChatProgressEvent>[
      ...thread.progress,
      event,
    ];
    _setThread(
      conversationId,
      thread.copyWith(
        progress: progress.length <= 12
            ? progress
            : progress.sublist(progress.length - 12),
      ),
    );
  }

  void _setThread(String conversationId, ChatThreadState thread) {
    if (!mounted) return;
    state = state.copyWith(
      threads: <String, ChatThreadState>{
        ...state.threads,
        conversationId: thread,
      },
    );
  }

  void _replaceAttachment(ChatAttachment replacement) {
    state = state.copyWith(
      attachments: state.attachments
          .map(
            (ChatAttachment item) =>
                item.id == replacement.id ? replacement : item,
          )
          .toList(),
    );
  }

  ChatAttachment? _attachment(String id) {
    for (final ChatAttachment item in state.attachments) {
      if (item.id == id) return item;
    }
    return null;
  }

  void _onNetworkChange(NetworkAvailability availability) {
    final bool available = availability == NetworkAvailability.online;
    state = state.copyWith(networkAvailable: available);
    if (available) {
      unawaited(
        _repository.syncPending(
          ownerScope: _session.ownerScope,
          cloudEnabled: _session.cloudEnabled,
          networkAvailable: true,
        ),
      );
      unawaited(refreshQuota());
    }
  }

  @override
  void dispose() {
    for (final SentIQSseConnection connection in _connections.values) {
      unawaited(connection.cancel());
    }
    unawaited(_networkSubscription.cancel());
    super.dispose();
  }
}

ChatProgressEvent _progressFrom(
  ChatProgressKind kind,
  String label,
  Map<String, Object?> payload, {
  bool terminal = false,
  bool error = false,
}) {
  return ChatProgressEvent(
    kind: kind,
    label: label,
    detail: _eventText(payload),
    timestamp: DateTime.now().toUtc(),
    payload: payload,
    terminal: terminal,
    error: error,
  );
}

String _eventText(Map<String, Object?> payload, {String fallback = ''}) {
  final Object? raw =
      payload['text'] ??
      payload['message'] ??
      payload['status'] ??
      payload['detail'] ??
      payload['error'];
  final String value = raw?.toString().trim() ?? '';
  return value.isEmpty ? fallback : value;
}

String _routeLabel(String route) {
  return switch (route) {
    'reasoning' || 'math_reasoning' => 'Reasoning through the problem',
    'web_search' => 'Searching the web',
    'file_generation' => 'Preparing a file',
    'chart_generation' => 'Preparing a visualization',
    'image_generation' => 'Preparing an image',
    'memory' => 'Updating memory',
    _ => 'Preparing a response',
  };
}

String _answerFrom(Map<String, Object?> payload) {
  final Object? raw =
      payload['answer'] ??
      payload['response'] ??
      payload['content'] ??
      payload['text'] ??
      payload['message'];
  if (raw is Map) return _answerFrom(_map(raw));
  return raw?.toString() ?? '';
}

String _friendlyError(Object error) {
  final String raw = error.toString().replaceFirst('Exception: ', '').trim();
  if (raw.isEmpty) return 'The response could not finish. Please try again.';
  return raw;
}

Map<String, Object?> _map(Object? value) {
  if (value is! Map) return <String, Object?>{};
  return value.map(
    (Object? key, Object? nested) => MapEntry(key.toString(), nested),
  );
}
