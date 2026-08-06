import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:sentiq_chat/core/network/anonymous_identity.dart';
import 'package:sentiq_chat/core/network/api_client.dart';
import 'package:sentiq_chat/core/network/auth_token_provider.dart';
import 'package:sentiq_chat/core/network/request_headers.dart';

void main() {
  test('resolves endpoints and applies identity headers', () async {
    late http.Request captured;
    final MockClient mockClient = MockClient((http.Request request) async {
      captured = request;
      return http.Response('{"ok":true}', 200);
    });
    final SentIQApiClient client = SentIQApiClient(
      baseUri: Uri.parse('https://api.example.test'),
      requestHeaders: SentIQRequestHeaders(
        authTokenProvider: const EmptyAuthTokenProvider(),
        anonymousIdentityStore:
            MemoryAnonymousIdentityStore(seed: 'quota-session'),
        mobileContractVersion: 1,
      ),
      httpClient: mockClient,
    );

    final Map<String, Object?> response = await client.getJson('/api/config');

    expect(response['ok'], isTrue);
    expect(captured.url.toString(), 'https://api.example.test/api/config');
    expect(captured.headers['X-SentIQ-Anonymous-Id'], 'quota-session');
    expect(captured.headers['X-SentIQ-Mobile-Contract'], '1');
    client.close();
  });
}
