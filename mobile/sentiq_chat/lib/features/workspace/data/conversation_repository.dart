import 'dart:async';

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

  static const int _maximumTitleRepairAttempts = 3;

  final ConversationCache _cache;
  final CloudConversationSource _cloud;
  final Uuid _uuid;
  final Set<String> _titleRepairsInFlight = <String>{};
  final Map<String, int> _titleRepairAttempts = <String, int>{};

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

    // Pending local mutations and the authoritative cloud list are deliberately
    // independent. A single failed offline replay must never prevent a signed-
    // in user from recovering their server history after restart/reinstall.
    final bool replayDegraded = await _replayPending(ownerScope);
    try {
      final CloudConversationSnapshot snapshot = await _cloud.snapshot(
        ownerScope,
      );
      await _cache.reconcileCloudSnapshot(
        ownerScope,
        snapshot.items,
        aliases: snapshot.aliases,
      );
      _clearResolvedTitleAttempts(snapshot.items);
      _scheduleTitleRepair(ownerScope, snapshot.items);
      return ConversationLoadResult(
        items: await _cache.list(ownerScope),
        degraded: replayDegraded,
        fromCache: false,
      );
    } catch (_) {
      return ConversationLoadResult(
        items: await _cache.list(ownerScope),
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
        final ConversationSummary created = await _cloud.create(
          ownerScope,
          title,
          preferredId: local.id,
        );
        if (created.id != local.id) {
          await _cache.remapConversation(local.id, created);
        } else {
          await _cache.upsert(created);
        }
        local = created;
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

  Future<bool> _replayPending(String ownerScope) async {
    final List<ConversationSummary> pending = await _cache.pending(ownerScope);
    bool degraded = false;
    for (final ConversationSummary conversation in pending) {
      try {
        switch (conversation.syncState) {
          case ConversationSyncState.localOnly:
            final ConversationSummary created = await _cloud.create(
              ownerScope,
              conversation.title,
              preferredId: conversation.id,
            );
            if (created.id != conversation.id) {
              await _cache.remapConversation(conversation.id, created);
            } else {
              await _cache.upsert(created);
            }
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
      } catch (_) {
        // Continue replaying the rest. One malformed/stale mutation must not
        // poison conversation-list recovery for the entire account.
        degraded = true;
      }
    }
    return degraded;
  }

  void _clearResolvedTitleAttempts(List<ConversationSummary> remote) {
    for (final ConversationSummary conversation in remote) {
      if (!conversation.needsGeneratedTitle) {
        _titleRepairAttempts.remove(conversation.id);
      }
    }
  }

  void _scheduleTitleRepair(
    String ownerScope,
    List<ConversationSummary> remote,
  ) {
    ConversationSummary? candidate;
    for (final ConversationSummary conversation in remote) {
      final int attempts = _titleRepairAttempts[conversation.id] ?? 0;
      if (conversation.messageCount >= 2 &&
          conversation.needsGeneratedTitle &&
          attempts < _maximumTitleRepairAttempts &&
          !_titleRepairsInFlight.contains(conversation.id)) {
        candidate = conversation;
        break;
      }
    }
    if (candidate == null) return;

    final ConversationSummary target = candidate;
    _titleRepairsInFlight.add(target.id);
    _titleRepairAttempts[target.id] =
        (_titleRepairAttempts[target.id] ?? 0) + 1;
    unawaited(() async {
      try {
        final ConversationSummary repaired = await _cloud.repairGeneratedTitle(
          ownerScope,
          target,
        );
        if (repaired.title != target.title || !repaired.needsGeneratedTitle) {
          await _cache.upsert(repaired);
        }
        if (!repaired.needsGeneratedTitle) {
          _titleRepairAttempts.remove(target.id);
        }
      } catch (_) {
        // A later reconciliation may retry, but the per-session attempt bound
        // prevents a provider outage from becoming an API retry loop.
      } finally {
        _titleRepairsInFlight.remove(target.id);
      }
    }());
  }
}
