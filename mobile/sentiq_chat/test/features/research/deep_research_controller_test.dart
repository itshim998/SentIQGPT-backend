import 'dart:async';
import 'dart:typed_data';

import 'package:flutter/widgets.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sentiq_chat/core/network/api_client.dart';
import 'package:sentiq_chat/core/network/sse_event.dart';
import 'package:sentiq_chat/features/research/application/deep_research_controller.dart';
import 'package:sentiq_chat/features/research/data/deep_research_repository.dart';
import 'package:sentiq_chat/features/research/domain/deep_research_models.dart';

void main() {
  test('replays progress, sources, content and completion events', () async {
    final _ResearchFake gateway = _ResearchFake();
    final DeepResearchController controller = DeepResearchController(
      repository: gateway,
      conversationId: 'conversation-1',
    );
    await controller.initialize();

    expect(await controller.start('Investigate the topic'), isTrue);
    gateway.emit('progress', <String, Object?>{
      'progress': 35,
      'stage': 'searching',
      'query': 'primary evidence',
    });
    gateway.emit('sources', <String, Object?>{
      'sources': <Map<String, Object?>>[
        <String, Object?>{
          'title': 'Primary',
          'url': 'https://example.com/source',
        },
      ],
    });
    gateway.emit('content', <String, Object?>{'text': 'Draft section.'});
    gateway.emit('snapshot', <String, Object?>{
      'report': _report(
        status: DeepResearchStatus.completed,
        progress: 100,
        content: 'Final report.',
      ),
    });
    await Future<void>.delayed(Duration.zero);

    expect(controller.state.report?.progressPercent, 100);
    expect(controller.state.report?.sources.single.title, 'Primary');
    expect(controller.state.report?.content, 'Final report.');
    expect(controller.state.streamConnected, isFalse);
    controller.dispose();
    await gateway.close();
  });

  test(
    'backgrounding disconnects updates and resume polls then reconnects',
    () async {
      final _ResearchFake gateway = _ResearchFake();
      final DeepResearchController controller = DeepResearchController(
        repository: gateway,
        conversationId: 'conversation-1',
      );
      await controller.initialize();
      await controller.start('Research this');

      await controller.handleLifecycle(AppLifecycleState.paused);
      expect(gateway.cancelCount, 1);
      expect(controller.state.streamConnected, isFalse);

      await controller.handleLifecycle(AppLifecycleState.resumed);
      expect(gateway.statusCount, 1);
      expect(gateway.subscribeCount, 2);
      controller.dispose();
      await gateway.close();
    },
  );

  test('cancel requests the durable report cancellation endpoint', () async {
    final _ResearchFake gateway = _ResearchFake();
    final DeepResearchController controller = DeepResearchController(
      repository: gateway,
      conversationId: 'conversation-1',
    );
    await controller.initialize();
    await controller.start('Research this');
    await controller.cancel();

    expect(gateway.cancelReportCount, 1);
    expect(controller.state.report?.status, DeepResearchStatus.cancelled);
    controller.dispose();
    await gateway.close();
  });
}

class _ResearchFake implements DeepResearchGateway {
  final StreamController<SentIQSseEvent> events =
      StreamController<SentIQSseEvent>.broadcast();
  int subscribeCount = 0;
  int cancelCount = 0;
  int statusCount = 0;
  int cancelReportCount = 0;

  @override
  Future<DeepResearchQuota> quota() async =>
      const DeepResearchQuota(remaining: 3, limit: 7, planCode: 'free');

  @override
  Future<DeepResearchReport> start({
    required String prompt,
    required String conversationId,
    required String clientRequestId,
  }) async => DeepResearchReport.fromJson(_report());

  @override
  Future<DeepResearchReport> status(String reportId) async {
    statusCount += 1;
    return DeepResearchReport.fromJson(_report());
  }

  @override
  Future<DeepResearchReport> report(String reportId) async =>
      DeepResearchReport.fromJson(_report());

  @override
  Future<SentIQSseConnection> subscribe(String reportId) async {
    subscribeCount += 1;
    return SentIQSseConnection(
      events: events.stream,
      onCancel: () async => cancelCount += 1,
    );
  }

  @override
  Future<DeepResearchReport> cancel(String reportId) async {
    cancelReportCount += 1;
    return DeepResearchReport.fromJson(
      _report(status: DeepResearchStatus.cancelled),
    );
  }

  @override
  Future<SentIQBinaryResponse> export(String reportId, String format) async {
    return SentIQBinaryResponse(
      bytes: Uint8List.fromList(<int>[1, 2, 3]),
      contentType: 'text/markdown',
      filename: 'report.md',
    );
  }

  void emit(String type, Map<String, Object?> payload) {
    events.add(
      SentIQSseEvent(
        type: type,
        version: 1,
        kind: SentIQSseEventKind.deepResearch,
        payload: <String, Object?>{'type': type, ...payload},
        rawData: '',
      ),
    );
  }

  Future<void> close() => events.close();
}

Map<String, Object?> _report({
  DeepResearchStatus status = DeepResearchStatus.running,
  int progress = 10,
  String content = '',
}) {
  return <String, Object?>{
    'report_id': 'report-1',
    'conversation_id': 'conversation-1',
    'title': 'Research report',
    'status': status.name,
    'progress_phase': 'search',
    'progress_percent': progress,
    'latest_status_text': 'Searching…',
    'partial_content': '',
    'content': content,
    'sources': const <Object?>[],
  };
}
