import 'dart:async';
import 'dart:convert';

import 'package:sentiq_chat/core/network/sse_event.dart';

class SentIQSseParser {
  const SentIQSseParser({this.maximumSupportedVersion = 1});

  final int maximumSupportedVersion;

  Stream<SentIQSseEvent> parse(Stream<List<int>> source) async* {
    String? eventName;
    String? id;
    final List<String> data = <String>[];

    SentIQSseEvent? flush() {
      if (data.isEmpty && eventName == null) return null;
      final String rawData = data.join('\n').trim();
      final SentIQSseEvent event = _decode(
        rawData: rawData,
        eventName: eventName,
        id: id,
      );
      eventName = null;
      id = null;
      data.clear();
      return event;
    }

    final Stream<String> lines = source
        .transform(utf8.decoder)
        .transform(const LineSplitter());
    await for (final String line in lines) {
      if (line.isEmpty) {
        final SentIQSseEvent? event = flush();
        if (event != null) yield event;
        continue;
      }
      if (line.startsWith(':')) continue;
      final int separator = line.indexOf(':');
      final String field = separator < 0 ? line : line.substring(0, separator);
      String value = separator < 0 ? '' : line.substring(separator + 1);
      if (value.startsWith(' ')) value = value.substring(1);
      switch (field) {
        case 'event':
          eventName = value;
          break;
        case 'id':
          id = value;
          break;
        case 'data':
          data.add(value);
          break;
        default:
          break;
      }
    }
    final SentIQSseEvent? trailing = flush();
    if (trailing != null) yield trailing;
  }

  Stream<SentIQSseEvent> parseText(String text) {
    return parse(Stream<List<int>>.value(utf8.encode(text)));
  }

  SentIQSseEvent _decode({
    required String rawData,
    required String? eventName,
    required String? id,
  }) {
    if (rawData == '[DONE]') {
      return SentIQSseEvent(
        type: 'done',
        version: 1,
        kind: SentIQSseEventKind.done,
        payload: const <String, Object?>{},
        rawData: rawData,
        id: id,
      );
    }

    Map<String, Object?> payload = <String, Object?>{};
    try {
      final Object? decoded = jsonDecode(rawData);
      if (decoded is Map) {
        payload = decoded.map(
          (Object? key, Object? value) => MapEntry(key.toString(), value),
        );
      } else {
        payload = <String, Object?>{'value': decoded};
      }
    } on FormatException {
      payload = <String, Object?>{'text': rawData};
    }

    final String type = (payload['type'] ?? eventName ?? 'message').toString();
    final Object? rawVersion = payload['version'] ?? payload['v'];
    final int version = rawVersion is num ? rawVersion.toInt() : 1;
    return SentIQSseEvent(
      type: type,
      version: version,
      kind: SentIQSseEvent.classify(type),
      payload: payload,
      rawData: rawData,
      id: id,
      unsupportedVersion: version > maximumSupportedVersion,
    );
  }
}
