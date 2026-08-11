import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:sentiq_chat/core/network/sse_event.dart';
import 'package:sentiq_chat/core/network/sse_parser.dart';

void main() {
  test('replays every declared Phase 3 SSE event type', () async {
    final String fixture = await File(
      'test/fixtures/sse/all_events.sse',
    ).readAsString();
    final List<SentIQSseEvent> events = await const SentIQSseParser()
        .parseText(fixture)
        .toList();

    expect(events.map((SentIQSseEvent event) => event.type), <String>[
      'token',
      'file_token',
      'file_artifact',
      'thinking',
      'structured_response',
      'route',
      'tool_selected',
      'tool_started',
      'tool_result',
      'tool_error',
      'websurf_sources',
      'websurf_complete',
      'memory',
      'sync',
      'file_analysis',
      'deep_research_progress',
      'deep_research_source',
      'deep_research_complete',
      'deep_research_error',
      'error',
      'done',
    ]);
    expect(events.last.kind, SentIQSseEventKind.done);
    expect(
      events.where((SentIQSseEvent event) => event.unsupportedVersion),
      isEmpty,
    );
  });
}
