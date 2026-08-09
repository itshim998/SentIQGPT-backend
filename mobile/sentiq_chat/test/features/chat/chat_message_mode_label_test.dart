import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sentiq_chat/core/design_system/sentiq_theme.dart';
import 'package:sentiq_chat/features/chat/domain/chat_models.dart';
import 'package:sentiq_chat/features/chat/presentation/chat_message_list.dart';

void main() {
  testWidgets('user messages do not show execution mode labels', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: SentIQTheme.dark(),
        home: Scaffold(
          body: ChatMessageView(
            message: ChatMessage(
              id: 'user-1',
              conversationId: 'conversation-1',
              role: ChatMessageRole.user,
              content: 'Benefits of apple',
              createdAt: DateTime.utc(2026, 8, 9),
              status: ChatMessageStatus.pending,
              executionMode: ChatExecutionMode.fast,
            ),
            onAskSelected: (_) {},
          ),
        ),
      ),
    );

    expect(find.text('Benefits of apple'), findsOneWidget);
    expect(find.text('Fast'), findsNothing);
  });

  testWidgets('assistant messages preserve execution mode labels', (
    WidgetTester tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: SentIQTheme.dark(),
        home: Scaffold(
          body: ChatMessageView(
            message: ChatMessage(
              id: 'assistant-1',
              conversationId: 'conversation-1',
              role: ChatMessageRole.assistant,
              content: 'Apples provide fibre and micronutrients.',
              createdAt: DateTime.utc(2026, 8, 9),
              status: ChatMessageStatus.complete,
              executionMode: ChatExecutionMode.intuitive,
            ),
            onAskSelected: (_) {},
          ),
        ),
      ),
    );
    await tester.pump();

    expect(find.text('Intuitive'), findsOneWidget);
  });
}
