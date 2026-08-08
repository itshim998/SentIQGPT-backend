import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sentiq_chat/core/design_system/sentiq_theme.dart';
import 'package:sentiq_chat/shared/widgets/sentiq_sheet.dart';
import 'package:sentiq_chat/shared/widgets/sentiq_text_field.dart';

void main() {
  testWidgets('glass sheet supplies Material for ListTile content', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: SentIQTheme.light(),
        home: Scaffold(
          body: Builder(
            builder: (BuildContext context) => TextButton(
              onPressed: () => showSentIQSheet<void>(
                context: context,
                builder: (_) => const ListTile(
                  title: Text('Response style'),
                  subtitle: Text('Fast'),
                ),
              ),
              child: const Text('Open'),
            ),
          ),
        ),
      ),
    );

    await tester.tap(find.text('Open'));
    await tester.pumpAndSettle();

    expect(find.text('Response style'), findsOneWidget);
    expect(find.text('Fast'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('password field toggles visibility without custom screen logic', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: SentIQTheme.light(),
        home: const Scaffold(
          body: Padding(
            padding: EdgeInsets.all(16),
            child: SentIQTextField(label: 'Password', obscureText: true),
          ),
        ),
      ),
    );

    expect(tester.widget<TextField>(find.byType(TextField)).obscureText, isTrue);
    expect(find.byTooltip('Show password'), findsOneWidget);

    await tester.tap(find.byTooltip('Show password'));
    await tester.pump();

    expect(tester.widget<TextField>(find.byType(TextField)).obscureText, isFalse);
    expect(find.byTooltip('Hide password'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
