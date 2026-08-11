import 'dart:async';

/// Batches provider fragments without painting half-finished words.
///
/// The renderer still receives updates on a short frame-friendly cadence, but
/// normal prose is emitted through the most recent whitespace boundary. This
/// keeps streamed Markdown stable while preserving the 32 ms frame budget.
class TokenBatcher {
  TokenBatcher({
    required this.onFlush,
    this.interval = const Duration(milliseconds: 32),
  });

  final void Function(String text) onFlush;
  final Duration interval;
  String _pending = '';
  Timer? _timer;
  bool _closed = false;

  void add(String text) {
    if (_closed || text.isEmpty) return;
    _pending += text;
    _timer ??= Timer(interval, _flushWordBoundary);
  }

  void _flushWordBoundary() {
    _timer?.cancel();
    _timer = null;
    if (_pending.isEmpty) return;

    int boundary = -1;
    for (int index = _pending.length - 1; index >= 0; index -= 1) {
      final int codeUnit = _pending.codeUnitAt(index);
      if (codeUnit == 0x20 ||
          codeUnit == 0x0A ||
          codeUnit == 0x09 ||
          codeUnit == 0x0D) {
        boundary = index + 1;
        break;
      }
    }

    // Extremely long unbroken content (URLs, code, hashes) must still stream.
    if (boundary <= 0 && _pending.length < 48) return;
    final int emitEnd = boundary > 0 ? boundary : _pending.length;
    final String text = _pending.substring(0, emitEnd);
    _pending = _pending.substring(emitEnd);
    if (text.isNotEmpty) onFlush(text);
  }

  void flush() {
    _timer?.cancel();
    _timer = null;
    if (_pending.isEmpty) return;
    final String text = _pending;
    _pending = '';
    onFlush(text);
  }

  void close() {
    if (_closed) return;
    flush();
    _closed = true;
  }
}
