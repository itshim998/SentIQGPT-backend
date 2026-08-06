import 'dart:convert';

import 'package:http/http.dart' as http;
import 'package:sentiq_chat/core/network/api_exception.dart';
import 'package:sentiq_chat/core/network/request_headers.dart';
import 'package:sentiq_chat/core/network/sse_event.dart';
import 'package:sentiq_chat/core/network/sse_parser.dart';

class SentIQApiClient {
  SentIQApiClient({
    required this.baseUri,
    required this.requestHeaders,
    http.Client? httpClient,
    this.sseParser = const SentIQSseParser(),
  }) : _httpClient = httpClient ?? http.Client();

  final Uri baseUri;
  final SentIQRequestHeaders requestHeaders;
  final SentIQSseParser sseParser;
  final http.Client _httpClient;

  Future<Map<String, Object?>> getJson(String path) {
    return _sendJson('GET', path);
  }

  Future<Map<String, Object?>> postJson(
    String path, {
    required Map<String, Object?> body,
  }) {
    return _sendJson('POST', path, body: body);
  }

  Future<Map<String, Object?>> patchJson(
    String path, {
    required Map<String, Object?> body,
  }) {
    return _sendJson('PATCH', path, body: body);
  }

  Future<Map<String, Object?>> deleteJson(
    String path, {
    Map<String, Object?>? body,
  }) {
    return _sendJson('DELETE', path, body: body);
  }

  Future<Map<String, Object?>> _sendJson(
    String method,
    String path, {
    Map<String, Object?>? body,
  }) async {
    final http.Request request = http.Request(method, _resolve(path))
      ..headers.addAll(await requestHeaders.build());
    if (body != null) request.body = jsonEncode(body);
    final http.StreamedResponse streamed = await _httpClient.send(request);
    final String raw = await streamed.stream.bytesToString();
    return _decodeJson(streamed.statusCode, raw);
  }

  Stream<SentIQSseEvent> postSse(
    String path, {
    required Map<String, Object?> body,
  }) async* {
    final http.Request request = http.Request('POST', _resolve(path))
      ..headers.addAll(
        await requestHeaders.build(
          base: const <String, String>{'Accept': 'text/event-stream'},
        ),
      )
      ..body = jsonEncode(body);
    final http.StreamedResponse response = await _httpClient.send(request);
    if (response.statusCode < 200 || response.statusCode >= 300) {
      final String raw = await response.stream.bytesToString();
      throw _exception(response.statusCode, raw);
    }
    yield* sseParser.parse(response.stream);
  }

  Uri _resolve(String path) {
    final String normalizedPath = path.startsWith('/') ? path : '/$path';
    return baseUri.resolve(normalizedPath);
  }

  Map<String, Object?> _decodeJson(int statusCode, String rawBody) {
    if (statusCode < 200 || statusCode >= 300) {
      throw _exception(statusCode, rawBody);
    }
    if (rawBody.trim().isEmpty) return const <String, Object?>{};
    final Object? decoded = jsonDecode(rawBody);
    if (decoded is! Map) {
      throw const SentIQApiException(
        message: 'SentIQ Chat returned an unexpected response.',
        statusCode: 502,
        code: 'invalid_response_shape',
      );
    }
    return decoded.map(
      (Object? key, Object? value) => MapEntry(key.toString(), value),
    );
  }

  SentIQApiException _exception(int statusCode, String rawBody) {
    Map<String, Object?>? details;
    try {
      final Object? decoded = jsonDecode(rawBody);
      if (decoded is Map) {
        details = decoded.map(
          (Object? key, Object? value) => MapEntry(key.toString(), value),
        );
      }
    } on FormatException {
      details = null;
    }
    return SentIQApiException(
      message:
          details?['error']?.toString() ??
          'SentIQ Chat could not finish that action. Please try again.',
      statusCode: statusCode,
      code: details?['code']?.toString(),
      details: details,
    );
  }

  void close() {
    _httpClient.close();
  }
}
