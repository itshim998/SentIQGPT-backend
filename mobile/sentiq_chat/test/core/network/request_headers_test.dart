import 'package:flutter_test/flutter_test.dart';
import 'package:sentiq_chat/core/network/anonymous_identity.dart';
import 'package:sentiq_chat/core/network/auth_token_provider.dart';
import 'package:sentiq_chat/core/network/request_headers.dart';

void main() {
  test('adds anonymous, contract, and bearer identity headers', () async {
    final MutableAuthTokenProvider tokenProvider = MutableAuthTokenProvider()
      ..setToken('access-token');
    final SentIQRequestHeaders headers = SentIQRequestHeaders(
      authTokenProvider: tokenProvider,
      anonymousIdentityStore: MemoryAnonymousIdentityStore(
        seed: 'anonymous-id',
      ),
      mobileContractVersion: 1,
    );

    final Map<String, String> result = await headers.build();

    expect(result['Authorization'], 'Bearer access-token');
    expect(result['X-SentIQ-Anonymous-Id'], 'anonymous-id');
    expect(result['X-SentIQ-Mobile-Contract'], '1');
    expect(result['Content-Type'], 'application/json');
  });
}
