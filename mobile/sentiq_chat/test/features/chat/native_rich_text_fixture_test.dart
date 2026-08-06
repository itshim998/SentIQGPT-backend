import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sentiq_chat/core/design_system/sentiq_theme.dart';
import 'package:sentiq_chat/features/chat/presentation/native_rich_text.dart';

void main() {
  testWidgets('renders markdown, code, table, link and math fixtures', (
    WidgetTester tester,
  ) async {
    final String fixture = await File(
      'test/fixtures/rich_text/complete.md',
    ).readAsString();
    await tester.pumpWidget(
      MaterialApp(
        theme: SentIQTheme.light(),
        home: Scaffold(
          body: SingleChildScrollView(
            child: Padding(
              padding: const EdgeInsets.all(16),
              child: NativeRichText(data: fixture),
            ),
          ),
        ),
      ),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));

    expect(find.text('Heading'), findsOneWidget);
    expect(find.text('First item'), findsOneWidget);
    expect(find.text('A blockquote.'), findsOneWidget);
    expect(find.text('Code'), findsOneWidget);
    expect(find.byIcon(Icons.copy_rounded), findsOneWidget);
    expect(tester.takeException(), isNull);
  });
}
