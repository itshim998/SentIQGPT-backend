import 'package:flutter_test/flutter_test.dart';
import 'package:sentiq_chat/features/chat/data/chat_repository.dart';
import 'package:sentiq_chat/features/chat/domain/chat_models.dart';

ChatMessage message({
  required String id,
  required String requestId,
  required ChatMessageRole role,
  required String content,
  required DateTime createdAt,
  ChatMessageStatus status = ChatMessageStatus.complete,
  bool local = false,
}) {
  return ChatMessage(
    id: id,
    conversationId: 'conversation-1',
    role: role,
    content: content,
    createdAt: createdAt,
    status: status,
    clientRequestId: requestId,
    locallyCreated: local,
  );
}

void main() {
  test('prevents duplicate user and assistant messages by request ID', () {
    final DateTime now = DateTime.utc(2026, 8, 6);
    final List<ChatMessage> merged = reconcileMessages(
      <ChatMessage>[
        message(
          id: 'local-user',
          requestId: 'request-1',
          role: ChatMessageRole.user,
          content: 'Hello',
          createdAt: now,
          status: ChatMessageStatus.pending,
          local: true,
        ),
        message(
          id: 'local-assistant',
          requestId: 'request-1',
          role: ChatMessageRole.assistant,
          content: 'Partial',
          createdAt: now.add(const Duration(microseconds: 1)),
          status: ChatMessageStatus.interrupted,
          local: true,
        ),
      ],
      <ChatMessage>[
        message(
          id: 'cloud-user',
          requestId: 'request-1',
          role: ChatMessageRole.user,
          content: 'Hello',
          createdAt: now,
        ),
        message(
          id: 'cloud-assistant',
          requestId: 'request-1',
          role: ChatMessageRole.assistant,
          content: 'Cloud answer',
          createdAt: now.add(const Duration(microseconds: 1)),
        ),
      ],
    );

    expect(merged, hasLength(2));
    expect(merged.first.id, 'local-user');
    expect(merged.last.content, 'Partial');
    expect(merged.last.status, ChatMessageStatus.interrupted);
  });

  test('uses cloud completion after local pending state is resolved', () {
    final DateTime now = DateTime.utc(2026, 8, 6);
    final List<ChatMessage> merged = reconcileMessages(
      <ChatMessage>[
        message(
          id: 'local',
          requestId: 'request-2',
          role: ChatMessageRole.assistant,
          content: 'Old',
          createdAt: now,
          local: false,
        ),
      ],
      <ChatMessage>[
        message(
          id: 'cloud',
          requestId: 'request-2',
          role: ChatMessageRole.assistant,
          content: 'Final',
          createdAt: now,
        ),
      ],
    );

    expect(merged.single.id, 'cloud');
    expect(merged.single.content, 'Final');
  });
}
