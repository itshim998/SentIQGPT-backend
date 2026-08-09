import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sentiq_chat/core/design_system/sentiq_theme.dart';
import 'package:sentiq_chat/features/chat/domain/chat_models.dart';
import 'package:sentiq_chat/features/chat/presentation/chat_composer.dart';
import 'package:sentiq_chat/features/chat/presentation/compact_chat_composer.dart';
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

  testWidgets('sheet surface is opaque, compact and internally scrollable', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: SentIQTheme.dark(),
        home: Scaffold(
          body: Builder(
            builder: (BuildContext context) => TextButton(
              onPressed: () => showSentIQSheet<void>(
                context: context,
                builder: (_) => const SizedBox(
                  height: 1000,
                  child: Text('Tall sheet content'),
                ),
              ),
              child: const Text('Open tall sheet'),
            ),
          ),
        ),
      ),
    );
    final double viewportHeight = tester.getSize(find.byType(Scaffold)).height;

    await tester.tap(find.text('Open tall sheet'));
    await tester.pumpAndSettle();

    final Finder surface = find.byKey(const Key('sentiq-sheet-surface'));
    final Material material = tester.widget<Material>(surface);
    expect(surface, findsOneWidget);
    expect(material.color?.a, 1.0);
    expect(tester.getSize(surface).height, lessThanOrEqualTo(viewportHeight * 0.48 + 1));
    expect(find.byKey(const Key('sentiq-sheet-scroll-view')), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('actual response-mode picker opens without Material exception', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: SentIQTheme.light(),
        home: Scaffold(
          body: ChatExecutionModeButton(
            mode: ChatExecutionMode.fast,
            quota: const ChatQuotaState(),
            onChanged: (_) {},
          ),
        ),
      ),
    );

    await tester.tap(find.text('Fast'));
    await tester.pumpAndSettle();

    expect(find.text('Response style'), findsOneWidget);
    expect(find.text('Quick, direct responses'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('expanded response-mode picker has a visible Material ink layer', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: SentIQTheme.light(),
        home: Scaffold(
          body: ChatComposer(
            executionMode: ChatExecutionMode.fast,
            quota: const ChatQuotaState(),
            generating: false,
            attachments: const <ChatAttachment>[],
            webSearchEnabled: false,
            enabled: true,
            onExecutionModeChanged: (_) {},
            onWebSearchChanged: (_) {},
            onAttachmentAdded: (_) {},
            onAttachmentRemoved: (_) {},
            onAttachmentRetry: (_) {},
            onSend: (_) async => true,
            onStop: () {},
          ),
        ),
      ),
    );

    await tester.tap(find.text('Fast'));
    await tester.pumpAndSettle();

    expect(find.text('Response style'), findsOneWidget);
    expect(find.text('Quick, direct responses'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets('actual compact tools menu opens selected tile without exception', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: SentIQTheme.light(),
        home: Scaffold(
          body: CompactChatComposer(
            executionMode: ChatExecutionMode.fast,
            quota: const ChatQuotaState(),
            generating: false,
            attachments: const <ChatAttachment>[],
            webSearchEnabled: true,
            enabled: true,
            onWebSearchChanged: (_) {},
            onAttachmentAdded: (_) {},
            onAttachmentRemoved: (_) {},
            onAttachmentRetry: (_) {},
            onSend: (_) async => true,
            onStop: () {},
          ),
        ),
      ),
    );

    await tester.tap(find.byTooltip('Tools and attachments'));
    await tester.pumpAndSettle();

    expect(find.text('Attach files'), findsOneWidget);
    expect(find.text('Choose images'), findsOneWidget);
    expect(find.text('Search the web'), findsOneWidget);
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
