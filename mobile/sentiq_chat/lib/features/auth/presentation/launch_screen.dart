import 'package:flutter/material.dart';
import 'package:sentiq_chat/core/design_system/sentiq_tokens.dart';
import 'package:sentiq_chat/core/performance/performance_policy.dart';
import 'package:sentiq_chat/shared/widgets/sentiq_brand_mark.dart';

class LaunchScreen extends StatefulWidget {
  const LaunchScreen({super.key});

  @override
  State<LaunchScreen> createState() => _LaunchScreenState();
}

class _LaunchScreenState extends State<LaunchScreen>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller;
  bool _reduceMotion = false;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1400),
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
        ..value = 1;
    } else {
      _controller.repeat(reverse: true);
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
    final Widget content = Column(
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        Semantics(label: 'SentIQ Chat', child: const SentIQBrandMark(size: 72)),
        const SizedBox(height: SentIQSpacing.md),
        Text('SentIQ Chat', style: Theme.of(context).textTheme.headlineMedium),
        const SizedBox(height: SentIQSpacing.xs),
        Text(
          'Bringing your workspace back…',
          style: Theme.of(
            context,
          ).textTheme.bodyMedium?.copyWith(color: palette.textSecondary),
        ),
      ],
    );
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: _reduceMotion
              ? content
              : AnimatedBuilder(
                  animation: _controller,
                  builder: (BuildContext context, Widget? child) {
                    final double scale = 0.97 + (_controller.value * 0.03);
                    return Transform.scale(
                      scale: scale,
                      child: Opacity(
                        opacity: 0.82 + (_controller.value * 0.18),
                        child: child,
                      ),
                    );
                  },
                  child: content,
                ),
        ),
      ),
    );
  }
}
