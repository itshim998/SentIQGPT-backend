import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:sentiq_chat/core/network/sse_event.dart';
import 'package:sentiq_chat/core/network/sse_parser.dart';

void main() {
  const SentIQSseParser parser = SentIQSseParser();

  test('parses known events, unknown events, and completion', () async {
    final String fixture =
        await File('test/fixtures/chat_stream.sse').readAsString();
    final List<SentIQSseEvent> events =
        await parser.parseText(fixture).toList();

    expect(events.map((SentIQSseEvent event) => event.kind), containsAll(<SentIQSseEventKind>[
      SentIQSseEventKind.route,
      SentIQSseEventKind.token,
      SentIQSseEventKind.toolStarted,
      SentIQSseEventKind.unknown,
      SentIQSseEventKind.done,
    ]));
    expect(
      events.firstWhere((SentIQSseEvent event) => event.type == 'future_event').payload['value'],
      'preserve safely',
    );
  });

  test('marks newer envelope versions without throwing', () async {
    final List<SentIQSseEvent> events = await parser
        .parseText('data: {"type":"token","version":2,"text":"future"}\n\n')
        .toList();

    expect(events.single.unsupportedVersion, isTrue);
    expect(events.single.payload['text'], 'future');
  });
}
