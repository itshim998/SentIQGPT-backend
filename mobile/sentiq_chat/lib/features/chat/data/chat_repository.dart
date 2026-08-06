import 'package:sentiq_chat/core/network/api_client.dart';
import 'package:sentiq_chat/features/chat/data/chat_cache.dart';
import 'package:sentiq_chat/features/chat/data/chat_remote_source.dart';
import 'package:sentiq_chat/features/chat/domain/chat_models.dart';

class ChatLoadResult {
  const ChatLoadResult({
    required this.messages,
    required this.fromCache,
    required this.degraded,
  });

  final List<ChatMessage> messages;
  final bool fromCache;
  final bool degraded;
}

abstract interface class ChatRepositoryContract {
  Future<ChatLoadResult> load({
    required String ownerScope,
    required String conversationId,
    required bool cloudEnabled,
    required bool networkAvailable,
  });
  Future<void> save(String ownerScope, ChatMessage message);
  Future<void> saveAll(String ownerScope, List<ChatMessage> messages);
  Future<void> recordTurn({
    required String ownerScope,
    required String conversationId,
    required String clientRequestId,
    required String userMessageId,
    required String assistantMessageId,
    required ChatExecutionMode executionMode,
    required String state,
  });
  Future<void> updateTurnState(String clientRequestId, String state);
  Future<Set<String>> knownRequestIds(String ownerScope);
  Future<SentIQSseConnection> stream(ChatTurnRequest request);
  Future<ChatAttachment> upload(ChatAttachment attachment);
  Future<Map<String, Object?>> askAboutSelection({
    required String conversationId,
    required String selectedText,
    required List<ChatMessage> recentMessages,
  });
  Future<ChatQuotaState> quota();
  Future<void> syncPending({
    required String ownerScope,
    required bool cloudEnabled,
    required bool networkAvailable,
  });
}

class ChatRepository implements ChatRepositoryContract {
  const ChatRepository({
    required ChatCache cache,
    required ChatRemoteSource remote,
  }) : _cache = cache,
       _remote = remote;

  final ChatCache _cache;
  final ChatRemoteSource _remote;

  Future<ChatLoadResult> load({
    required String ownerScope,
    required String conversationId,
    required bool cloudEnabled,
    required bool networkAvailable,
  }) async {
    final List<ChatMessage> cached = await _cache.listMessages(
      ownerScope: ownerScope,
      conversationId: conversationId,
    );
    if (!cloudEnabled || !networkAvailable) {
      return ChatLoadResult(
        messages: cached,
        fromCache: true,
        degraded: cloudEnabled && !networkAvailable,
      );
    }
    try {
      final List<ChatMessage> cloud = await _remote.loadMessages(
        conversationId,
      );
      final List<ChatMessage> merged = reconcileMessages(cached, cloud);
      await _cache.upsertMessages(ownerScope: ownerScope, messages: merged);
      return ChatLoadResult(
        messages: merged,
        fromCache: false,
        degraded: false,
      );
    } catch (_) {
      return ChatLoadResult(messages: cached, fromCache: true, degraded: true);
    }
  }

  Future<void> save(String ownerScope, ChatMessage message) {
    return _cache.upsertMessage(ownerScope: ownerScope, message: message);
  }

  Future<void> saveAll(String ownerScope, List<ChatMessage> messages) {
    return _cache.upsertMessages(ownerScope: ownerScope, messages: messages);
  }

  Future<void> recordTurn({
    required String ownerScope,
    required String conversationId,
    required String clientRequestId,
    required String userMessageId,
    required String assistantMessageId,
    required ChatExecutionMode executionMode,
    required String state,
  }) {
    return _cache.recordTurn(
      ownerScope: ownerScope,
      conversationId: conversationId,
      clientRequestId: clientRequestId,
      userMessageId: userMessageId,
      assistantMessageId: assistantMessageId,
      executionMode: executionMode,
      state: state,
    );
  }

  Future<void> updateTurnState(String clientRequestId, String state) {
    return _cache.updateTurnState(clientRequestId, state);
  }

  Future<Set<String>> knownRequestIds(String ownerScope) {
    return _cache.knownRequestIds(ownerScope);
  }

  Future<SentIQSseConnection> stream(ChatTurnRequest request) {
    return _remote.stream(request);
  }

  Future<ChatAttachment> upload(ChatAttachment attachment) {
    return _remote.upload(attachment);
  }

  Future<Map<String, Object?>> askAboutSelection({
    required String conversationId,
    required String selectedText,
    required List<ChatMessage> recentMessages,
  }) {
    return _remote.askAboutSelection(
      conversationId: conversationId,
      selectedText: selectedText,
      recentMessages: recentMessages,
    );
  }

  Future<ChatQuotaState> quota() => _remote.quota();

  Future<void> syncPending({
    required String ownerScope,
    required bool cloudEnabled,
    required bool networkAvailable,
  }) async {
    if (!cloudEnabled || !networkAvailable) return;
    final List<ChatMessage> pending = await _cache.pendingMessages(ownerScope);
    final Map<String, List<ChatMessage>> byConversation =
        <String, List<ChatMessage>>{};
    for (final ChatMessage message in pending) {
      byConversation
          .putIfAbsent(message.conversationId, () => <ChatMessage>[])
          .add(message);
    }
    for (final MapEntry<String, List<ChatMessage>> entry
        in byConversation.entries) {
      try {
        await _remote.sync(conversationId: entry.key, messages: entry.value);
        for (final ChatMessage message in entry.value) {
          await save(
            ownerScope,
            message.copyWith(
              status: message.status == ChatMessageStatus.syncing
                  ? ChatMessageStatus.complete
                  : message.status,
              locallyCreated: false,
            ),
          );
        }
      } catch (_) {
        // Pending messages remain durable and retry on the next network/lifecycle edge.
      }
    }
  }
}

List<ChatMessage> reconcileMessages(
  List<ChatMessage> local,
  List<ChatMessage> cloud,
) {
  final Map<String, ChatMessage> byKey = <String, ChatMessage>{};
  String key(ChatMessage message) {
    final String? requestId = message.clientRequestId;
    if (requestId != null && requestId.isNotEmpty) {
      return '${message.role.name}:$requestId';
    }
    return 'id:${message.id}';
  }

  for (final ChatMessage message in cloud) {
    byKey[key(message)] = message;
  }
  for (final ChatMessage message in local) {
    final String messageKey = key(message);
    final ChatMessage? remote = byKey[messageKey];
    final bool preserveLocal =
        message.locallyCreated &&
        (remote == null ||
            message.status == ChatMessageStatus.streaming ||
            message.status == ChatMessageStatus.pending ||
            message.status == ChatMessageStatus.interrupted ||
            message.status == ChatMessageStatus.cancelled);
    if (preserveLocal) byKey[messageKey] = message;
  }
  final List<ChatMessage> merged = byKey.values.toList()
    ..sort((ChatMessage a, ChatMessage b) {
      final int time = a.createdAt.compareTo(b.createdAt);
      if (time != 0) return time;
      return a.id.compareTo(b.id);
    });
  return merged;
}
