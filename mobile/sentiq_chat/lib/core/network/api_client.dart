import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:http/http.dart' as http;
import 'package:sentiq_chat/core/network/api_exception.dart';
import 'package:sentiq_chat/core/network/request_headers.dart';
import 'package:sentiq_chat/core/network/sse_event.dart';
import 'package:sentiq_chat/core/network/sse_parser.dart';

class SentIQSseConnection {
  SentIQSseConnection({
    required this.events,
    required Future<void> Function() onCancel,
  }) : _onCancel = onCancel;

  final Stream<SentIQSseEvent> events;
  final Future<void> Function() _onCancel;
  bool _cancelled = false;

  bool get isCancelled => _cancelled;

  Future<void> cancel() async {
    if (_cancelled) return;
    _cancelled = true;
    await _onCancel();
  }
}

class SentIQMultipartFile {
  const SentIQMultipartFile({
    required this.field,
    required this.filename,
    required this.bytes,
    this.contentType,
  });

  final String field;
  final String filename;
  final Uint8List bytes;
  final String? contentType;
}

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

  Future<Map<String, Object?>> postMultipart(
    String path, {
    required Map<String, String> fields,
    required List<SentIQMultipartFile> files,
  }) async {
    final http.MultipartRequest request =
        http.MultipartRequest('POST', _resolve(path))
          ..headers.addAll(await requestHeaders.build(json: false))
          ..fields.addAll(fields);
    for (final SentIQMultipartFile file in files) {
      request.files.add(
        http.MultipartFile.fromBytes(
          file.field,
          file.bytes,
          filename: file.filename,
        ),
      );
    }
    final http.StreamedResponse response = await _httpClient.send(request);
    final String raw = await response.stream.bytesToString();
    return _decodeJson(response.statusCode, raw);
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
    final SentIQSseConnection connection = await postSseCancellable(
      path,
      body: body,
    );
    yield* connection.events;
  }

  Future<SentIQSseConnection> postSseCancellable(
    String path, {
    required Map<String, Object?> body,
  }) async {
    final http.Client streamClient = http.Client();
    try {
      final http.Request request = http.Request('POST', _resolve(path))
        ..headers.addAll(
          await requestHeaders.build(
            base: const <String, String>{'Accept': 'text/event-stream'},
          ),
        )
        ..body = jsonEncode(body);
      final http.StreamedResponse response = await streamClient.send(request);
      if (response.statusCode < 200 || response.statusCode >= 300) {
        final String raw = await response.stream.bytesToString();
        streamClient.close();
        throw _exception(response.statusCode, raw);
      }
      final String contentType = response.headers['content-type'] ?? '';
      if (contentType.contains('application/json')) {
        final String raw = await response.stream.bytesToString();
        streamClient.close();
        final Map<String, Object?> payload = _decodeJson(
          response.statusCode,
          raw,
        );
        return SentIQSseConnection(
          events: Stream<SentIQSseEvent>.value(
            SentIQSseEvent(
              type: 'structured_response',
              version: 1,
              kind: SentIQSseEventKind.structuredResponse,
              payload: <String, Object?>{
                'type': 'structured_response',
                'response': payload,
              },
              rawData: raw,
            ),
          ),
          onCancel: () async {},
        );
      }
      final Stream<SentIQSseEvent> events = sseParser
          .parse(response.stream)
          .transform(
            StreamTransformer<SentIQSseEvent, SentIQSseEvent>.fromHandlers(
              handleDone: (EventSink<SentIQSseEvent> sink) {
                streamClient.close();
                sink.close();
              },
              handleError:
                  (
                    Object error,
                    StackTrace stackTrace,
                    EventSink<SentIQSseEvent> sink,
                  ) {
                    streamClient.close();
                    sink.addError(error, stackTrace);
                    sink.close();
                  },
            ),
          );
      return SentIQSseConnection(
        events: events,
        onCancel: () async => streamClient.close(),
      );
    } catch (_) {
      streamClient.close();
      rethrow;
    }
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
