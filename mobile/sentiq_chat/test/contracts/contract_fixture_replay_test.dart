import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:sentiq_chat/core/network/sse_event.dart';
import 'package:sentiq_chat/core/network/sse_parser.dart';

void main() {
  const SentIQSseParser parser = SentIQSseParser();

  test('replays chat, file, and Deep Research event streams', () async {
    final List<SentIQSseEvent> chat = await parser
        .parseText(await File('test/fixtures/chat_stream.sse').readAsString())
        .toList();
    final List<SentIQSseEvent> files = await parser
        .parseText(await File('test/fixtures/file_updates.sse').readAsString())
        .toList();
    final List<SentIQSseEvent> research = await parser
        .parseText(await File('test/fixtures/deep_research.sse').readAsString())
        .toList();

    expect(
      chat.any(
        (SentIQSseEvent event) => event.kind == SentIQSseEventKind.token,
      ),
      isTrue,
    );
    expect(
      files.every(
        (SentIQSseEvent event) => event.kind == SentIQSseEventKind.fileAnalysis,
      ),
      isTrue,
    );
    expect(
      research.every(
        (SentIQSseEvent event) => event.kind == SentIQSseEventKind.deepResearch,
      ),
      isTrue,
    );
  });

  test('replays image, billing, and Live response shapes', () async {
    for (final String name in <String>[
      'image_generate.json',
      'billing_me.json',
      'live_session.json',
    ]) {
      final Object? decoded = jsonDecode(
        await File('test/fixtures/$name').readAsString(),
      );
      expect(decoded, isA<Map<String, Object?>>(), reason: name);
    }
  });
}
