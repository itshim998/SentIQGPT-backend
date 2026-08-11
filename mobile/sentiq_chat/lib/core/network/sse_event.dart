enum SentIQSseEventKind {
  token,
  fileToken,
  fileArtifact,
  thinking,
  structuredResponse,
  route,
  toolSelected,
  toolStarted,
  toolResult,
  toolError,
  webSurfSources,
  webSurfComplete,
  memory,
  sync,
  fileAnalysis,
  deepResearch,
  error,
  done,
  unknown,
}

class SentIQSseEvent {
  const SentIQSseEvent({
    required this.type,
    required this.version,
    required this.kind,
    required this.payload,
    required this.rawData,
    this.id,
    this.unsupportedVersion = false,
  });

  final String type;
  final int version;
  final SentIQSseEventKind kind;
  final Map<String, Object?> payload;
  final String rawData;
  final String? id;
  final bool unsupportedVersion;

  bool get isTerminal =>
      kind == SentIQSseEventKind.done || kind == SentIQSseEventKind.error;

  static SentIQSseEventKind classify(String type) {
    return switch (type) {
      'token' => SentIQSseEventKind.token,
      'file_token' => SentIQSseEventKind.fileToken,
      'file_artifact' => SentIQSseEventKind.fileArtifact,
      'thinking' => SentIQSseEventKind.thinking,
      'structured_response' => SentIQSseEventKind.structuredResponse,
      'route' => SentIQSseEventKind.route,
      'tool_selected' => SentIQSseEventKind.toolSelected,
      'tool_started' => SentIQSseEventKind.toolStarted,
      'tool_result' => SentIQSseEventKind.toolResult,
      'tool_error' => SentIQSseEventKind.toolError,
      'websurf_sources' => SentIQSseEventKind.webSurfSources,
      'websurf_complete' => SentIQSseEventKind.webSurfComplete,
      'memory' => SentIQSseEventKind.memory,
      'sync' => SentIQSseEventKind.sync,
      'file_analysis' => SentIQSseEventKind.fileAnalysis,
      'init' ||
      'progress' ||
      'sources' ||
      'content' ||
      'snapshot' ||
      'cancelled' ||
      'deep_research_progress' ||
      'deep_research_source' ||
      'deep_research_complete' ||
      'deep_research_error' => SentIQSseEventKind.deepResearch,
      'error' => SentIQSseEventKind.error,
      'done' => SentIQSseEventKind.done,
      _ => SentIQSseEventKind.unknown,
    };
  }
}
