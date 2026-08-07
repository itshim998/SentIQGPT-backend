import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

/// Stores the Supabase refresh/session material in Android encrypted storage.
///
/// SentIQ Chat has not shipped publicly yet, so there is intentionally no
/// SharedPreferences migration path: a pre-release install may require one
/// fresh sign-in instead of retaining a plaintext-at-rest session.
class SecureAuthStorage extends LocalStorage {
  SecureAuthStorage({FlutterSecureStorage? storage})
    : _storage = storage ?? FlutterSecureStorage();

  static const String _sessionKey = 'sentiq.supabase.session.v1';

  final FlutterSecureStorage _storage;

  @override
  Future<void> initialize() async {}

  @override
  Future<String?> accessToken() => _storage.read(key: _sessionKey);

  @override
  Future<bool> hasAccessToken() => _storage.containsKey(key: _sessionKey);

  @override
  Future<void> persistSession(String persistSessionString) =>
      _storage.write(key: _sessionKey, value: persistSessionString);

  @override
  Future<void> removePersistedSession() => _storage.delete(key: _sessionKey);
}
