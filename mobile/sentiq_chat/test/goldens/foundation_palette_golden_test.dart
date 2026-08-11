import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sentiq_chat/core/design_system/sentiq_tokens.dart';

void main() {
  testWidgets('foundation palette swatches remain stable', (
    WidgetTester tester,
  ) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(4, 2);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.view.resetPhysicalSize);

    await tester.pumpWidget(const CustomPaint(painter: _PalettePainter()));

    await expectLater(
      find.byType(CustomPaint),
      matchesGoldenFile('foundation_palette.png'),
    );
  });
}

class _PalettePainter extends CustomPainter {
  const _PalettePainter();

  @override
  void paint(Canvas canvas, Size size) {
    final List<Color> colors = <Color>[
      SentIQPalette.dark.canvas,
      SentIQPalette.dark.accent,
      SentIQPalette.light.canvas,
      SentIQPalette.light.accent,
    ];
    for (int index = 0; index < colors.length; index += 1) {
      canvas.drawRect(
        Rect.fromLTWH(index.toDouble(), 0, 1, 2),
        Paint()
          ..isAntiAlias = false
          ..color = colors[index],
      );
    }
  }

  @override
  bool shouldRepaint(covariant _PalettePainter oldDelegate) => false;
}
