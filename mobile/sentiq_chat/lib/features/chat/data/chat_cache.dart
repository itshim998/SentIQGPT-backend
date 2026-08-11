import 'package:sentiq_chat/features/chat/domain/chat_models.dart';
import 'package:sentiq_chat/features/workspace/data/conversation_cache.dart';
import 'package:sqflite/sqflite.dart';

class ChatCache {
  const ChatCache(this._workspaceCache);

  final ConversationCache _workspaceCache;

  Future<List<ChatMessage>> listMessages({
    required String ownerScope,
    required String conversationId,
  }) async {
    final Database database = await _workspaceCache.open();
    final List<Map<String, Object?>> rows = await database.query(
      'messages',
      where: 'owner_scope = ? AND conversation_id = ?',
      whereArgs: <Object?>[ownerScope, conversationId],
      orderBy: 'created_at ASC, local_order ASC',
    );
    return rows.map(ChatMessage.fromDatabase).toList();
  }

  Future<void> upsertMessage({
    required String ownerScope,
    required ChatMessage message,
  }) async {
    final Database database = await _workspaceCache.open();
    final Map<String, Object?> values = message.toDatabase(ownerScope);
    values['local_order'] = message.createdAt.microsecondsSinceEpoch;
    await database.insert(
      'messages',
      values,
      conflictAlgorithm: ConflictAlgorithm.replace,
    );
  }

  Future<void> upsertMessages({
    required String ownerScope,
    required List<ChatMessage> messages,
  }) async {
    if (messages.isEmpty) return;
    final Database database = await _workspaceCache.open();
    await database.transaction((Transaction transaction) async {
      final Batch batch = transaction.batch();
      for (final ChatMessage message in messages) {
        final Map<String, Object?> values = message.toDatabase(ownerScope);
        values['local_order'] = message.createdAt.microsecondsSinceEpoch;
        batch.insert(
          'messages',
          values,
          conflictAlgorithm: ConflictAlgorithm.replace,
        );
      }
      await batch.commit(noResult: true);
    });
  }

  Future<List<ChatMessage>> pendingMessages(String ownerScope) async {
    final Database database = await _workspaceCache.open();
    final List<Map<String, Object?>> rows = await database.query(
      'messages',
      where:
          'owner_scope = ? AND locally_created = 1 AND status IN (?, ?, ?, ?)',
      whereArgs: <Object?>[
        ownerScope,
        ChatMessageStatus.pending.name,
        ChatMessageStatus.syncing.name,
        ChatMessageStatus.interrupted.name,
        ChatMessageStatus.cancelled.name,
      ],
      orderBy: 'created_at ASC',
    );
    return rows.map(ChatMessage.fromDatabase).toList();
  }

  Future<void> recordTurn({
    required String ownerScope,
    required String conversationId,
    required String clientRequestId,
    required String userMessageId,
    required String assistantMessageId,
    required ChatExecutionMode executionMode,
    required String state,
  }) async {
    final Database database = await _workspaceCache.open();
    await database.insert('chat_turns', <String, Object?>{
      'client_request_id': clientRequestId,
      'owner_scope': ownerScope,
      'conversation_id': conversationId,
      'user_message_id': userMessageId,
      'assistant_message_id': assistantMessageId,
      'execution_mode': executionMode.name,
      'state': state,
      'updated_at': DateTime.now().toUtc().toIso8601String(),
    }, conflictAlgorithm: ConflictAlgorithm.replace);
  }

  Future<void> updateTurnState(String clientRequestId, String state) async {
    final Database database = await _workspaceCache.open();
    await database.update(
      'chat_turns',
      <String, Object?>{
        'state': state,
        'updated_at': DateTime.now().toUtc().toIso8601String(),
      },
      where: 'client_request_id = ?',
      whereArgs: <Object?>[clientRequestId],
    );
  }

  Future<Set<String>> knownRequestIds(String ownerScope) async {
    final Database database = await _workspaceCache.open();
    final List<Map<String, Object?>> rows = await database.query(
      'chat_turns',
      columns: const <String>['client_request_id'],
      where: 'owner_scope = ?',
      whereArgs: <Object?>[ownerScope],
    );
    return rows
        .map((Map<String, Object?> row) => row['client_request_id']?.toString())
        .whereType<String>()
        .where((String value) => value.isNotEmpty)
        .toSet();
  }

  Future<void> deleteConversationMessages(String conversationId) async {
    final Database database = await _workspaceCache.open();
    await database.delete(
      'messages',
      where: 'conversation_id = ?',
      whereArgs: <Object?>[conversationId],
    );
    await database.delete(
      'chat_turns',
      where: 'conversation_id = ?',
      whereArgs: <Object?>[conversationId],
    );
  }
}
