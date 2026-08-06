import 'package:flutter/material.dart';
import 'package:sentiq_chat/core/design_system/sentiq_tokens.dart';
import 'package:sentiq_chat/shared/widgets/sentiq_brand_mark.dart';

class LaunchScreen extends StatefulWidget {
  const LaunchScreen({super.key});

  @override
  State<LaunchScreen> createState() => _LaunchScreenState();
}

class _LaunchScreenState extends State<LaunchScreen>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1400),
    )..repeat(reverse: true);
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final SentIQPalette palette = context.sentiqPalette;
    return Scaffold(
      body: SafeArea(
        child: Center(
          child: AnimatedBuilder(
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
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: <Widget>[
                const SentIQBrandMark(size: 72),
                const SizedBox(height: SentIQSpacing.md),
                Text(
                  'SentIQ Chat',
                  style: Theme.of(context).textTheme.headlineMedium,
                ),
                const SizedBox(height: SentIQSpacing.xs),
                Text(
                  'Bringing your workspace back…',
                  style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                    color: palette.textSecondary,
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
