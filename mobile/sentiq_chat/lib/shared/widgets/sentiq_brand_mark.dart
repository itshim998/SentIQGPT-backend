import 'package:flutter/material.dart';
import 'package:sentiq_chat/core/design_system/sentiq_tokens.dart';

class SentIQBrandMark extends StatelessWidget {
  const SentIQBrandMark({this.size = 52, super.key});

  final double size;

  @override
  Widget build(BuildContext context) {
    final SentIQPalette palette = context.sentiqPalette;
    return Semantics(
      label: 'SentIQ Chat',
      image: true,
      child: SizedBox.square(
        dimension: size,
        child: CustomPaint(
          painter: _SentIQBrandPainter(
            accent: palette.accent,
            secondary: palette.info,
            surface: palette.surfaceElevated,
          ),
        ),
      ),
    );
  }
}

class _SentIQBrandPainter extends CustomPainter {
  const _SentIQBrandPainter({
    required this.accent,
    required this.secondary,
    required this.surface,
  });

  final Color accent;
  final Color secondary;
  final Color surface;

  @override
  void paint(Canvas canvas, Size size) {
    final Rect bounds = Offset.zero & size;
    final RRect outer = RRect.fromRectAndRadius(
      bounds.deflate(size.width * 0.04),
      Radius.circular(size.width * 0.32),
    );
    canvas.drawRRect(
      outer,
      Paint()
        ..shader = LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: <Color>[accent, secondary],
        ).createShader(bounds),
    );
    final Path path = Path()
      ..moveTo(size.width * 0.30, size.height * 0.38)
      ..cubicTo(
        size.width * 0.42,
        size.height * 0.22,
        size.width * 0.70,
        size.height * 0.30,
        size.width * 0.67,
        size.height * 0.46,
      )
      ..cubicTo(
        size.width * 0.64,
        size.height * 0.61,
        size.width * 0.37,
        size.height * 0.52,
        size.width * 0.34,
        size.height * 0.67,
      )
      ..cubicTo(
        size.width * 0.31,
        size.height * 0.80,
        size.width * 0.57,
        size.height * 0.83,
        size.width * 0.70,
        size.height * 0.68,
      );
    canvas.drawPath(
      path,
      Paint()
        ..color = surface
        ..style = PaintingStyle.stroke
        ..strokeWidth = size.width * 0.10
        ..strokeCap = StrokeCap.round,
    );
  }

  @override
  bool shouldRepaint(covariant _SentIQBrandPainter oldDelegate) =>
      oldDelegate.accent != accent ||
      oldDelegate.secondary != secondary ||
      oldDelegate.surface != surface;
}
