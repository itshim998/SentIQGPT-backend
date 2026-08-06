import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:sentiq_chat/features/multimodal/domain/multimodal_models.dart';

void main() {
  test('replays complete WebSurf source and image result fixtures', () {
    final Map<String, Object?> fixture =
        (jsonDecode(
                  File(
                    'test/fixtures/phase4/websurf-complete.json',
                  ).readAsStringSync(),
                )
                as Map)
            .map((key, value) => MapEntry(key.toString(), value));
    final WebSurfPayload payload = WebSurfPayload.fromJson(fixture);
    expect(payload.sources, hasLength(2));
    expect(payload.sources.first.thumbnailUrl, startsWith('https://'));
    expect(payload.imageUrls, hasLength(1));
    expect(payload.partial, isFalse);
    expect(payload.answer, contains('Grounded'));
  });

  test('preserves honest partial and failure states', () {
    final WebSurfPayload partial = WebSurfPayload.fromJson(<String, Object?>{
      'web_search': <String, Object?>{
        'query': 'current query',
        'sources': <Object?>[
          <String, Object?>{
            'id': 'S1',
            'title': 'Secure source',
            'url': 'https://example.com',
            'domain': 'example.com',
            'snippet': 'Result',
          },
          <String, Object?>{
            'id': 'S2',
            'title': 'Blocked source',
            'url': 'http://example.com',
            'domain': 'example.com',
            'snippet': 'Insecure',
          },
        ],
      },
      'partial': true,
      'error': 'One search provider disconnected.',
    });
    expect(partial.partial, isTrue);
    expect(partial.error, isNotNull);
    expect(partial.sources, hasLength(1));
  });
}
