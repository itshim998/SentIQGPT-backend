import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sentiq_chat/core/design_system/sentiq_theme.dart';
import 'package:sentiq_chat/features/chat/application/chat_controller.dart';
import 'package:sentiq_chat/features/chat/domain/chat_models.dart';
import 'package:sentiq_chat/features/chat/presentation/chat_message_list.dart';

void main() {
  testWidgets('virtualizes a one-thousand-message thread', (
    WidgetTester tester,
  ) async {
    final DateTime start = DateTime.utc(2026, 8, 6);
    final List<ChatMessage> messages = List<ChatMessage>.generate(
      1000,
      (int index) => ChatMessage(
        id: 'message-$index',
        conversationId: 'long-thread',
        role: index.isEven ? ChatMessageRole.user : ChatMessageRole.assistant,
        content: 'Message $index with enough content to exercise rebuilding.',
        createdAt: start.add(Duration(seconds: index)),
        status: ChatMessageStatus.complete,
      ),
    );

    await tester.pumpWidget(
      MaterialApp(
        theme: SentIQTheme.light(),
        home: Scaffold(
          body: ChatMessageList(
            thread: ChatThreadState(messages: messages, loaded: true),
            onRetry: (_) {},
            onContinue: (_) {},
            onAskSelected: (_) {},
          ),
        ),
      ),
    );
    await tester.pump();

    expect(find.byType(ChatMessageView).evaluate().length, lessThan(80));
    expect(find.textContaining('Message 999'), findsNothing);
    await tester.drag(find.byType(ListView), const Offset(0, -8000));
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
  });
}
