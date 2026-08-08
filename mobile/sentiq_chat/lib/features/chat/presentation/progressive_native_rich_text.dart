import 'dart:async';

import 'package:flutter/material.dart';
import 'package:sentiq_chat/core/performance/performance_policy.dart';
import 'package:sentiq_chat/features/chat/domain/chat_models.dart';
import 'package:sentiq_chat/features/chat/presentation/native_rich_text.dart';

/// Keeps SSE output visibly progressive even when network/provider chunks
/// arrive faster than Flutter can paint frames.
///
/// This widget never fabricates content or delays the network request. It only
/// reveals text that has already arrived, advancing on complete-word
/// boundaries. [NativeRichText] reparses Markdown on every visible update, so
/// formatting appears with the streamed words instead of being applied only at
/// the end of the response.
class ProgressiveNativeRichText extends StatefulWidget {
  const ProgressiveNativeRichText({
    required this.data,
    this.citations = const <ChatCitation>[],
    this.onSelectionChanged,
    this.streaming = false,
    super.key,
  });

  final String data;
  final List<ChatCitation> citations;
  final ValueChanged<String>? onSelectionChanged;
  final bool streaming;

  @override
  State<ProgressiveNativeRichText> createState() =>
      _ProgressiveNativeRichTextState();
}

class _ProgressiveNativeRichTextState
    extends State<ProgressiveNativeRichText> {
  static const Duration _revealInterval = Duration(milliseconds: 24);

  Timer? _timer;
  late String _visibleData;
  bool _reduceMotion = false;

  @override
  void initState() {
    super.initState();
    _visibleData = widget.streaming ? '' : widget.data;
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final bool reduce = SentIQPerformancePolicy.reduceMotion(context);
    if (reduce != _reduceMotion) {
      _reduceMotion = reduce;
      if (reduce) {
        _timer?.cancel();
        _timer = null;
        _visibleData = widget.data;
      }
    }
    if (!_reduceMotion) _scheduleRevealIfNeeded();
  }

  @override
  void didUpdateWidget(covariant ProgressiveNativeRichText oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (_reduceMotion) {
      _timer?.cancel();
      _timer = null;
      _visibleData = widget.data;
      return;
    }

    // Normal SSE growth is append-only. If a reconciliation replaces the
    // message with non-prefix content, do not animate stale text into the new
    // authoritative value.
    if (!widget.data.startsWith(_visibleData)) {
      _timer?.cancel();
      _timer = null;
      _visibleData = widget.streaming ? '' : widget.data;
    }
    _scheduleRevealIfNeeded();
  }

  bool get _hasBacklog => _visibleData.length < widget.data.length;

  void _scheduleRevealIfNeeded() {
    if (_reduceMotion || !_hasBacklog || _timer != null) return;
    _timer = Timer.periodic(_revealInterval, (_) => _revealNext());
  }

  bool _nearBottom() {
    final ScrollableState? scrollable = Scrollable.maybeOf(context);
    if (scrollable == null) return false;
    final ScrollPosition position = scrollable.position;
    if (!position.hasContentDimensions) return true;
    return position.maxScrollExtent - position.pixels < 180;
  }

  void _keepPinnedIfNeeded(bool wasNearBottom) {
    if (!wasNearBottom) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final ScrollableState? scrollable = Scrollable.maybeOf(context);
      if (scrollable == null) return;
      final ScrollPosition position = scrollable.position;
      if (!position.hasContentDimensions) return;
      position.jumpTo(position.maxScrollExtent);
    });
  }

  void _revealNext() {
    if (!mounted) {
      _cancelTimer();
      return;
    }
    final String target = widget.data;
    if (!target.startsWith(_visibleData)) {
      final bool wasNearBottom = _nearBottom();
      setState(() => _visibleData = widget.streaming ? '' : target);
      _keepPinnedIfNeeded(wasNearBottom);
      _cancelTimer();
      _scheduleRevealIfNeeded();
      return;
    }
    if (_visibleData.length >= target.length) {
      _cancelTimer();
      return;
    }

    final int end = _nextRevealEnd(
      target,
      _visibleData.length,
      sourceStillStreaming: widget.streaming,
    );
    if (end <= _visibleData.length) {
      // We are currently holding an unfinished word. Stop ticking until a
      // later SSE update provides a word boundary rather than burning frames.
      _cancelTimer();
      return;
    }

    final bool wasNearBottom = _nearBottom();
    setState(() => _visibleData = target.substring(0, end));
    _keepPinnedIfNeeded(wasNearBottom);
    if (_visibleData.length >= target.length) _cancelTimer();
  }

  int _nextRevealEnd(
    String target,
    int start, {
    required bool sourceStillStreaming,
  }) {
    final int backlog = target.length - start;
    final int wordBudget = backlog > 1200
        ? 6
        : backlog > 700
        ? 4
        : backlog > 300
        ? 2
        : 1;

    int words = 0;
    bool insideWord = false;
    for (int index = start; index < target.length; index += 1) {
      final int unit = target.codeUnitAt(index);
      final bool whitespace =
          unit == 0x20 || unit == 0x0A || unit == 0x09 || unit == 0x0D;
      if (whitespace) {
        if (insideWord) {
          words += 1;
          insideWord = false;
          if (words >= wordBudget) return index + 1;
        }
      } else {
        insideWord = true;
      }
    }

    // Once the provider is done, reveal the final unterminated word as part of
    // the remaining cadence. During an active stream we wait for its boundary
    // unless it is an intentionally long unbroken token such as a URL/hash.
    if (!sourceStillStreaming) return target.length;
    if (backlog >= 48) {
      return (start + 48).clamp(start, target.length).toInt();
    }
    return start;
  }

  void _cancelTimer() {
    _timer?.cancel();
    _timer = null;
  }

  @override
  Widget build(BuildContext context) {
    final bool visiblyStreaming = widget.streaming || _hasBacklog;
    return NativeRichText(
      data: _visibleData.isEmpty && visiblyStreaming ? ' ' : _visibleData,
      citations: visiblyStreaming ? const <ChatCitation>[] : widget.citations,
      streaming: visiblyStreaming,
      onSelectionChanged: widget.onSelectionChanged,
    );
  }

  @override
  void dispose() {
    _cancelTimer();
    super.dispose();
  }
}
