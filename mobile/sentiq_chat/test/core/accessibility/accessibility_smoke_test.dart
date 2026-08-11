import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sentiq_chat/core/design_system/sentiq_theme.dart';
import 'package:sentiq_chat/core/design_system/sentiq_tokens.dart';
import 'package:sentiq_chat/shared/widgets/sentiq_button.dart';
import 'package:sentiq_chat/shared/widgets/sentiq_loading_state.dart';

void main() {
  test('primary and supporting text meet WCAG AA contrast', () {
    for (final SentIQPalette palette in <SentIQPalette>[
      SentIQPalette.light,
      SentIQPalette.dark,
    ]) {
      expect(
        _contrast(palette.textPrimary, palette.canvas),
        greaterThanOrEqualTo(4.5),
      );
      expect(
        _contrast(palette.textSecondary, palette.canvas),
        greaterThanOrEqualTo(4.5),
      );
      expect(
        _contrast(palette.textMuted, palette.canvas),
        greaterThanOrEqualTo(4.5),
      );
    }
  });

  testWidgets('interactive targets remain at least 48dp', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: SentIQTheme.light(),
        home: Scaffold(
          body: SentIQIconButton(
            icon: Icons.send_rounded,
            tooltip: 'Send',
            onPressed: () {},
          ),
        ),
      ),
    );
    final Size size = tester.getSize(find.byType(IconButton));
    expect(size.width, greaterThanOrEqualTo(48));
    expect(size.height, greaterThanOrEqualTo(48));
  });

  testWidgets('large text and reduced motion remain usable', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: SentIQTheme.dark(),
        home: MediaQuery(
          data: const MediaQueryData(
            textScaler: TextScaler.linear(2),
            disableAnimations: true,
          ),
          child: Scaffold(
            body: ListView(
              children: <Widget>[
                SentIQButton(label: 'Continue', onPressed: () {}),
                const SentIQLoadingState(label: 'Preparing conversation'),
              ],
            ),
          ),
        ),
      ),
    );
    await tester.pump();
    expect(find.text('Continue'), findsOneWidget);
    expect(find.text('Preparing conversation'), findsOneWidget);
    expect(
      find.descendant(
        of: find.byType(SentIQLoadingState),
        matching: find.byType(RotationTransition),
      ),
      findsNothing,
    );
    expect(tester.takeException(), isNull);
  });
}

// WCAG relative-luminance contrast ratio.
double _contrast(Color foreground, Color background) {
  final double lighter =
      foreground.computeLuminance() > background.computeLuminance()
      ? foreground.computeLuminance()
      : background.computeLuminance();
  final double darker =
      foreground.computeLuminance() > background.computeLuminance()
      ? background.computeLuminance()
      : foreground.computeLuminance();
  return (lighter + 0.05) / (darker + 0.05);
}
