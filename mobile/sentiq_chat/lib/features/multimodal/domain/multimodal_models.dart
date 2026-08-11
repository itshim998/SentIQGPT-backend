// ignore_for_file: sort_constructors_first

import 'dart:convert';

enum ArtifactAction { copy, share, download, open }

class ImageQuotaState {
  const ImageQuotaState({
    this.remaining,
    this.limit,
    this.resetAt,
    this.cooldownActive = false,
    this.cooldownResetMs,
    this.message,
  });

  final int? remaining;
  final int? limit;
  final DateTime? resetAt;
  final bool cooldownActive;
  final int? cooldownResetMs;
  final String? message;

  bool get available =>
      !cooldownActive && (remaining == null || remaining! > 0);

  factory ImageQuotaState.fromJson(Map<String, Object?> json) {
    int? number(Object? value) =>
        value is num ? value.toInt() : int.tryParse(value?.toString() ?? '');
    final Object? reset = json['reset_at'] ?? json['resetAt'];
    return ImageQuotaState(
      remaining: number(json['remaining']),
      limit: number(json['limit']),
      resetAt: reset == null
          ? null
          : DateTime.tryParse(reset.toString())?.toUtc(),
      cooldownActive:
          json['cooldownActive'] == true || json['cooldown_active'] == true,
      cooldownResetMs: number(
        json['cooldownResetMs'] ?? json['cooldown_reset_ms'],
      ),
      message: (json['message'] ?? json['error'])?.toString(),
    );
  }
}

class GeneratedImagePayload {
  const GeneratedImagePayload({
    required this.url,
    this.id,
    this.prompt,
    this.provider,
    this.storagePath,
    this.fileSizeBytes,
    this.base64,
    this.warning,
    this.persisted,
  });

  final String url;
  final String? id;
  final String? prompt;
  final String? provider;
  final String? storagePath;
  final int? fileSizeBytes;
  final String? base64;
  final String? warning;
  final bool? persisted;

  factory GeneratedImagePayload.fromJson(Map<String, Object?> json) {
    final Map<String, Object?> source = _map(json['image'] ?? json);
    return GeneratedImagePayload(
      url: (source['image_url'] ?? source['url'] ?? '').toString(),
      id: (source['image_id'] ?? source['id'])?.toString(),
      prompt: (source['resolved_prompt'] ?? source['prompt'])?.toString(),
      provider: (source['provider_used'] ?? source['provider'])?.toString(),
      storagePath: source['storage_path']?.toString(),
      fileSizeBytes: _int(source['file_size_bytes']),
      base64: source['image_base64']?.toString(),
      warning: source['warning']?.toString(),
      persisted: source['persisted'] as bool?,
    );
  }

  bool get valid => _safeHttps(url) || (base64?.isNotEmpty ?? false);

  Map<String, Object?> toJson() => <String, Object?>{
    'type': 'image',
    'image_url': url,
    if (id != null) 'image_id': id,
    if (prompt != null) 'prompt': prompt,
    if (provider != null) 'provider_used': provider,
    if (storagePath != null) 'storage_path': storagePath,
    if (fileSizeBytes != null) 'file_size_bytes': fileSizeBytes,
    if (base64 != null) 'image_base64': base64,
    if (warning != null) 'warning': warning,
    if (persisted != null) 'persisted': persisted,
  };
}

class GeneratedArtifactPayload {
  const GeneratedArtifactPayload({
    required this.id,
    required this.fileName,
    required this.format,
    required this.mimeType,
    this.fileUrl,
    this.preview,
    this.html,
    this.text,
    this.version,
    this.fileSizeBytes,
  });

  final String id;
  final String fileName;
  final String format;
  final String mimeType;
  final String? fileUrl;
  final Map<String, Object?>? preview;
  final String? html;
  final String? text;
  final int? version;
  final int? fileSizeBytes;

  bool get editable => format.toLowerCase() == 'html';

  factory GeneratedArtifactPayload.fromJson(Map<String, Object?> json) {
    final Map<String, Object?> source = _map(
      json['file'] ?? json['artifact'] ?? json,
    );
    return GeneratedArtifactPayload(
      id:
          (source['file_id'] ??
                  source['generated_file_id'] ??
                  source['id'] ??
                  '')
              .toString(),
      fileName: (source['file_name'] ?? source['name'] ?? 'Generated file')
          .toString(),
      format: (source['format'] ?? source['file_format'] ?? 'file').toString(),
      mimeType: (source['mime_type'] ?? 'application/octet-stream').toString(),
      fileUrl: (source['file_url'] ?? source['url'])?.toString(),
      preview: _nullableMap(source['preview'] ?? source['preview_json']),
      html: source['html']?.toString(),
      text: source['text']?.toString(),
      version: _int(source['version']),
      fileSizeBytes: _int(source['file_size_bytes']),
    );
  }

  bool get valid => id.isNotEmpty || _safeHttps(fileUrl ?? '');

  Map<String, Object?> toJson() => <String, Object?>{
    'type': 'generated-file',
    'file_id': id,
    'file_name': fileName,
    'format': format,
    'mime_type': mimeType,
    if (fileUrl != null) 'file_url': fileUrl,
    if (preview != null) 'preview': preview,
    if (html != null) 'html': html,
    if (text != null) 'text': text,
    if (version != null) 'version': version,
    if (fileSizeBytes != null) 'file_size_bytes': fileSizeBytes,
  };
}

class WebSurfSourcePayload {
  const WebSurfSourcePayload({
    required this.id,
    required this.title,
    required this.url,
    required this.domain,
    required this.snippet,
    this.publishedAt,
    this.faviconUrl,
    this.thumbnailUrl,
  });

  final String id;
  final String title;
  final String url;
  final String domain;
  final String snippet;
  final String? publishedAt;
  final String? faviconUrl;
  final String? thumbnailUrl;

  factory WebSurfSourcePayload.fromJson(Map<String, Object?> json, int index) {
    return WebSurfSourcePayload(
      id: (json['id'] ?? 'S${index + 1}').toString(),
      title: (json['title'] ?? json['domain'] ?? 'Source').toString(),
      url: (json['url'] ?? '').toString(),
      domain: (json['domain'] ?? '').toString(),
      snippet: (json['snippet'] ?? '').toString(),
      publishedAt: json['published_at']?.toString(),
      faviconUrl: json['favicon_url']?.toString(),
      thumbnailUrl: json['thumbnail_url']?.toString(),
    );
  }

  bool get safe => _safeHttps(url);
}

class WebSurfPayload {
  const WebSurfPayload({
    required this.query,
    required this.sources,
    this.imageUrls = const <String>[],
    this.answer,
    this.partial = false,
    this.error,
  });

  final String query;
  final List<WebSurfSourcePayload> sources;
  final List<String> imageUrls;
  final String? answer;
  final bool partial;
  final String? error;

  factory WebSurfPayload.fromJson(Map<String, Object?> json) {
    final Map<String, Object?> web = _map(
      json['web_search'] ?? json['websurf_v2'] ?? json,
    );
    final Object? rawSources = web['sources'];
    final List<WebSurfSourcePayload> sources = rawSources is List
        ? rawSources
              .whereType<Map>()
              .toList()
              .asMap()
              .entries
              .map(
                (entry) => WebSurfSourcePayload.fromJson(
                  entry.value.map(
                    (key, value) => MapEntry(key.toString(), value),
                  ),
                  entry.key,
                ),
              )
              .where((source) => source.safe)
              .toList()
        : const <WebSurfSourcePayload>[];
    final Object? rawImages = web['images'] ?? json['images'];
    final List<String> imageUrls = rawImages is List
        ? rawImages
              .map((Object? value) => value?.toString() ?? '')
              .where(_safeHttps)
              .toSet()
              .take(12)
              .toList()
        : const <String>[];
    final String? answer = (json['answer'] ?? web['answer'])?.toString();
    return WebSurfPayload(
      query: (web['query'] ?? '').toString(),
      sources: sources,
      imageUrls: imageUrls,
      answer: answer,
      partial:
          json['partial'] == true ||
          (answer?.trim().isEmpty ?? true) && sources.isNotEmpty,
      error: (json['error'] ?? web['error'])?.toString(),
    );
  }

  Map<String, Object?> toJson() => <String, Object?>{
    'query': query,
    'sources': sources
        .map(
          (source) => <String, Object?>{
            'id': source.id,
            'title': source.title,
            'url': source.url,
            'domain': source.domain,
            'snippet': source.snippet,
            if (source.publishedAt != null) 'published_at': source.publishedAt,
            if (source.faviconUrl != null) 'favicon_url': source.faviconUrl,
            if (source.thumbnailUrl != null)
              'thumbnail_url': source.thumbnailUrl,
          },
        )
        .toList(),
    if (imageUrls.isNotEmpty) 'images': imageUrls,
    if (answer != null) 'answer': answer,
    if (partial) 'partial': true,
    if (error != null) 'error': error,
  };
}

class ChartPayload {
  const ChartPayload({
    required this.type,
    required this.labels,
    required this.series,
    this.title,
    this.error,
  });

  final String type;
  final List<String> labels;
  final List<List<double>> series;
  final String? title;
  final String? error;

  bool get valid =>
      error == null && series.isNotEmpty && series.first.isNotEmpty;

  factory ChartPayload.fromJson(Map<String, Object?> json) {
    try {
      final Map<String, Object?> source = _map(json['chart'] ?? json);
      final Map<String, Object?> config = _map(
        source['chartjs_config'] ?? source['chartjsConfig'],
      );
      if (config.isNotEmpty) return _fromChartJs(source, config);
      final Map<String, Object?> plotly = _map(source['plotly_json']);
      if (plotly.isNotEmpty) return _fromPlotly(source, plotly);
      return const ChartPayload(
        type: 'unknown',
        labels: <String>[],
        series: <List<double>>[],
        error: 'This chart did not include a supported data payload.',
      );
    } catch (_) {
      return const ChartPayload(
        type: 'unknown',
        labels: <String>[],
        series: <List<double>>[],
        error: 'The chart data was malformed and could not be displayed.',
      );
    }
  }

  static ChartPayload _fromChartJs(
    Map<String, Object?> source,
    Map<String, Object?> config,
  ) {
    final String type = (config['type'] ?? source['chart_type'] ?? 'bar')
        .toString();
    final Map<String, Object?> data = _map(config['data']);
    final List<String> labels = _strings(data['labels']);
    final Object? rawDatasets = data['datasets'];
    final List<List<double>> series = rawDatasets is List
        ? rawDatasets
              .whereType<Map>()
              .map((dataset) => _numbers(dataset['data']))
              .where((values) => values.isNotEmpty)
              .toList()
        : <List<double>>[];
    return ChartPayload(
      type: type,
      labels: labels,
      series: series,
      title: _chartTitle(config) ?? source['title']?.toString(),
      error: series.isEmpty
          ? 'The chart did not contain numeric values.'
          : null,
    );
  }

  static ChartPayload _fromPlotly(
    Map<String, Object?> source,
    Map<String, Object?> plotly,
  ) {
    final Object? rawData = plotly['data'];
    final List<Map<String, Object?>> traces = rawData is List
        ? rawData
              .whereType<Map>()
              .map(
                (item) =>
                    item.map((key, value) => MapEntry(key.toString(), value)),
              )
              .toList()
        : <Map<String, Object?>>[];
    final List<List<double>> series = traces
        .map((trace) => _numbers(trace['y'] ?? trace['values'] ?? trace['x']))
        .where((values) => values.isNotEmpty)
        .toList();
    final List<String> labels = traces.isEmpty
        ? <String>[]
        : _strings(traces.first['x'] ?? traces.first['labels']);
    final Map<String, Object?> layout = _map(plotly['layout']);
    return ChartPayload(
      type:
          (source['chart_type'] ??
                  (traces.isEmpty ? null : traces.first['type']) ??
                  'line')
              .toString(),
      labels: labels,
      series: series,
      title:
          _map(layout['title'])['text']?.toString() ??
          layout['title']?.toString(),
      error: series.isEmpty
          ? 'The chart did not contain numeric values.'
          : null,
    );
  }
}

Map<String, Object?> _map(Object? value) {
  if (value is String) {
    try {
      value = jsonDecode(value);
    } on FormatException {
      return <String, Object?>{};
    }
  }
  if (value is! Map) return <String, Object?>{};
  return value.map((key, nested) => MapEntry(key.toString(), nested));
}

Map<String, Object?>? _nullableMap(Object? value) {
  final Map<String, Object?> result = _map(value);
  return result.isEmpty ? null : result;
}

int? _int(Object? value) =>
    value is num ? value.toInt() : int.tryParse(value?.toString() ?? '');

List<String> _strings(Object? value) =>
    value is List ? value.map((item) => item.toString()).toList() : <String>[];

List<double> _numbers(Object? value) => value is List
    ? value
          .map(
            (item) => item is num
                ? item.toDouble()
                : double.tryParse(item.toString()),
          )
          .whereType<double>()
          .toList()
    : <double>[];

String? _chartTitle(Map<String, Object?> config) {
  final Map<String, Object?> options = _map(config['options']);
  final Map<String, Object?> plugins = _map(options['plugins']);
  final Map<String, Object?> title = _map(plugins['title']);
  return title['text']?.toString();
}

bool _safeHttps(String value) {
  final Uri? uri = Uri.tryParse(value.trim());
  return uri != null &&
      uri.scheme == 'https' &&
      uri.host.isNotEmpty &&
      uri.userInfo.isEmpty;
}
