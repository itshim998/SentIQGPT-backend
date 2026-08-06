import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:sentiq_chat/features/workspace/data/conversation_cache.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

void main() {
  late Directory directory;
  late String databasePath;

  setUpAll(sqfliteFfiInit);

  setUp(() async {
    directory = await Directory.systemTemp.createTemp('sentiq-cache-test-');
    databasePath = '${directory.path}/workspace.db';
  });

  tearDown(() async {
    await databaseFactoryFfi.deleteDatabase(databasePath);
    await directory.delete(recursive: true);
  });

  test('migrates a version 1 conversation cache to version 2', () async {
    final Database versionOne = await databaseFactoryFfi.openDatabase(
      databasePath,
      options: OpenDatabaseOptions(
        version: 1,
        onCreate: (Database database, int version) async {
          for (final String statement in CacheMigrations.steps[1]!) {
            await database.execute(statement);
          }
        },
      ),
    );
    await versionOne.insert('conversations', <String, Object?>{
      'id': 'conversation-1',
      'owner_scope': 'user-1',
      'title': 'Cached chat',
      'created_at': '2026-08-06T00:00:00.000Z',
      'updated_at': '2026-08-06T00:00:00.000Z',
      'sync_state': 'synced',
    });
    await versionOne.close();

    final ConversationCache cache = ConversationCache(
      factory: databaseFactoryFfi,
      databasePath: databasePath,
    );
    final items = await cache.list('user-1');
    final Database migrated = await cache.open();
    final List<Map<String, Object?>> metadata = await migrated.rawQuery(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='app_meta'",
    );

    expect(items.single.title, 'Cached chat');
    expect(metadata, isNotEmpty);
    expect(await migrated.getVersion(), CacheMigrations.currentVersion);
    await cache.close();
  });
}
