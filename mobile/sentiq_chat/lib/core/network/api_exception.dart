class SentIQApiException implements Exception {
  const SentIQApiException({
    required this.message,
    required this.statusCode,
    this.code,
    this.details,
  });

  final String message;
  final int statusCode;
  final String? code;
  final Map<String, Object?>? details;

  @override
  String toString() => 'SentIQApiException($statusCode, $code, $message)';
}
