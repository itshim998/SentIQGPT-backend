import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:sentiq_chat/features/workspace/data/conversation_cache.dart';
import 'package:sentiq_chat/features/workspace/domain/conversation_summary.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

void main() {
  late Directory directory;
  late String databasePath;
  late ConversationCache cache;

  setUpAll(sqfliteFfiInit);

  setUp(() async {
    directory = await Directory.systemTemp.createTemp('sentiq-sync-test-');
    databasePath = '${directory.path}/workspace.db';
    cache = ConversationCache(
      factory: databaseFactoryFfi,
      databasePath: databasePath,
    );
  });

  tearDown(() async {
    await cache.close();
    await databaseFactoryFfi.deleteDatabase(databasePath);
    await directory.delete(recursive: true);
  });

  test('cloud metadata uses last activity and identifies fallback titles', () {
    final ConversationSummary item = ConversationSummary.fromJson(
      <String, Object?>{
        'id': 'cloud-chat',
        'title': 'Explain this concurrency bug',
        'created_at': '2026-08-01T10:00:00Z',
        'last_activity_at': '2026-08-09T10:00:00Z',
        'message_count': 4,
        'first_user_message':
            'Explain this concurrency bug in my synchronization code please',
      },
      ownerScope: 'user-1',
    );

    expect(item.updatedAt, DateTime.parse('2026-08-09T10:00:00Z').toUtc());
    expect(item.messageCount, 4);
    expect(item.lastMessagePreview, startsWith('Explain this concurrency'));
    expect(item.needsGeneratedTitle, isTrue);

    final ConversationSummary summarized = item.copyWith(
      title: 'Synchronization Race Analysis',
    );
    expect(summarized.needsGeneratedTitle, isFalse);
  });

  test('fresh install restores authoritative cloud history and ordering', () async {
    final List<ConversationSummary> remote = List<ConversationSummary>.generate(
      50,
      (int index) {
        final DateTime created = DateTime.utc(2026, 7, 1).add(
          Duration(days: index),
        );
        return ConversationSummary(
          id: 'cloud-$index',
          ownerScope: 'user-1',
          title: 'Cloud $index',
          createdAt: created,
          updatedAt: created.add(Duration(hours: index)),
          syncState: ConversationSyncState.synced,
          messageCount: 2,
          firstUserMessage: 'Question $index',
        );
      },
    ).reversed.toList();

    await cache.reconcileCloudSnapshot('user-1', remote);
    final List<ConversationSummary> restored = await cache.list('user-1');

    expect(restored, hasLength(50));
    expect(restored.first.id, 'cloud-49');
    expect(restored.last.id, 'cloud-0');
  });

  test('local cache enforces the backend fifty-chat FIFO capacity', () async {
    final DateTime base = DateTime.utc(2026, 1, 1);
    for (int index = 0; index < 51; index += 1) {
      final DateTime created = base.add(Duration(minutes: index));
      await cache.upsert(
        ConversationSummary(
          id: 'chat-$index',
          ownerScope: 'user-1',
          title: 'Chat $index',
          createdAt: created,
          updatedAt: created,
          syncState: ConversationSyncState.localOnly,
        ),
      );
    }

    final List<ConversationSummary> items = await cache.list('user-1');
    expect(items, hasLength(50));
    expect(items.any((ConversationSummary item) => item.id == 'chat-0'), isFalse);
    expect(items.first.id, 'chat-50');
    expect(items.last.id, 'chat-1');
  });

  test('cloud reconciliation removes stale synced rows but keeps offline creates', () async {
    final DateTime now = DateTime.utc(2026, 8, 9);
    await cache.upsert(
      ConversationSummary(
        id: 'stale-synced',
        ownerScope: 'user-1',
        title: 'Deleted on web',
        createdAt: now,
        updatedAt: now,
        syncState: ConversationSyncState.synced,
      ),
    );
    await cache.upsert(
      ConversationSummary(
        id: 'offline-create',
        ownerScope: 'user-1',
        title: 'New chat',
        createdAt: now.add(const Duration(minutes: 1)),
        updatedAt: now.add(const Duration(minutes: 1)),
        syncState: ConversationSyncState.localOnly,
      ),
    );

    await cache.reconcileCloudSnapshot('user-1', <ConversationSummary>[
      ConversationSummary(
        id: 'cloud-current',
        ownerScope: 'user-1',
        title: 'Current cloud chat',
        createdAt: now.add(const Duration(minutes: 2)),
        updatedAt: now.add(const Duration(minutes: 3)),
        syncState: ConversationSyncState.synced,
      ),
    ]);

    final List<ConversationSummary> items = await cache.list('user-1');
    expect(items.any((ConversationSummary item) => item.id == 'stale-synced'), isFalse);
    expect(items.any((ConversationSummary item) => item.id == 'offline-create'), isTrue);
    expect(items.any((ConversationSummary item) => item.id == 'cloud-current'), isTrue);
  });

  test('canonical remap preserves local messages and turn ownership', () async {
    final DateTime now = DateTime.utc(2026, 8, 9);
    await cache.upsert(
      ConversationSummary(
        id: 'old-id',
        ownerScope: 'user-1',
        title: 'New chat',
        createdAt: now,
        updatedAt: now,
        syncState: ConversationSyncState.localOnly,
      ),
    );
    final Database database = await cache.open();
    await database.insert('messages', <String, Object?>{
      'id': 'message-1',
      'conversation_id': 'old-id',
      'owner_scope': 'user-1',
      'role': 'user',
      'content': 'Hello',
      'created_at': now.toIso8601String(),
      'status': 'pending',
      'citations_json': '[]',
      'metadata_json': '{}',
      'locally_created': 1,
      'local_order': 1,
    });
    await database.insert('chat_turns', <String, Object?>{
      'client_request_id': 'request-1',
      'owner_scope': 'user-1',
      'conversation_id': 'old-id',
      'user_message_id': 'message-1',
      'assistant_message_id': 'assistant-1',
      'execution_mode': 'fast',
      'state': 'streaming',
      'updated_at': now.toIso8601String(),
    });

    await cache.remapConversation(
      'old-id',
      ConversationSummary(
        id: 'canonical-id',
        ownerScope: 'user-1',
        title: 'Canonical chat',
        createdAt: now,
        updatedAt: now,
        syncState: ConversationSyncState.synced,
      ),
    );

    final List<Map<String, Object?>> messages = await database.query(
      'messages',
      where: 'id = ?',
      whereArgs: <Object?>['message-1'],
    );
    final List<Map<String, Object?>> turns = await database.query(
      'chat_turns',
      where: 'client_request_id = ?',
      whereArgs: <Object?>['request-1'],
    );
    final List<ConversationSummary> conversations = await cache.list('user-1');

    expect(messages.single['conversation_id'], 'canonical-id');
    expect(turns.single['conversation_id'], 'canonical-id');
    expect(conversations.single.id, 'canonical-id');
  });
}
