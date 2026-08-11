import 'package:shared_preferences/shared_preferences.dart';
import 'package:uuid/uuid.dart';

abstract interface class AnonymousIdentityStore {
  Future<String> getOrCreate();
}

class SharedPreferencesAnonymousIdentityStore
    implements AnonymousIdentityStore {
  SharedPreferencesAnonymousIdentityStore({
    Future<SharedPreferences> Function()? preferences,
    Uuid? uuid,
  }) : _preferences = preferences ?? SharedPreferences.getInstance,
       _uuid = uuid ?? const Uuid();

  static const String storageKey = 'sentiq:mobile:anonymous-quota-id';

  final Future<SharedPreferences> Function() _preferences;
  final Uuid _uuid;

  @override
  Future<String> getOrCreate() async {
    final SharedPreferences preferences = await _preferences();
    final String? existing = preferences.getString(storageKey)?.trim();
    if (existing != null && existing.isNotEmpty && existing.length <= 96) {
      return existing;
    }
    final String created = _uuid.v4();
    await preferences.setString(storageKey, created);
    return created;
  }
}

class MemoryAnonymousIdentityStore implements AnonymousIdentityStore {
  MemoryAnonymousIdentityStore({String seed = 'anonymous-test-id'})
    : _identity = seed;

  final String _identity;

  @override
  Future<String> getOrCreate() async => _identity;
}
