import 'package:sentiq_chat/core/network/api_client.dart';
import 'package:sentiq_chat/core/network/api_endpoints.dart';

abstract interface class ProfileRepository {
  Future<String?> getDisplayName();
  Future<String> updateDisplayName(String displayName);
}

class ApiProfileRepository implements ProfileRepository {
  const ApiProfileRepository(this._client);

  final SentIQApiClient _client;

  @override
  Future<String?> getDisplayName() async {
    final Map<String, Object?> payload = await _client.getJson(
      ApiEndpoints.profile,
    );
    final Map<String, Object?> profile = _map(payload['profile']);
    return _firstName(<Object?>[
      profile['display_name'],
      profile['displayName'],
      payload['display_name'],
      payload['displayName'],
    ]);
  }

  @override
  Future<String> updateDisplayName(String displayName) async {
    final String normalized = displayName.trim();
    final Map<String, Object?> payload = await _client.patchJson(
      ApiEndpoints.profile,
      body: <String, Object?>{'display_name': normalized},
    );
    final Map<String, Object?> profile = _map(payload['profile']);
    return _firstName(<Object?>[
          profile['display_name'],
          profile['displayName'],
          payload['display_name'],
          payload['displayName'],
        ]) ??
        normalized;
  }
}

Map<String, Object?> _map(Object? value) {
  if (value is! Map) return <String, Object?>{};
  return value.map(
    (Object? key, Object? nested) => MapEntry(key.toString(), nested),
  );
}

String? _firstName(List<Object?> values) {
  for (final Object? value in values) {
    final String text = value?.toString().trim() ?? '';
    if (text.isNotEmpty) return text;
  }
  return null;
}
