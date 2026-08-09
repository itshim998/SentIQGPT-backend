import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';
import 'package:sentiq_chat/core/network/anonymous_identity.dart';
import 'package:sentiq_chat/core/network/api_client.dart';
import 'package:sentiq_chat/core/network/auth_token_provider.dart';
import 'package:sentiq_chat/core/network/request_headers.dart';
import 'package:sentiq_chat/features/workspace/data/cloud_conversation_source.dart';
import 'package:sentiq_chat/features/workspace/domain/conversation_summary.dart';

void main() {
  test('repairs fallback title through the web first-exchange endpoint', () async {
    int titleCalls = 0;
    final MockClient httpClient = MockClient((http.Request request) async {
      if (request.method == 'GET' &&
          request.url.path == '/api/conversations/chat-1/messages') {
        return http.Response(
          jsonEncode(<String, Object?>{
            'messages': <Object?>[
              <String, Object?>{
                'role': 'user',
                'content': 'Explain why this synchronization race occurs',
              },
              <String, Object?>{
                'role': 'assistant',
                'content': 'The refresh guard drops the later request.',
              },
            ],
          }),
          200,
          headers: const <String, String>{
            'content-type': 'application/json',
          },
        );
      }
      if (request.method == 'POST' && request.url.path == '/api/chat/title') {
        titleCalls += 1;
        final Object? decoded = jsonDecode(request.body);
        expect(decoded, isA<Map>());
        final Map<String, Object?> body = (decoded! as Map).map(
          (Object? key, Object? value) => MapEntry(key.toString(), value),
        );
        expect(
          body['userMessage'],
          'Explain why this synchronization race occurs',
        );
        expect(
          body['assistantReply'],
          'The refresh guard drops the later request.',
        );
        expect(body['conversationId'], 'chat-1');
        return http.Response(
          jsonEncode(<String, Object?>{'title': 'Synchronization Race Fix'}),
          200,
          headers: const <String, String>{
            'content-type': 'application/json',
          },
        );
      }
      return http.Response('not found', 404);
    });
    final SentIQApiClient client = SentIQApiClient(
      baseUri: Uri.parse('https://example.invalid'),
      requestHeaders: SentIQRequestHeaders(
        authTokenProvider: const EmptyAuthTokenProvider(),
        anonymousIdentityStore: MemoryAnonymousIdentityStore(),
        mobileContractVersion: 1,
      ),
      httpClient: httpClient,
    );
    final CloudConversationSource source = CloudConversationSource(client);
    final ConversationSummary conversation = ConversationSummary(
      id: 'chat-1',
      ownerScope: 'user-1',
      title: 'Explain why this synchronization race occurs',
      createdAt: DateTime.utc(2026, 8, 9),
      updatedAt: DateTime.utc(2026, 8, 9),
      syncState: ConversationSyncState.synced,
      messageCount: 2,
      firstUserMessage: 'Explain why this synchronization race occurs',
    );

    final ConversationSummary repaired = await source.repairGeneratedTitle(
      'user-1',
      conversation,
    );

    expect(titleCalls, 1);
    expect(repaired.title, 'Synchronization Race Fix');
    expect(repaired.needsGeneratedTitle, isFalse);
    httpClient.close();
  });

  test('parses authoritative activity and backend merge aliases', () async {
    final MockClient httpClient = MockClient((http.Request request) async {
      expect(request.method, 'GET');
      expect(request.url.path, '/api/conversations');
      return http.Response(
        jsonEncode(<String, Object?>{
          'conversations': <Object?>[
            <String, Object?>{
              'id': 'canonical-id',
              'title': 'Canonical title',
              'created_at': '2026-08-01T00:00:00Z',
              'last_activity_at': '2026-08-09T10:00:00Z',
              'message_count': 2,
              'first_user_message': 'Hello',
            },
          ],
          'merged': <Object?>[
            <String, Object?>{
              'from': 'retired-id',
              'to': 'canonical-id',
              'reason': 'duplicate',
            },
          ],
        }),
        200,
        headers: const <String, String>{'content-type': 'application/json'},
      );
    });
    final CloudConversationSource source = CloudConversationSource(
      SentIQApiClient(
        baseUri: Uri.parse('https://example.invalid'),
        requestHeaders: SentIQRequestHeaders(
          authTokenProvider: const EmptyAuthTokenProvider(),
          anonymousIdentityStore: MemoryAnonymousIdentityStore(),
          mobileContractVersion: 1,
        ),
        httpClient: httpClient,
      ),
    );

    final CloudConversationSnapshot snapshot = await source.snapshot('user-1');

    expect(snapshot.items.single.id, 'canonical-id');
    expect(
      snapshot.items.single.updatedAt,
      DateTime.parse('2026-08-09T10:00:00Z').toUtc(),
    );
    expect(snapshot.aliases, const <String, String>{
      'retired-id': 'canonical-id',
    });
    httpClient.close();
  });
}
