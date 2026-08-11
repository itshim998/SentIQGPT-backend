import 'package:flutter_test/flutter_test.dart';
import 'package:sentiq_chat/core/network/anonymous_identity.dart';
import 'package:shared_preferences/shared_preferences.dart';

void main() {
  test('persists one anonymous quota identity', () async {
    SharedPreferences.setMockInitialValues(<String, Object>{});
    final SharedPreferencesAnonymousIdentityStore store =
        SharedPreferencesAnonymousIdentityStore();

    final String first = await store.getOrCreate();
    final String second = await store.getOrCreate();

    expect(first, isNotEmpty);
    expect(second, first);
    expect(first.length, lessThanOrEqualTo(96));
  });
}
