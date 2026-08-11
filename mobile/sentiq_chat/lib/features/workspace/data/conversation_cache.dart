import 'package:path/path.dart' as path;
import 'package:sentiq_chat/features/workspace/domain/conversation_summary.dart';
import 'package:sqflite/sqflite.dart';

abstract final class CacheMigrations {
  static const int currentVersion = 5;

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
    3: <String>[
      'CREATE TABLE messages ('
          'id TEXT PRIMARY KEY, '
          'conversation_id TEXT NOT NULL, '
          'owner_scope TEXT NOT NULL, '
          'role TEXT NOT NULL, '
          'content TEXT NOT NULL DEFAULT "", '
          'created_at TEXT NOT NULL, '
          'status TEXT NOT NULL DEFAULT "complete", '
          'client_request_id TEXT, '
          'execution_mode TEXT, '
          'citations_json TEXT NOT NULL DEFAULT "[]", '
          'metadata_json TEXT NOT NULL DEFAULT "{}", '
          'error_message TEXT, '
          'locally_created INTEGER NOT NULL DEFAULT 0, '
          'local_order INTEGER NOT NULL DEFAULT 0'
          ')',
      'CREATE INDEX messages_conversation_order '
          'ON messages(owner_scope, conversation_id, created_at, local_order)',
      'CREATE INDEX messages_request_id '
          'ON messages(owner_scope, client_request_id)',
    ],
    4: <String>[
      'CREATE TABLE chat_turns ('
          'client_request_id TEXT PRIMARY KEY, '
          'owner_scope TEXT NOT NULL, '
          'conversation_id TEXT NOT NULL, '
          'user_message_id TEXT NOT NULL, '
          'assistant_message_id TEXT NOT NULL, '
          'execution_mode TEXT NOT NULL, '
          'state TEXT NOT NULL, '
          'updated_at TEXT NOT NULL'
          ')',
      'CREATE INDEX chat_turns_owner_state '
          'ON chat_turns(owner_scope, state, updated_at)',
    ],
    5: <String>[
      'ALTER TABLE conversations ADD COLUMN message_count INTEGER NOT NULL DEFAULT 0',
      'ALTER TABLE conversations ADD COLUMN first_user_message TEXT',
    ],
  };
}

class ConversationCache {
  ConversationCache({DatabaseFactory? factory, this._databasePath})
    : _databaseFactory = factory ?? databaseFactory;

  static const int maximumConversations = 50;

  final DatabaseFactory _databaseFactory;
  final String? _databasePath;
  Database? _database;

  Future<Database> open() async {
    final Database? existing = _database;
    if (existing != null) return existing;
    final String resolvedPath =
        _databasePath ??
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
      orderBy: 'updated_at DESC, created_at DESC',
      limit: maximumConversations,
    );
    return rows.map(ConversationSummary.fromDatabase).toList();
  }

  Future<List<ConversationSummary>> pending(String ownerScope) async {
    final Database database = await open();
    final List<Map<String, Object?>> rows = await database.query(
      'conversations',
      where: 'owner_scope = ? AND sync_state != ?',
      whereArgs: <Object?>[ownerScope, ConversationSyncState.synced.name],
      orderBy: 'created_at ASC',
    );
    return rows.map(ConversationSummary.fromDatabase).toList();
  }

  Future<void> upsert(ConversationSummary conversation) async {
    final Database database = await open();
    await database.transaction((Transaction transaction) async {
      await transaction.insert(
        'conversations',
        conversation.toDatabase(),
        conflictAlgorithm: ConflictAlgorithm.replace,
      );
      await _trimScope(transaction, conversation.ownerScope);
    });
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
      for (final String scope in conversations
          .map((ConversationSummary item) => item.ownerScope)
          .toSet()) {
        await _trimScope(transaction, scope);
      }
    });
  }

  /// Reconciles a successful server snapshot into SQLite.
  ///
  /// For signed-in users the backend is the canonical history. Local-only
  /// records are preserved until their create is replayed; pending local
  /// mutations are also preserved. Synced rows that disappeared remotely are
  /// removed locally so app reinstall, storage clear, web deletes and the
  /// backend's 50-chat FIFO eviction all converge to exactly the same history.
  Future<void> reconcileCloudSnapshot(
    String ownerScope,
    List<ConversationSummary> remote, {
    Map<String, String> aliases = const <String, String>{},
  }) async {
    final Database database = await open();
    await database.transaction((Transaction transaction) async {
      final List<ConversationSummary> canonicalRemote = remote
          .where((ConversationSummary item) => item.id.isNotEmpty)
          .take(maximumConversations)
          .toList(growable: false);
      final Map<String, ConversationSummary> remoteById =
          <String, ConversationSummary>{
            for (final ConversationSummary item in canonicalRemote)
              item.id: item,
          };

      // The list endpoint can merge duplicate conversations and return aliases.
      // Move cached messages/turns before stale-row pruning so an offline/local
      // turn can never be discarded merely because its previous UUID retired.
      for (final MapEntry<String, String> alias in aliases.entries) {
        final ConversationSummary? canonical = remoteById[alias.value];
        if (canonical == null || alias.key == canonical.id) continue;
        await _remapConversationRows(transaction, alias.key, canonical);
      }

      final List<Map<String, Object?>> localRows = await transaction.query(
        'conversations',
        where: 'owner_scope = ?',
        whereArgs: <Object?>[ownerScope],
      );
      final Map<String, ConversationSummary> local =
          <String, ConversationSummary>{
            for (final Map<String, Object?> row in localRows)
              row['id'].toString(): ConversationSummary.fromDatabase(row),
          };
      final Set<String> remoteIds = canonicalRemote
          .map((ConversationSummary item) => item.id)
          .toSet();

      for (final ConversationSummary cloud in canonicalRemote) {
        final ConversationSummary? cached = local[cloud.id];
        if (cached != null &&
            cached.syncState == ConversationSyncState.pendingDelete) {
          continue;
        }
        if (cached != null &&
            cached.syncState == ConversationSyncState.pendingRename &&
            cached.title != cloud.title) {
          // Preserve the local explicit rename until its PATCH succeeds, while
          // still accepting authoritative cloud activity/message metadata.
          await transaction.insert(
            'conversations',
            cached.copyWith(
              updatedAt: cloud.updatedAt,
              lastMessagePreview: cloud.lastMessagePreview,
              firstUserMessage: cloud.firstUserMessage,
              messageCount: cloud.messageCount,
            ).toDatabase(),
            conflictAlgorithm: ConflictAlgorithm.replace,
          );
          continue;
        }
        await transaction.insert(
          'conversations',
          cloud.toDatabase(),
          conflictAlgorithm: ConflictAlgorithm.replace,
        );
      }

      for (final ConversationSummary cached in local.values) {
        if (remoteIds.contains(cached.id)) continue;
        switch (cached.syncState) {
          case ConversationSyncState.localOnly:
            // Not uploaded yet; must survive cloud snapshots until replayed.
            continue;
          case ConversationSyncState.pendingDelete:
          case ConversationSyncState.pendingRename:
          case ConversationSyncState.synced:
            // A successful authoritative list no longer contains this row.
            // This covers web-side deletes, FIFO eviction and stale aliases.
            await _deleteConversationRows(transaction, cached.id);
            break;
        }
      }

      await _trimScope(transaction, ownerScope);
    });
  }

  /// Moves local message/turn ownership when the backend resolves an old UUID
  /// through a canonical alias. This prevents a duplicate/ghost local chat
  /// from surviving after the server has already merged it.
  Future<void> remapConversation(
    String previousId,
    ConversationSummary canonical,
  ) async {
    if (previousId == canonical.id) {
      await upsert(canonical);
      return;
    }
    final Database database = await open();
    await database.transaction((Transaction transaction) async {
      await _remapConversationRows(transaction, previousId, canonical);
      await _trimScope(transaction, canonical.ownerScope);
    });
  }

  Future<void> _remapConversationRows(
    Transaction transaction,
    String previousId,
    ConversationSummary canonical,
  ) async {
    final List<Map<String, Object?>> previousRows = await transaction.query(
      'conversations',
      where: 'id = ?',
      whereArgs: <Object?>[previousId],
      limit: 1,
    );
    final ConversationSummary? previous = previousRows.isEmpty
        ? null
        : ConversationSummary.fromDatabase(previousRows.first);
    if (previous == null) return;

    await transaction.update(
      'messages',
      <String, Object?>{'conversation_id': canonical.id},
      where: 'conversation_id = ?',
      whereArgs: <Object?>[previousId],
    );
    await transaction.update(
      'chat_turns',
      <String, Object?>{'conversation_id': canonical.id},
      where: 'conversation_id = ?',
      whereArgs: <Object?>[previousId],
    );
    await transaction.delete(
      'conversations',
      where: 'id = ?',
      whereArgs: <Object?>[previousId],
    );

    final ConversationSummary replacement = switch (previous.syncState) {
      ConversationSyncState.pendingDelete => canonical.copyWith(
        syncState: ConversationSyncState.pendingDelete,
      ),
      ConversationSyncState.pendingRename => canonical.copyWith(
        title: previous.title,
        syncState: ConversationSyncState.pendingRename,
      ),
      ConversationSyncState.localOnly || ConversationSyncState.synced =>
        canonical.copyWith(syncState: ConversationSyncState.synced),
    };
    await transaction.insert(
      'conversations',
      replacement.toDatabase(),
      conflictAlgorithm: ConflictAlgorithm.replace,
    );
  }

  Future<void> deleteHard(String id) async {
    final Database database = await open();
    await database.transaction((Transaction transaction) async {
      await _deleteConversationRows(transaction, id);
    });
  }

  Future<void> clearScope(String ownerScope) async {
    final Database database = await open();
    await database.transaction((Transaction transaction) async {
      await transaction.delete(
        'chat_turns',
        where: 'owner_scope = ?',
        whereArgs: <Object>[ownerScope],
      );
      await transaction.delete(
        'messages',
        where: 'owner_scope = ?',
        whereArgs: <Object>[ownerScope],
      );
      await transaction.delete(
        'conversations',
        where: 'owner_scope = ?',
        whereArgs: <Object>[ownerScope],
      );
    });
  }

  Future<void> clearAll() async {
    final Database database = await open();
    await database.transaction((Transaction transaction) async {
      await transaction.delete('chat_turns');
      await transaction.delete('messages');
      await transaction.delete('conversations');
      await transaction.delete('app_meta');
    });
  }

  Future<void> _trimScope(Transaction transaction, String ownerScope) async {
    final List<Map<String, Object?>> syncedRows = await transaction.query(
      'conversations',
      columns: const <String>['id', 'sync_state', 'created_at'],
      where: 'owner_scope = ? AND sync_state = ?',
      whereArgs: <Object?>[ownerScope, ConversationSyncState.synced.name],
      orderBy: 'created_at ASC',
    );
    final List<Map<String, Object?>> pendingRows = await transaction.query(
      'conversations',
      columns: const <String>['id', 'sync_state', 'created_at'],
      where: 'owner_scope = ? AND sync_state != ?',
      whereArgs: <Object?>[ownerScope, ConversationSyncState.synced.name],
      orderBy: 'created_at ASC',
    );
    final List<Map<String, Object?>> rows = <Map<String, Object?>>[
      ...syncedRows,
      ...pendingRows,
    ];
    final int excessCount = rows.length - maximumConversations;
    if (excessCount <= 0) return;

    // Protect unsynced mutations whenever possible. If pending work itself
    // exceeds 50, the oldest pending rows are FIFO-evicted, matching the final
    // server state after those creates are replayed in creation order.
    for (int index = 0; index < excessCount; index += 1) {
      final String id = rows[index]['id']?.toString() ?? '';
      if (id.isNotEmpty) await _deleteConversationRows(transaction, id);
    }
  }

  Future<void> _deleteConversationRows(
    Transaction transaction,
    String id,
  ) async {
    await transaction.delete(
      'messages',
      where: 'conversation_id = ?',
      whereArgs: <Object>[id],
    );
    await transaction.delete(
      'chat_turns',
      where: 'conversation_id = ?',
      whereArgs: <Object>[id],
    );
    await transaction.delete(
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
