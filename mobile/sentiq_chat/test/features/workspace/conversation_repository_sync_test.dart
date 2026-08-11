import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:sentiq_chat/features/workspace/data/cloud_conversation_source.dart';
import 'package:sentiq_chat/features/workspace/data/conversation_cache.dart';
import 'package:sentiq_chat/features/workspace/data/conversation_repository.dart';
import 'package:sentiq_chat/features/workspace/domain/conversation_summary.dart';
import 'package:sqflite_common_ffi/sqflite_ffi.dart';

void main() {
  late Directory directory;
  late String databasePath;
  late ConversationCache cache;

  setUpAll(sqfliteFfiInit);

  setUp(() async {
    directory = await Directory.systemTemp.createTemp('sentiq-repository-test-');
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

  test('one failed pending replay does not block authoritative list restore', () async {
    final DateTime now = DateTime.utc(2026, 8, 9);
    await cache.upsert(
      ConversationSummary(
        id: 'bad-local',
        ownerScope: 'user-1',
        title: 'New chat',
        createdAt: now,
        updatedAt: now,
        syncState: ConversationSyncState.localOnly,
      ),
    );
    final _ReplayFailureCloudSource cloud = _ReplayFailureCloudSource(
      ConversationSummary(
        id: 'cloud-chat',
        ownerScope: 'user-1',
        title: 'Restored from cloud',
        createdAt: now.subtract(const Duration(days: 1)),
        updatedAt: now.add(const Duration(minutes: 1)),
        syncState: ConversationSyncState.synced,
      ),
    );
    final ConversationRepository repository = ConversationRepository(
      cache: cache,
      cloud: cloud,
    );

    final ConversationLoadResult result = await repository.load(
      ownerScope: 'user-1',
      cloudEnabled: true,
      networkAvailable: true,
    );

    expect(cloud.snapshotCalls, 1);
    expect(result.fromCache, isFalse);
    expect(result.degraded, isTrue);
    expect(
      result.items.any((ConversationSummary item) => item.id == 'cloud-chat'),
      isTrue,
    );
    expect(
      result.items.any((ConversationSummary item) => item.id == 'bad-local'),
      isTrue,
    );
  });
}

class _ReplayFailureCloudSource implements CloudConversationSource {
  _ReplayFailureCloudSource(this.cloudConversation);

  final ConversationSummary cloudConversation;
  int snapshotCalls = 0;

  @override
  Future<CloudConversationSnapshot> snapshot(String ownerScope) async {
    snapshotCalls += 1;
    return CloudConversationSnapshot(
      items: <ConversationSummary>[cloudConversation],
    );
  }

  @override
  Future<List<ConversationSummary>> list(String ownerScope) async {
    return <ConversationSummary>[cloudConversation];
  }

  @override
  Future<ConversationSummary> create(
    String ownerScope,
    String title, {
    String? preferredId,
  }) async {
    if (preferredId == 'bad-local') {
      throw StateError('simulated create failure');
    }
    return ConversationSummary(
      id: preferredId ?? 'created',
      ownerScope: ownerScope,
      title: title,
      createdAt: DateTime.utc(2026, 8, 9),
      updatedAt: DateTime.utc(2026, 8, 9),
      syncState: ConversationSyncState.synced,
    );
  }

  @override
  Future<ConversationSummary> rename(
    ConversationSummary conversation,
    String title,
  ) async => conversation.copyWith(
    title: title,
    syncState: ConversationSyncState.synced,
  );

  @override
  Future<void> delete(String id) async {}

  @override
  Future<ConversationSummary> repairGeneratedTitle(
    String ownerScope,
    ConversationSummary conversation,
  ) async => conversation;
}
