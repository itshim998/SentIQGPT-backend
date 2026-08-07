import 'dart:async';

import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:sentiq_chat/core/network/api_client.dart';
import 'package:sentiq_chat/core/network/sse_event.dart';
import 'package:sentiq_chat/features/research/data/deep_research_repository.dart';
import 'package:sentiq_chat/features/research/domain/deep_research_models.dart';
import 'package:uuid/uuid.dart';

class DeepResearchController extends StateNotifier<DeepResearchState> {
  DeepResearchController({
    required DeepResearchGateway repository,
    required this.conversationId,
  }) : _repository = repository,
       super(const DeepResearchState());

  static const Uuid _uuid = Uuid();
  final DeepResearchGateway _repository;
  final String conversationId;
  SentIQSseConnection? _connection;
  StreamSubscription<SentIQSseEvent>? _subscription;
  Timer? _pollTimer;
  bool _backgrounded = false;
  bool _disposed = false;

  Future<void> initialize() async {
    await refreshQuota();
  }

  Future<void> refreshQuota() async {
    try {
      final DeepResearchQuota quota = await _repository.quota();
      if (!_disposed) state = state.copyWith(quota: quota, clearMessage: true);
    } catch (error) {
      if (!_disposed) {
        state = state.copyWith(message: _message(error));
      }
    }
  }

  Future<bool> start(String prompt) async {
    final String normalized = prompt.trim();
    if (normalized.isEmpty || state.loading || state.running) return false;
    if (!state.quota.available) {
      state = state.copyWith(
        message: 'Your Deep Research allowance is currently used up.',
      );
      return false;
    }
    state = state.copyWith(
      loading: true,
      streamConnected: false,
      clearReport: true,
      clearMessage: true,
    );
    try {
      final DeepResearchReport report = await _repository.start(
        prompt: normalized,
        conversationId: conversationId,
        clientRequestId: _uuid.v4(),
      );
      if (_disposed) return false;
      state = state.copyWith(report: report, loading: false);
      await refreshQuota();
      await _subscribe(report.id);
      return true;
    } catch (error) {
      if (!_disposed) {
        state = state.copyWith(loading: false, message: _message(error));
      }
      return false;
    }
  }

  Future<void> resume(String reportId) async {
    if (reportId.trim().isEmpty) return;
    state = state.copyWith(loading: true, clearMessage: true);
    try {
      final DeepResearchReport report = await _repository.report(reportId);
      if (_disposed) return;
      state = state.copyWith(report: report, loading: false);
      if (!report.isTerminal) await _subscribe(report.id);
    } catch (error) {
      if (!_disposed) {
        state = state.copyWith(loading: false, message: _message(error));
      }
    }
  }

  Future<void> refresh() async {
    final String? id = state.report?.id;
    if (id == null || id.isEmpty) return;
    try {
      final DeepResearchReport report = await _repository.status(id);
      if (_disposed) return;
      state = state.copyWith(report: report, clearMessage: true);
      if (report.isTerminal) {
        await _stopStream();
        await refreshQuota();
      }
    } catch (error) {
      if (!_disposed) state = state.copyWith(message: _message(error));
    }
  }

  Future<void> cancel() async {
    final DeepResearchReport? active = state.report;
    if (active == null || active.status != DeepResearchStatus.running) return;
    state = state.copyWith(
      report: active.copyWith(
        cancellationRequested: true,
        statusText: 'Cancelling research…',
      ),
      clearMessage: true,
    );
    try {
      final DeepResearchReport report = await _repository.cancel(active.id);
      if (_disposed) return;
      state = state.copyWith(report: report);
      await _stopStream();
      await refreshQuota();
    } catch (error) {
      if (!_disposed) state = state.copyWith(message: _message(error));
    }
  }

  Future<SentIQBinaryResponse?> export(String format) async {
    final DeepResearchReport? report = state.report;
    if (report == null || report.status != DeepResearchStatus.completed) {
      state = state.copyWith(message: 'The report is not ready to export.');
      return null;
    }
    state = state.copyWith(exporting: true, clearMessage: true);
    try {
      final SentIQBinaryResponse response = await _repository.export(
        report.id,
        format,
      );
      if (!_disposed) state = state.copyWith(exporting: false);
      return response;
    } catch (error) {
      if (!_disposed) {
        state = state.copyWith(exporting: false, message: _message(error));
      }
      return null;
    }
  }

  Future<void> handleLifecycle(AppLifecycleState lifecycle) async {
    _backgrounded = lifecycle != AppLifecycleState.resumed;
    if (_backgrounded) {
      await _stopStream();
      return;
    }
    final DeepResearchReport? report = state.report;
    if (report == null || report.isTerminal) return;
    await refresh();
    if (state.report?.status == DeepResearchStatus.running) {
      await _subscribe(report.id);
    }
  }

  Future<void> _subscribe(String reportId) async {
    if (_backgrounded || _disposed || state.report?.isTerminal == true) return;
    await _stopStream();
    try {
      final SentIQSseConnection connection = await _repository.subscribe(
        reportId,
      );
      if (_disposed || _backgrounded) {
        await connection.cancel();
        return;
      }
      _connection = connection;
      state = state.copyWith(streamConnected: true, clearMessage: true);
      _subscription = connection.events.listen(
        _handleEvent,
        onError: (Object error, StackTrace stackTrace) {
          if (_disposed) return;
          state = state.copyWith(
            streamConnected: false,
            message: 'Research is still running. Reconnecting to updates…',
          );
          _schedulePoll();
        },
        onDone: () {
          if (_disposed) return;
          state = state.copyWith(streamConnected: false);
          if (state.running) _schedulePoll();
        },
      );
    } catch (error) {
      if (!_disposed) {
        state = state.copyWith(
          streamConnected: false,
          message: 'Research is still running. Reconnecting to updates…',
        );
        _schedulePoll();
      }
    }
  }

  void _handleEvent(SentIQSseEvent event) {
    if (_disposed || event.unsupportedVersion) return;
    final Map<String, Object?> payload = event.payload;
    final Map<String, Object?>? reportJson = _asMap(payload['report']);
    if (reportJson != null) {
      final DeepResearchReport incoming = DeepResearchReport.fromJson(
        reportJson,
      );
      final DeepResearchReport? existing = state.report;
      final DeepResearchReport report = incoming.copyWith(
        sources: incoming.sources.isEmpty
            ? existing?.sources
            : incoming.sources,
        partialContent: incoming.partialContent.isEmpty
            ? existing?.partialContent
            : incoming.partialContent,
      );
      state = state.copyWith(
        report: report,
        streamConnected: !report.isTerminal,
        clearMessage: true,
      );
      if (report.isTerminal) {
        unawaited(_stopStream());
        unawaited(refreshQuota());
      }
      return;
    }

    final DeepResearchReport? current = state.report;
    if (current == null) return;
    switch (event.type) {
      case 'init':
        state = state.copyWith(
          report: current.copyWith(
            status: DeepResearchStatus.running,
            statusText: 'Deep Research started.',
          ),
        );
        break;
      case 'progress':
      case 'deep_research_progress':
        final String step = (payload['step'] ?? payload['stage'] ?? '')
            .toString();
        final String query = payload['query']?.toString() ?? '';
        final DeepResearchPhase phase = switch (step) {
          'plan' => DeepResearchPhase.plan,
          'search' || 'searching' => DeepResearchPhase.search,
          'synthesize' || 'synthesizing' => DeepResearchPhase.synthesize,
          _ => current.phase,
        };
        final int progress = payload['progress'] is num
            ? (payload['progress'] as num).toInt().clamp(0, 100).toInt()
            : current.progressPercent;
        state = state.copyWith(
          report: current.copyWith(
            phase: phase,
            progressPercent: progress,
            statusText: query.isEmpty
                ? _phaseLabel(phase)
                : 'Searching: $query',
          ),
        );
        break;
      case 'sources':
      case 'deep_research_source':
        final List<DeepResearchSource> sources = _sources(payload);
        state = state.copyWith(
          report: current.copyWith(
            sources: sources.isEmpty ? current.sources : sources,
            statusText: sources.isEmpty
                ? current.statusText
                : 'Found ${sources.length} sources…',
          ),
        );
        break;
      case 'content':
        final String text = payload['text']?.toString() ?? '';
        if (text.isNotEmpty) {
          state = state.copyWith(
            report: current.copyWith(
              phase: DeepResearchPhase.synthesize,
              progressPercent: current.progressPercent < 90
                  ? 90
                  : current.progressPercent,
              partialContent: '${current.partialContent}$text',
              statusText: 'Writing final report sections…',
            ),
          );
        }
        break;
      case 'cancelled':
        state = state.copyWith(
          report: current.copyWith(
            status: DeepResearchStatus.cancelled,
            statusText: 'Research cancelled.',
          ),
          streamConnected: false,
        );
        unawaited(refreshQuota());
        break;
      case 'error':
      case 'deep_research_error':
        state = state.copyWith(
          report: current.copyWith(
            status: DeepResearchStatus.failed,
            statusText:
                payload['error']?.toString() ?? 'Research could not complete.',
          ),
          streamConnected: false,
          message: payload['error']?.toString(),
        );
        unawaited(refreshQuota());
        break;
      default:
        break;
    }
  }

  List<DeepResearchSource> _sources(Map<String, Object?> payload) {
    final Object? raw = payload['sources'];
    if (raw is List) {
      return raw
          .whereType<Map>()
          .map((Map item) {
            return DeepResearchSource.fromJson(
              item.map(
                (Object? key, Object? value) => MapEntry(key.toString(), value),
              ),
            );
          })
          .toList(growable: false);
    }
    final Map<String, Object?>? single = _asMap(payload['source']);
    if (single == null) return const <DeepResearchSource>[];
    return <DeepResearchSource>[DeepResearchSource.fromJson(single)];
  }

  void _schedulePoll() {
    if (_backgrounded || _disposed || !state.running) return;
    _pollTimer?.cancel();
    _pollTimer = Timer(const Duration(seconds: 3), () async {
      await refresh();
      if (state.running && !_backgrounded) {
        await _subscribe(state.report!.id);
      }
    });
  }

  Future<void> _stopStream() async {
    _pollTimer?.cancel();
    _pollTimer = null;
    await _subscription?.cancel();
    _subscription = null;
    await _connection?.cancel();
    _connection = null;
    if (!_disposed) state = state.copyWith(streamConnected: false);
  }

  @override
  void dispose() {
    _disposed = true;
    _pollTimer?.cancel();
    unawaited(_subscription?.cancel());
    unawaited(_connection?.cancel());
    super.dispose();
  }
}

Map<String, Object?>? _asMap(Object? value) {
  if (value is! Map) return null;
  return value.map(
    (Object? key, Object? nested) => MapEntry(key.toString(), nested),
  );
}

String _phaseLabel(DeepResearchPhase phase) {
  return switch (phase) {
    DeepResearchPhase.queued => 'Queued for Deep Research.',
    DeepResearchPhase.plan => 'Planning research path…',
    DeepResearchPhase.search => 'Searching the web…',
    DeepResearchPhase.synthesize => 'Synthesizing report…',
  };
}

String _message(Object error) {
  final String text = error.toString();
  return text.startsWith('Exception: ') ? text.substring(11) : text;
}
