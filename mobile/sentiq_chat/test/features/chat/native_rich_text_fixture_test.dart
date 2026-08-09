import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sentiq_chat/core/design_system/sentiq_theme.dart';
import 'package:sentiq_chat/features/chat/presentation/native_rich_text.dart';

void main() {
  testWidgets('renders markdown, code, table, link and math fixtures', (
    WidgetTester tester,
  ) async {
    final String fixture = File(
      'test/fixtures/rich_text/complete.md',
    ).readAsStringSync();
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
    expect(find.text('dart'), findsOneWidget);
    expect(find.byIcon(Icons.copy_rounded), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('streams formatted markdown with an inline breathing caret', (
    WidgetTester tester,
  ) async {
    final SemanticsHandle semantics = tester.ensureSemantics();
    addTearDown(semantics.dispose);

    await tester.pumpWidget(
      MaterialApp(
        theme: SentIQTheme.light(),
        home: const Scaffold(
          body: Padding(
            padding: EdgeInsets.all(16),
            child: NativeRichText(
              data: '**Formatted** response ',
              streaming: true,
            ),
          ),
        ),
      ),
    );
    await tester.pump();

    // flutter_markdown_plus may render emphasis inside a RichText/TextSpan tree
    // rather than as an independent Text('Formatted') widget. Verify the
    // actual painted rich-text content instead of depending on that internal
    // widget decomposition.
    final Finder renderedMarkdown = find.byWidgetPredicate((Widget widget) {
      return widget is RichText &&
          widget.text.toPlainText().contains('Formatted response');
    });
    expect(renderedMarkdown, findsWidgets);
    expect(
      find.bySemanticsLabel(
        RegExp('Response is still being written', caseSensitive: false),
      ),
      findsOneWidget,
    );
    expect(tester.takeException(), isNull);
  });
}
