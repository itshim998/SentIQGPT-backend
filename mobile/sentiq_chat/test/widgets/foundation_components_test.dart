import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sentiq_chat/core/design_system/sentiq_theme.dart';
import 'package:sentiq_chat/shared/widgets/refractive_glass_surface.dart';
import 'package:sentiq_chat/shared/widgets/sentiq_button.dart';
import 'package:sentiq_chat/shared/widgets/sentiq_empty_state.dart';
import 'package:sentiq_chat/shared/widgets/sentiq_feedback.dart';
import 'package:sentiq_chat/shared/widgets/sentiq_text_field.dart';

void main() {
  Widget host(Widget child) {
    return MaterialApp(
      theme: SentIQTheme.light(),
      darkTheme: SentIQTheme.dark(),
      home: Scaffold(body: Center(child: child)),
    );
  }

  testWidgets('button exposes a calm 48dp touch target', (
    WidgetTester tester,
  ) async {
    bool pressed = false;
    await tester.pumpWidget(
      host(SentIQButton(label: 'Continue', onPressed: () => pressed = true)),
    );

    expect(tester.getSize(find.byType(FilledButton)).height, 48);
    await tester.tap(find.text('Continue'));
    expect(pressed, isTrue);
  });

  testWidgets('foundation states render user-friendly language', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(
      host(
        const Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            SentIQTextField(label: 'Message SentIQ Chat'),
            SentIQInlineError(message: 'Please try that again.'),
            SentIQEmptyState(
              icon: Icons.chat_bubble_outline,
              title: 'No conversations yet',
              message: 'Start a new chat when you are ready.',
            ),
          ],
        ),
      ),
    );

    expect(find.text('Message SentIQ Chat'), findsOneWidget);
    expect(find.text('Please try that again.'), findsOneWidget);
    expect(find.text('No conversations yet'), findsOneWidget);
  });

  testWidgets('refractive surface keeps content accessible', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(
      host(const RefractiveGlassSurface(child: Text('Private workspace'))),
    );

    expect(find.text('Private workspace'), findsOneWidget);
    expect(find.byType(BackdropFilter), findsOneWidget);
  });
}
