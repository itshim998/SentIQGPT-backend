import 'dart:async';

class TokenBatcher {
  TokenBatcher({
    required this.onFlush,
    this.interval = const Duration(milliseconds: 32),
  });

  final void Function(String text) onFlush;
  final Duration interval;
  final StringBuffer _buffer = StringBuffer();
  Timer? _timer;
  bool _closed = false;

  void add(String text) {
    if (_closed || text.isEmpty) return;
    _buffer.write(text);
    _timer ??= Timer(interval, flush);
  }

  void flush() {
    _timer?.cancel();
    _timer = null;
    if (_buffer.isEmpty) return;
    final String text = _buffer.toString();
    _buffer.clear();
    onFlush(text);
  }

  void close() {
    if (_closed) return;
    flush();
    _closed = true;
  }
}
