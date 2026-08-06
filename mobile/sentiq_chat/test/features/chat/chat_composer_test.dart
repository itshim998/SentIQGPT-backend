import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sentiq_chat/core/design_system/sentiq_theme.dart';
import 'package:sentiq_chat/features/chat/domain/chat_models.dart';
import 'package:sentiq_chat/features/chat/presentation/chat_composer.dart';

Widget app({required bool generating}) {
  return MaterialApp(
    theme: SentIQTheme.light(),
    home: Scaffold(
      body: Align(
        alignment: Alignment.bottomCenter,
        child: ChatComposer(
          executionMode: ChatExecutionMode.fast,
          quota: const ChatQuotaState(),
          generating: generating,
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
}

void main() {
  testWidgets('grows automatically for multiline input', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(app(generating: false));
    final double before = tester.getSize(find.byType(TextField)).height;
    await tester.enterText(
      find.byType(TextField),
      'One\nTwo\nThree\nFour\nFive',
    );
    await tester.pump();
    final double after = tester.getSize(find.byType(TextField)).height;
    expect(after, greaterThan(before));
  });

  testWidgets('switches from send to stop while generating', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(app(generating: false));
    expect(find.byTooltip('Send message'), findsOneWidget);
    await tester.pumpWidget(app(generating: true));
    await tester.pump();
    expect(find.byTooltip('Stop generating'), findsOneWidget);
  });
}
