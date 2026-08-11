import 'package:shared_preferences/shared_preferences.dart';
import 'package:sentiq_chat/core/network/api_client.dart';
import 'package:sentiq_chat/core/network/api_endpoints.dart';
import 'package:sentiq_chat/features/account/domain/account_models.dart';
import 'package:sentiq_chat/features/workspace/data/conversation_cache.dart';

abstract interface class AccountGateway {
  Future<List<AccountMemory>> memories();
  Future<void> deleteMemory(String id);
  Future<void> clearTemporaryFiles();
  Future<void> clearDeviceData(String ownerScope);
}

class AccountRepository implements AccountGateway {
  const AccountRepository({
    required SentIQApiClient client,
    required ConversationCache cache,
  }) : _client = client,
       _cache = cache;

  final SentIQApiClient _client;
  final ConversationCache _cache;

  @override
  Future<List<AccountMemory>> memories() async {
    final Map<String, Object?> payload = await _client.getJson(
      ApiEndpoints.memories,
    );
    final Object? raw =
        payload['memories'] ?? payload['items'] ?? payload['data'];
    if (raw is! List) return const <AccountMemory>[];
    return raw
        .whereType<Map>()
        .map((Map item) {
          return AccountMemory.fromJson(
            item.map(
              (Object? key, Object? value) => MapEntry(key.toString(), value),
            ),
          );
        })
        .toList(growable: false);
  }

  @override
  Future<void> deleteMemory(String id) async {
    await _client.deleteJson(ApiEndpoints.memory(id));
  }

  @override
  Future<void> clearTemporaryFiles() async {
    await _client.deleteJson(ApiEndpoints.filesSession);
  }

  @override
  Future<void> clearDeviceData(String ownerScope) async {
    await _cache.clearScope(ownerScope);
    final SharedPreferences preferences = await SharedPreferences.getInstance();
    final List<String> keys = preferences
        .getKeys()
        .where((String key) => key.startsWith('sentiq:mobile:'))
        .toList(growable: false);
    for (final String key in keys) {
      await preferences.remove(key);
    }
  }
}
