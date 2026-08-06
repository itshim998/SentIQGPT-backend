import 'package:path/path.dart' as path;
import 'package:sentiq_chat/features/workspace/domain/conversation_summary.dart';
import 'package:sqflite/sqflite.dart';

abstract final class CacheMigrations {
  static const int currentVersion = 2;

  static const Map<int, List<String>> steps = <int, List<String>>{
    1: <String>[
      'CREATE TABLE conversations ('
          'id TEXT PRIMARY KEY, '
          'owner_scope TEXT NOT NULL, '
          'title TEXT NOT NULL, '
          'created_at TEXT NOT NULL, '
          'updated_at TEXT NOT NULL, '
          'sync_state TEXT NOT NULL DEFAULT "synced"'
          ')',
      'CREATE INDEX conversations_owner_updated '
          'ON conversations(owner_scope, updated_at DESC)',
    ],
    2: <String>[
      'ALTER TABLE conversations ADD COLUMN last_message_preview TEXT',
      'CREATE TABLE app_meta ('
          'key TEXT PRIMARY KEY, '
          'value TEXT NOT NULL'
          ')',
    ],
  };
}

class ConversationCache {
  ConversationCache({DatabaseFactory? factory, this._databasePath})
      : _databaseFactory = factory ?? databaseFactory;

  final DatabaseFactory _databaseFactory;
  final String? _databasePath;
  Database? _database;

  Future<Database> open() async {
    final Database? existing = _database;
    if (existing != null) return existing;
    final String resolvedPath = _databasePath ??
        path.join(await getDatabasesPath(), 'sentiq_chat_workspace.db');
    final Database opened = await _databaseFactory.openDatabase(
      resolvedPath,
      options: OpenDatabaseOptions(
        version: CacheMigrations.currentVersion,
        onCreate: (Database database, int version) =>
            _applyMigrations(database, 0, version),
        onUpgrade: _applyMigrations,
      ),
    );
    _database = opened;
    return opened;
  }

  Future<void> _applyMigrations(
    Database database,
    int oldVersion,
    int newVersion,
  ) async {
    for (int version = oldVersion + 1; version <= newVersion; version += 1) {
      for (final String statement
          in CacheMigrations.steps[version] ?? const <String>[]) {
        await database.execute(statement);
      }
    }
  }

  Future<List<ConversationSummary>> list(String ownerScope) async {
    final Database database = await open();
    final List<Map<String, Object?>> rows = await database.query(
      'conversations',
      where: 'owner_scope = ? AND sync_state != ?',
      whereArgs: <Object?>[
        ownerScope,
        ConversationSyncState.pendingDelete.name,
      ],
      orderBy: 'updated_at DESC',
    );
    return rows.map(ConversationSummary.fromDatabase).toList();
  }

  Future<List<ConversationSummary>> pending(String ownerScope) async {
    final Database database = await open();
    final List<Map<String, Object?>> rows = await database.query(
      'conversations',
      where: 'owner_scope = ? AND sync_state != ?',
      whereArgs: <Object?>[
        ownerScope,
        ConversationSyncState.synced.name,
      ],
    );
    return rows.map(ConversationSummary.fromDatabase).toList();
  }

  Future<void> upsert(ConversationSummary conversation) async {
    final Database database = await open();
    await database.insert(
      'conversations',
      conversation.toDatabase(),
      conflictAlgorithm: ConflictAlgorithm.replace,
    );
  }

  Future<void> upsertAll(List<ConversationSummary> conversations) async {
    if (conversations.isEmpty) return;
    final Database database = await open();
    await database.transaction((Transaction transaction) async {
      final Batch batch = transaction.batch();
      for (final ConversationSummary conversation in conversations) {
        batch.insert(
          'conversations',
          conversation.toDatabase(),
          conflictAlgorithm: ConflictAlgorithm.replace,
        );
      }
      await batch.commit(noResult: true);
    });
  }

  Future<void> deleteHard(String id) async {
    final Database database = await open();
    await database.delete(
      'conversations',
      where: 'id = ?',
      whereArgs: <Object>[id],
    );
  }

  Future<void> close() async {
    await _database?.close();
    _database = null;
  }
}
