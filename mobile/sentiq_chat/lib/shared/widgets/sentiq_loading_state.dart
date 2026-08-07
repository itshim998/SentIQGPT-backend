import 'package:flutter/material.dart';
import 'package:sentiq_chat/core/design_system/sentiq_tokens.dart';
import 'package:sentiq_chat/core/performance/performance_policy.dart';

class SentIQLoadingState extends StatefulWidget {
  const SentIQLoadingState({
    this.label = 'Getting things ready…',
    this.compact = false,
    super.key,
  });

  final String label;
  final bool compact;

  @override
  State<SentIQLoadingState> createState() => _SentIQLoadingStateState();
}

class _SentIQLoadingStateState extends State<SentIQLoadingState>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller;
  bool _reduceMotion = false;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1300),
    );
  }

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final bool reduce = SentIQPerformancePolicy.reduceMotion(context);
    if (reduce == _reduceMotion && (_controller.isAnimating || reduce)) return;
    _reduceMotion = reduce;
    if (reduce) {
      _controller
        ..stop()
        ..value = 0;
    } else {
      _controller.repeat();
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final SentIQPalette palette = context.sentiqPalette;
    final Widget indicator = DecoratedBox(
      decoration: BoxDecoration(
        shape: BoxShape.circle,
        border: Border.all(color: palette.accentSoft, width: 3),
        gradient: SweepGradient(
          colors: <Color>[
            palette.accent,
            palette.info,
            palette.accent.withValues(alpha: 0.08),
          ],
        ),
      ),
      child: SizedBox.square(dimension: widget.compact ? 20 : 28),
    );
    return Semantics(
      label: widget.label,
      liveRegion: true,
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          _reduceMotion
              ? indicator
              : RotationTransition(turns: _controller, child: indicator),
          const SizedBox(width: SentIQSpacing.sm),
          Flexible(
            child: Text(
              widget.label,
              style: Theme.of(
                context,
              ).textTheme.bodyMedium?.copyWith(color: palette.textSecondary),
            ),
          ),
        ],
      ),
    );
  }
}
