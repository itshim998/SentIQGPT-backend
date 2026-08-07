import 'dart:typed_data';
import 'dart:ui' as ui;

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
      signature: _ExpandedSignature(
        canvas: Color(0xFFF5F4F1),
        surface: Color(0xFFFCFBF8),
        textMuted: Color(0xFF706B76),
        accent: Color(0xFF67558F),
      ),
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
      signature: _ExpandedSignature(
        canvas: Color(0xFF080A10),
        surface: Color(0xFF11131C),
        textMuted: Color(0xFF80798F),
        accent: Color(0xFF9874E8),
      ),
    ),
  ]) {
    testWidgets('workspace layout signature remains stable: ${golden.name}', (
      WidgetTester tester,
    ) async {
      if (golden.expanded) {
        await _expectExpandedSignature(golden);
        return;
      }

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
        matchesGoldenFile(golden.file!),
      );
    });
  }
}

Future<void> _expectExpandedSignature(_GoldenCase golden) async {
  final _ExpandedSignature expected = golden.signature!;
  final ui.PictureRecorder recorder = ui.PictureRecorder();
  final Canvas canvas = Canvas(recorder);
  final _WorkspaceSignaturePainter painter = _WorkspaceSignaturePainter(
    palette: golden.palette,
    expanded: true,
  );
  painter.paint(canvas, golden.size);
  final ui.Picture picture = recorder.endRecording();
  final ui.Image image = await picture.toImage(
    golden.size.width.toInt(),
    golden.size.height.toInt(),
  );
  final ByteData data = (await image.toByteData(
    format: ui.ImageByteFormat.rawRgba,
  ))!;

  expect(_pixelAt(data, golden.size.width.toInt(), 0, 0), expected.accent);
  expect(_pixelAt(data, golden.size.width.toInt(), 2, 2), expected.surface);
  expect(_pixelAt(data, golden.size.width.toInt(), 3, 2), expected.textMuted);
  expect(_pixelAt(data, golden.size.width.toInt(), 4, 2), expected.canvas);

  image.dispose();
  picture.dispose();
}

Color _pixelAt(ByteData data, int width, int x, int y) {
  final int offset = ((y * width) + x) * 4;
  return Color.fromARGB(
    data.getUint8(offset + 3),
    data.getUint8(offset),
    data.getUint8(offset + 1),
    data.getUint8(offset + 2),
  );
}

class _GoldenCase {
  const _GoldenCase({
    required this.name,
    required this.palette,
    required this.expanded,
    required this.size,
    this.file,
    this.signature,
  });

  final String name;
  final SentIQPalette palette;
  final bool expanded;
  final Size size;
  final String? file;
  final _ExpandedSignature? signature;
}

class _ExpandedSignature {
  const _ExpandedSignature({
    required this.canvas,
    required this.surface,
    required this.textMuted,
    required this.accent,
  });

  final Color canvas;
  final Color surface;
  final Color textMuted;
  final Color accent;
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
