import 'dart:ui';

import 'package:flutter/material.dart';
import 'package:sentiq_chat/core/design_system/sentiq_tokens.dart';
import 'package:sentiq_chat/core/performance/performance_policy.dart';

class RefractiveGlassSurface extends StatelessWidget {
  const RefractiveGlassSurface({
    required this.child,
    this.padding = const EdgeInsets.all(SentIQSpacing.md),
    this.borderRadius = SentIQRadii.large,
    this.blurSigma = 18,
    this.onTap,
    super.key,
  });

  final Widget child;
  final EdgeInsetsGeometry padding;
  final double borderRadius;
  final double blurSigma;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final SentIQPalette palette = context.sentiqPalette;
    final BorderRadius radius = BorderRadius.circular(borderRadius);
    final ImageFilter? filter = SentIQPerformancePolicy.glassFilter(
      context,
      blurSigma,
    );
    final Widget decorated = DecoratedBox(
      decoration: BoxDecoration(
        borderRadius: radius,
        border: Border.all(color: palette.glassBorder),
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: <Color>[
            Color.alphaBlend(
              Colors.white.withValues(alpha: 0.10),
              palette.glass,
            ),
            palette.glass,
            Color.alphaBlend(palette.accentSoft, palette.glass),
          ],
          stops: const <double>[0, 0.52, 1],
        ),
        boxShadow: SentIQPerformancePolicy.useLowCostEffects(context)
            ? const <BoxShadow>[]
            : <BoxShadow>[
                BoxShadow(
                  color: Colors.black.withValues(alpha: 0.12),
                  blurRadius: 28,
                  offset: const Offset(0, 12),
                ),
                BoxShadow(
                  color: Colors.white.withValues(alpha: 0.05),
                  blurRadius: 1,
                  offset: const Offset(0, 1),
                ),
              ],
      ),
      child: Padding(padding: padding, child: child),
    );
    final Widget surface = ClipRRect(
      borderRadius: radius,
      child: filter == null
          ? decorated
          : BackdropFilter(filter: filter, child: decorated),
    );
    if (onTap == null) return surface;
    return Semantics(
      button: true,
      child: InkWell(onTap: onTap, borderRadius: radius, child: surface),
    );
  }
}
