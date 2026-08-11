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
    directory = await Directory.systemTemp.createTemp('sentiq-alias-test-');
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

  test('merge alias moves local turns and preserves pending rename intent', () async {
    final DateTime now = DateTime.utc(2026, 8, 9);
    await cache.upsert(
      ConversationSummary(
        id: 'retired-id',
        ownerScope: 'user-1',
        title: 'My explicit rename',
        createdAt: now,
        updatedAt: now,
        syncState: ConversationSyncState.pendingRename,
      ),
    );
    final Database database = await cache.open();
    await database.insert('messages', <String, Object?>{
      'id': 'pending-message',
      'conversation_id': 'retired-id',
      'owner_scope': 'user-1',
      'role': 'user',
      'content': 'Unsynced local content',
      'created_at': now.toIso8601String(),
      'status': 'pending',
      'citations_json': '[]',
      'metadata_json': '{}',
      'locally_created': 1,
      'local_order': 1,
    });

    final ConversationSummary canonical = ConversationSummary(
      id: 'canonical-id',
      ownerScope: 'user-1',
      title: 'Server title',
      createdAt: now.subtract(const Duration(days: 1)),
      updatedAt: now.add(const Duration(minutes: 1)),
      syncState: ConversationSyncState.synced,
      messageCount: 2,
      firstUserMessage: 'Unsynced local content',
    );
    await cache.reconcileCloudSnapshot(
      'user-1',
      <ConversationSummary>[canonical],
      aliases: const <String, String>{'retired-id': 'canonical-id'},
    );

    final List<ConversationSummary> conversations = await cache.list('user-1');
    final List<Map<String, Object?>> messages = await database.query(
      'messages',
      where: 'id = ?',
      whereArgs: <Object?>['pending-message'],
    );

    expect(conversations, hasLength(1));
    expect(conversations.single.id, 'canonical-id');
    expect(conversations.single.title, 'My explicit rename');
    expect(
      conversations.single.syncState,
      ConversationSyncState.pendingRename,
    );
    expect(messages.single['conversation_id'], 'canonical-id');
  });
}
