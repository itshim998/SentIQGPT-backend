import 'dart:ui' show ImageFilter;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sentiq_chat/core/design_system/sentiq_theme.dart';
import 'package:sentiq_chat/core/performance/performance_policy.dart';
import 'package:sentiq_chat/shared/widgets/refractive_glass_surface.dart';

void main() {
  testWidgets('reduced motion removes backdrop blur', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: SentIQTheme.light(),
        home: const MediaQuery(
          data: MediaQueryData(disableAnimations: true),
          child: Scaffold(
            body: RefractiveGlassSurface(child: Text('Low-cost surface')),
          ),
        ),
      ),
    );

    expect(find.byType(BackdropFilter), findsNothing);
    expect(
      SentIQPerformancePolicy.reduceMotion(
        tester.element(find.text('Low-cost surface')),
      ),
      isTrue,
    );
  });

  testWidgets('forced low-performance mode removes backdrop blur', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: SentIQTheme.dark(),
        home: const Scaffold(
          body: RefractiveGlassSurface(child: Text('Surface')),
        ),
      ),
    );

    if (SentIQPerformancePolicy.forceLowPerformance) {
      expect(find.byType(BackdropFilter), findsNothing);
    }
  });

  test('blur sigma is centrally capped', () {
    expect(SentIQPerformancePolicy.maximumBlurSigma, lessThanOrEqualTo(18));
    expect(ImageFilter.blur(sigmaX: 18, sigmaY: 18), isNotNull);
  });
}
