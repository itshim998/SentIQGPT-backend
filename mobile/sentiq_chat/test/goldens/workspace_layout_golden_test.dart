import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sentiq_chat/core/design_system/sentiq_tokens.dart';

void main() {
  for (final _GoldenCase golden in <_GoldenCase>[
    const _GoldenCase(
      name: 'light compact',
      palette: SentIQPalette.light,
      expanded: false,
      size: Size(6, 4),
      file: 'workspace_light_compact.png',
    ),
    const _GoldenCase(
      name: 'light expanded',
      palette: SentIQPalette.light,
      expanded: true,
      size: Size(8, 4),
      file: 'workspace_light_expanded.png',
    ),
    const _GoldenCase(
      name: 'dark compact',
      palette: SentIQPalette.dark,
      expanded: false,
      size: Size(6, 4),
      file: 'workspace_dark_compact.png',
    ),
    const _GoldenCase(
      name: 'dark expanded',
      palette: SentIQPalette.dark,
      expanded: true,
      size: Size(8, 4),
      file: 'workspace_dark_expanded.png',
    ),
  ]) {
    testWidgets('workspace layout signature remains stable: ${golden.name}', (
      WidgetTester tester,
    ) async {
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = golden.size;
      addTearDown(tester.view.resetDevicePixelRatio);
      addTearDown(tester.view.resetPhysicalSize);

      await tester.pumpWidget(
        CustomPaint(
          painter: _WorkspaceSignaturePainter(
            palette: golden.palette,
            expanded: golden.expanded,
          ),
        ),
      );

      await expectLater(
        find.byType(CustomPaint),
        matchesGoldenFile(golden.file),
      );
    });
  }
}

class _GoldenCase {
  const _GoldenCase({
    required this.name,
    required this.palette,
    required this.expanded,
    required this.size,
    required this.file,
  });

  final String name;
  final SentIQPalette palette;
  final bool expanded;
  final Size size;
  final String file;
}

class _WorkspaceSignaturePainter extends CustomPainter {
  const _WorkspaceSignaturePainter({
    required this.palette,
    required this.expanded,
  });

  final SentIQPalette palette;
  final bool expanded;

  @override
  void paint(Canvas canvas, Size size) {
    final Paint paint = Paint()..isAntiAlias = false;
    canvas.drawRect(Offset.zero & size, paint..color = palette.canvas);
    if (expanded) {
      canvas.drawRect(
        const Rect.fromLTWH(0, 0, 3, 4),
        paint..color = palette.surface,
      );
      canvas.drawRect(
        const Rect.fromLTWH(3, 0, 1, 4),
        paint..color = palette.textMuted,
      );
      canvas.drawRect(
        const Rect.fromLTWH(0, 0, 2, 1),
        paint..color = palette.accent,
      );
    } else {
      canvas.drawRect(
        const Rect.fromLTWH(0, 0, 6, 1),
        paint..color = palette.surface,
      );
      canvas.drawRect(
        const Rect.fromLTWH(4, 0, 2, 1),
        paint..color = palette.accent,
      );
    }
  }

  @override
  bool shouldRepaint(covariant _WorkspaceSignaturePainter oldDelegate) =>
      oldDelegate.palette != palette || oldDelegate.expanded != expanded;
}
