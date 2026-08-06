import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:http/http.dart' as http;
import 'package:http_parser/http_parser.dart';
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

class SentIQMultipartUpload {
  SentIQMultipartUpload({
    required this.response,
    required this.progress,
    required Future<void> Function() onCancel,
  }) : _onCancel = onCancel;

  final Future<Map<String, Object?>> response;
  final Stream<double> progress;
  final Future<void> Function() _onCancel;
  bool _cancelled = false;

  bool get isCancelled => _cancelled;

  Future<void> cancel() async {
    if (_cancelled) return;
    _cancelled = true;
    await _onCancel();
  }
}

class SentIQBinaryResponse {
  const SentIQBinaryResponse({
    required this.bytes,
    required this.contentType,
    required this.filename,
  });

  final Uint8List bytes;
  final String contentType;
  final String? filename;
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
    final SentIQMultipartUpload upload = await startMultipartUpload(
      path,
      fields: fields,
      files: files,
    );
    return upload.response;
  }

  Future<SentIQMultipartUpload> startMultipartUpload(
    String path, {
    required Map<String, String> fields,
    required List<SentIQMultipartFile> files,
  }) async {
    final http.Client uploadClient = http.Client();
    final StreamController<double> progress =
        StreamController<double>.broadcast();
    final http.MultipartRequest multipart =
        http.MultipartRequest('POST', _resolve(path))
          ..headers.addAll(await requestHeaders.build(json: false))
          ..fields.addAll(fields);
    for (final SentIQMultipartFile file in files) {
      multipart.files.add(
        http.MultipartFile.fromBytes(
          file.field,
          file.bytes,
          filename: file.filename,
          contentType: file.contentType == null
              ? null
              : MediaType.parse(file.contentType!),
        ),
      );
    }
    final int contentLength = multipart.contentLength;
    final http.ByteStream finalized = multipart.finalize();
    int sent = 0;
    final Stream<List<int>> measured = finalized.map((List<int> chunk) {
      sent += chunk.length;
      if (!progress.isClosed) {
        progress.add(
          contentLength == 0
              ? 0.0
              : (sent / contentLength).clamp(0, 1).toDouble(),
        );
      }
      return chunk;
    });
    final _FinalizedStreamRequest request = _FinalizedStreamRequest(
      'POST',
      _resolve(path),
      http.ByteStream(measured),
      contentLength,
    )..headers.addAll(multipart.headers);
    final Future<Map<String, Object?>> response = () async {
      try {
        final http.StreamedResponse streamed = await uploadClient.send(request);
        final String raw = await streamed.stream.bytesToString();
        if (!progress.isClosed) progress.add(1);
        return _decodeJson(streamed.statusCode, raw);
      } finally {
        uploadClient.close();
        if (!progress.isClosed) await progress.close();
      }
    }();
    return SentIQMultipartUpload(
      response: response,
      progress: progress.stream,
      onCancel: () async {
        uploadClient.close();
        if (!progress.isClosed) await progress.close();
      },
    );
  }

  Future<SentIQBinaryResponse> getBytes(
    Uri uri, {
    int maximumBytes = 64 * 1024 * 1024,
  }) async {
    if (uri.scheme != 'https' || uri.host.isEmpty || uri.userInfo.isNotEmpty) {
      throw const SentIQApiException(
        message: 'Only secure HTTPS downloads are allowed.',
        statusCode: 400,
        code: 'unsafe_remote_url',
      );
    }
    final http.StreamedResponse response = await _httpClient.send(
      http.Request('GET', uri),
    );
    if (response.statusCode < 200 || response.statusCode >= 300) {
      final String raw = await response.stream.bytesToString();
      throw _exception(response.statusCode, raw);
    }
    final BytesBuilder builder = BytesBuilder(copy: false);
    int received = 0;
    await for (final List<int> chunk in response.stream) {
      received += chunk.length;
      if (received > maximumBytes) {
        throw const SentIQApiException(
          message: 'This download is too large to open safely.',
          statusCode: 413,
          code: 'remote_content_too_large',
        );
      }
      builder.add(chunk);
    }
    return SentIQBinaryResponse(
      bytes: builder.takeBytes(),
      contentType:
          response.headers['content-type'] ?? 'application/octet-stream',
      filename: _filenameFromDisposition(
        response.headers['content-disposition'],
      ),
    );
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

  Future<SentIQSseConnection> getSseCancellable(String path) {
    return _openSse('GET', path);
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
  }) {
    return _openSse('POST', path, body: body);
  }

  Future<SentIQSseConnection> _openSse(
    String method,
    String path, {
    Map<String, Object?>? body,
  }) async {
    final http.Client streamClient = http.Client();
    try {
      final http.Request request = http.Request(method, _resolve(path))
        ..headers.addAll(
          await requestHeaders.build(
            base: const <String, String>{'Accept': 'text/event-stream'},
          ),
        );
      if (body != null) request.body = jsonEncode(body);
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

  String? _filenameFromDisposition(String? value) {
    if (value == null) return null;
    final RegExpMatch? match = RegExp(
      r'filename=\"?([^\";]+)\"?',
      caseSensitive: false,
    ).firstMatch(value);
    return match == null ? null : Uri.decodeComponent(match.group(1)!.trim());
  }

  void close() {
    _httpClient.close();
  }
}

class _FinalizedStreamRequest extends http.BaseRequest {
  _FinalizedStreamRequest(
    super.method,
    super.url,
    this._stream,
    int contentLength,
  ) {
    this.contentLength = contentLength;
  }

  final http.ByteStream _stream;

  @override
  http.ByteStream finalize() {
    super.finalize();
    return _stream;
  }
}
