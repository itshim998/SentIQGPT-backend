enum DeepResearchStatus { idle, running, completed, failed, cancelled }

enum DeepResearchPhase { queued, plan, search, synthesize }

class DeepResearchSource {
  const DeepResearchSource({required this.title, required this.url});

  factory DeepResearchSource.fromJson(Map<String, Object?> json) {
    return DeepResearchSource(
      title: json['title']?.toString().trim().isNotEmpty == true
          ? json['title'].toString().trim()
          : 'Source',
      url: json['url']?.toString().trim() ?? '',
    );
  }

  final String title;
  final String url;

  bool get hasSafeUrl {
    final Uri? uri = Uri.tryParse(url);
    return uri != null &&
        uri.scheme == 'https' &&
        uri.host.isNotEmpty &&
        uri.userInfo.isEmpty;
  }
}

class DeepResearchQuota {
  const DeepResearchQuota({
    this.remaining = 0,
    this.limit = 0,
    this.resetAt,
    this.planCode = 'free',
  });

  factory DeepResearchQuota.fromJson(Map<String, Object?> json) {
    return DeepResearchQuota(
      remaining: _integer(json['remaining']),
      limit: _integer(json['limit']),
      resetAt: _dateTime(json['reset_at']),
      planCode: json['plan_code']?.toString() ?? 'free',
    );
  }

  final int remaining;
  final int limit;
  final DateTime? resetAt;
  final String planCode;

  bool get available => remaining > 0;
}

class DeepResearchReport {
  const DeepResearchReport({
    required this.id,
    required this.conversationId,
    this.messageId,
    required this.title,
    required this.status,
    required this.phase,
    required this.progressPercent,
    required this.statusText,
    required this.partialContent,
    required this.content,
    this.sources = const <DeepResearchSource>[],
    this.searchCount = 0,
    this.citationCount = 0,
    this.cancellationRequested = false,
    this.startedAt,
    this.updatedAt,
    this.completedAt,
    this.cancelledAt,
    this.failedAt,
  });

  factory DeepResearchReport.fromJson(Map<String, Object?> json) {
    final List<DeepResearchSource> sources = _mapList(
      json['sources'],
    ).map(DeepResearchSource.fromJson).toList(growable: false);
    return DeepResearchReport(
      id: (json['report_id'] ?? json['id'] ?? '').toString(),
      conversationId: (json['conversation_id'] ?? '').toString(),
      messageId: _nullableString(json['message_id']),
      title: json['title']?.toString() ?? 'Deep Research report',
      status: _status(json['status']),
      phase: _phase(json['progress_phase'] ?? json['phase']),
      progressPercent: _integer(
        json['progress_percent'] ?? json['progress'],
      ).clamp(0, 100).toInt(),
      statusText:
          json['latest_status_text']?.toString() ??
          json['status_text']?.toString() ??
          '',
      partialContent: json['partial_content']?.toString() ?? '',
      content: json['content']?.toString() ?? '',
      sources: sources,
      searchCount: _integer(json['search_count']),
      citationCount: _integer(json['citation_count']),
      cancellationRequested: json['cancellation_requested'] == true,
      startedAt: _dateTime(json['started_at']),
      updatedAt: _dateTime(json['updated_at']),
      completedAt: _dateTime(json['completed_at']),
      cancelledAt: _dateTime(json['cancelled_at']),
      failedAt: _dateTime(json['failed_at']),
    );
  }

  final String id;
  final String conversationId;
  final String? messageId;
  final String title;
  final DeepResearchStatus status;
  final DeepResearchPhase phase;
  final int progressPercent;
  final String statusText;
  final String partialContent;
  final String content;
  final List<DeepResearchSource> sources;
  final int searchCount;
  final int citationCount;
  final bool cancellationRequested;
  final DateTime? startedAt;
  final DateTime? updatedAt;
  final DateTime? completedAt;
  final DateTime? cancelledAt;
  final DateTime? failedAt;

  bool get isTerminal =>
      status == DeepResearchStatus.completed ||
      status == DeepResearchStatus.failed ||
      status == DeepResearchStatus.cancelled;

  String get visibleContent => content.isNotEmpty ? content : partialContent;

  DeepResearchReport copyWith({
    DeepResearchStatus? status,
    DeepResearchPhase? phase,
    int? progressPercent,
    String? statusText,
    String? partialContent,
    String? content,
    List<DeepResearchSource>? sources,
    int? searchCount,
    int? citationCount,
    bool? cancellationRequested,
    DateTime? updatedAt,
  }) {
    return DeepResearchReport(
      id: id,
      conversationId: conversationId,
      messageId: messageId,
      title: title,
      status: status ?? this.status,
      phase: phase ?? this.phase,
      progressPercent: progressPercent ?? this.progressPercent,
      statusText: statusText ?? this.statusText,
      partialContent: partialContent ?? this.partialContent,
      content: content ?? this.content,
      sources: sources ?? this.sources,
      searchCount: searchCount ?? this.searchCount,
      citationCount: citationCount ?? this.citationCount,
      cancellationRequested:
          cancellationRequested ?? this.cancellationRequested,
      startedAt: startedAt,
      updatedAt: updatedAt ?? this.updatedAt,
      completedAt: completedAt,
      cancelledAt: cancelledAt,
      failedAt: failedAt,
    );
  }
}

class DeepResearchState {
  const DeepResearchState({
    this.quota = const DeepResearchQuota(),
    this.report,
    this.loading = false,
    this.streamConnected = false,
    this.exporting = false,
    this.message,
  });

  final DeepResearchQuota quota;
  final DeepResearchReport? report;
  final bool loading;
  final bool streamConnected;
  final bool exporting;
  final String? message;

  bool get running => report?.status == DeepResearchStatus.running;

  DeepResearchState copyWith({
    DeepResearchQuota? quota,
    DeepResearchReport? report,
    bool clearReport = false,
    bool? loading,
    bool? streamConnected,
    bool? exporting,
    String? message,
    bool clearMessage = false,
  }) {
    return DeepResearchState(
      quota: quota ?? this.quota,
      report: clearReport ? null : report ?? this.report,
      loading: loading ?? this.loading,
      streamConnected: streamConnected ?? this.streamConnected,
      exporting: exporting ?? this.exporting,
      message: clearMessage ? null : message ?? this.message,
    );
  }
}

List<Map<String, Object?>> _mapList(Object? value) {
  if (value is! List) return const <Map<String, Object?>>[];
  return value
      .whereType<Map>()
      .map((Map item) {
        return item.map(
          (Object? key, Object? nested) => MapEntry(key.toString(), nested),
        );
      })
      .toList(growable: false);
}

int _integer(Object? value) => value is num ? value.toInt() : 0;

String? _nullableString(Object? value) {
  final String text = value?.toString().trim() ?? '';
  return text.isEmpty ? null : text;
}

DateTime? _dateTime(Object? value) {
  final String text = value?.toString() ?? '';
  return text.isEmpty ? null : DateTime.tryParse(text)?.toLocal();
}

DeepResearchStatus _status(Object? value) {
  return switch (value?.toString()) {
    'running' => DeepResearchStatus.running,
    'completed' => DeepResearchStatus.completed,
    'failed' => DeepResearchStatus.failed,
    'cancelled' => DeepResearchStatus.cancelled,
    _ => DeepResearchStatus.idle,
  };
}

DeepResearchPhase _phase(Object? value) {
  return switch (value?.toString()) {
    'plan' => DeepResearchPhase.plan,
    'search' || 'searching' => DeepResearchPhase.search,
    'synthesize' || 'synthesizing' => DeepResearchPhase.synthesize,
    _ => DeepResearchPhase.queued,
  };
}
