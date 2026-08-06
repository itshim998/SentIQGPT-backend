import 'package:sentiq_chat/features/workspace/data/cloud_conversation_source.dart';
import 'package:sentiq_chat/features/workspace/data/conversation_cache.dart';
import 'package:sentiq_chat/features/workspace/domain/conversation_summary.dart';
import 'package:uuid/uuid.dart';

class ConversationLoadResult {
  const ConversationLoadResult({
    required this.items,
    required this.degraded,
    required this.fromCache,
  });

  final List<ConversationSummary> items;
  final bool degraded;
  final bool fromCache;
}

class ConversationRepository {
  ConversationRepository({
    required ConversationCache cache,
    required CloudConversationSource cloud,
    Uuid? uuid,
  }) : _cache = cache,
       _cloud = cloud,
       _uuid = uuid ?? const Uuid();

  final ConversationCache _cache;
  final CloudConversationSource _cloud;
  final Uuid _uuid;

  Future<ConversationLoadResult> load({
    required String ownerScope,
    required bool cloudEnabled,
    required bool networkAvailable,
  }) async {
    final List<ConversationSummary> cached = await _cache.list(ownerScope);
    if (!cloudEnabled || !networkAvailable) {
      return ConversationLoadResult(
        items: cached,
        degraded: cloudEnabled && !networkAvailable,
        fromCache: true,
      );
    }
    try {
      await _replayPending(ownerScope);
      final List<ConversationSummary> remote = await _cloud.list(ownerScope);
      await _cache.upsertAll(remote);
      return ConversationLoadResult(
        items: await _cache.list(ownerScope),
        degraded: false,
        fromCache: false,
      );
    } catch (_) {
      return ConversationLoadResult(
        items: cached,
        degraded: true,
        fromCache: true,
      );
    }
  }

  Future<ConversationSummary> create({
    required String ownerScope,
    required bool cloudEnabled,
    required bool networkAvailable,
    String title = 'New chat',
  }) async {
    final DateTime now = DateTime.now().toUtc();
    ConversationSummary local = ConversationSummary(
      id: _uuid.v4(),
      ownerScope: ownerScope,
      title: title,
      createdAt: now,
      updatedAt: now,
      syncState: ConversationSyncState.localOnly,
    );
    await _cache.upsert(local);
    if (cloudEnabled && networkAvailable) {
      try {
        local = await _cloud.create(ownerScope, title, preferredId: local.id);
        await _cache.upsert(local);
      } catch (_) {
        // Keep the local-only record for the next reconciliation pass.
      }
    }
    return local;
  }

  Future<ConversationSummary> rename({
    required ConversationSummary conversation,
    required String title,
    required bool cloudEnabled,
    required bool networkAvailable,
  }) async {
    final String normalized = title.trim().isEmpty ? 'New chat' : title.trim();
    ConversationSummary updated = conversation.copyWith(
      title: normalized,
      updatedAt: DateTime.now().toUtc(),
      syncState: cloudEnabled
          ? ConversationSyncState.pendingRename
          : ConversationSyncState.localOnly,
    );
    await _cache.upsert(updated);
    if (cloudEnabled && networkAvailable) {
      try {
        updated = await _cloud.rename(updated, normalized);
        await _cache.upsert(updated);
      } catch (_) {
        // Pending rename remains in SQLite.
      }
    }
    return updated;
  }

  Future<void> delete({
    required ConversationSummary conversation,
    required bool cloudEnabled,
    required bool networkAvailable,
  }) async {
    if (!cloudEnabled ||
        conversation.syncState == ConversationSyncState.localOnly) {
      await _cache.deleteHard(conversation.id);
      return;
    }
    await _cache.upsert(
      conversation.copyWith(
        updatedAt: DateTime.now().toUtc(),
        syncState: ConversationSyncState.pendingDelete,
      ),
    );
    if (networkAvailable) {
      try {
        await _cloud.delete(conversation.id);
        await _cache.deleteHard(conversation.id);
      } catch (_) {
        // Pending delete remains in SQLite.
      }
    }
  }

  Future<void> _replayPending(String ownerScope) async {
    final List<ConversationSummary> pending = await _cache.pending(ownerScope);
    for (final ConversationSummary conversation in pending) {
      switch (conversation.syncState) {
        case ConversationSyncState.localOnly:
          final ConversationSummary created = await _cloud.create(
            ownerScope,
            conversation.title,
            preferredId: conversation.id,
          );
          await _cache.upsert(created);
          break;
        case ConversationSyncState.pendingRename:
          final ConversationSummary renamed = await _cloud.rename(
            conversation,
            conversation.title,
          );
          await _cache.upsert(renamed);
          break;
        case ConversationSyncState.pendingDelete:
          await _cloud.delete(conversation.id);
          await _cache.deleteHard(conversation.id);
          break;
        case ConversationSyncState.synced:
          break;
      }
    }
  }
}
