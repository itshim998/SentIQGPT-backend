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
    directory = await Directory.systemTemp.createTemp('sentiq-capacity-test-');
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

  test('an old unsynced create survives while oldest synced row is evicted', () async {
    final DateTime base = DateTime.utc(2026, 8, 1);
    await cache.upsert(
      ConversationSummary(
        id: 'offline-pending',
        ownerScope: 'user-1',
        title: 'New chat',
        createdAt: base.subtract(const Duration(days: 10)),
        updatedAt: base.add(const Duration(days: 60)),
        syncState: ConversationSyncState.localOnly,
      ),
    );

    for (int index = 0; index < 50; index += 1) {
      final DateTime created = base.add(Duration(minutes: index));
      await cache.upsert(
        ConversationSummary(
          id: 'synced-$index',
          ownerScope: 'user-1',
          title: 'Synced $index',
          createdAt: created,
          updatedAt: created,
          syncState: ConversationSyncState.synced,
        ),
      );
    }

    final List<ConversationSummary> items = await cache.list('user-1');
    expect(items, hasLength(50));
    expect(
      items.any((ConversationSummary item) => item.id == 'offline-pending'),
      isTrue,
    );
    expect(
      items.any((ConversationSummary item) => item.id == 'synced-0'),
      isFalse,
    );
    expect(
      items.any((ConversationSummary item) => item.id == 'synced-49'),
      isTrue,
    );
  });
}
