import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sentiq_chat/core/design_system/sentiq_theme.dart';
import 'package:sentiq_chat/features/chat/domain/chat_models.dart';
import 'package:sentiq_chat/features/multimodal/presentation/multimodal_message_extras.dart';

void main() {
  testWidgets('keeps long reports and many image messages lazily mounted', (
    WidgetTester tester,
  ) async {
    final String tinyPng = base64Encode(<int>[
      137,
      80,
      78,
      71,
      13,
      10,
      26,
      10,
      0,
      0,
      0,
      13,
      73,
      72,
      68,
      82,
      0,
      0,
      0,
      1,
      0,
      0,
      0,
      1,
      8,
      6,
      0,
      0,
      0,
      31,
      21,
      196,
      137,
      0,
      0,
      0,
      13,
      73,
      68,
      65,
      84,
      8,
      215,
      99,
      248,
      207,
      192,
      240,
      31,
      0,
      5,
      0,
      1,
      255,
      137,
      153,
      61,
      29,
      0,
      0,
      0,
      0,
      73,
      69,
      78,
      68,
      174,
      66,
      96,
      130,
    ]);
    final List<ChatMessage> messages = List<ChatMessage>.generate(
      120,
      (int index) => ChatMessage(
        id: 'image-$index',
        conversationId: 'memory',
        role: ChatMessageRole.assistant,
        content:
            'Report section $index ${List<String>.filled(100, 'detail').join(' ')}',
        createdAt: DateTime.utc(2026, 8, 6).add(Duration(seconds: index)),
        status: ChatMessageStatus.complete,
        metadata: <String, Object?>{
          'image': <String, Object?>{
            'type': 'image',
            'image_base64': tinyPng,
            'prompt': 'Image $index',
          },
        },
      ),
    );
    await tester.pumpWidget(
      MaterialApp(
        theme: SentIQTheme.light(),
        home: Scaffold(
          body: ListView.builder(
            itemCount: messages.length,
            itemBuilder: (_, int index) => MultimodalMessageExtras(
              message: messages[index],
              onImageAction: (_, _) async {},
              onArtifactAction: (_, _) async {},
              onDeleteImage: (_) async {},
              onDeleteArtifact: (_) async {},
              onSaveArtifactHtml: (artifact, _) async => artifact,
            ),
          ),
        ),
      ),
    );
    await tester.pump();
    expect(
      find.byType(MultimodalMessageExtras).evaluate().length,
      lessThan(30),
    );
    expect(tester.takeException(), isNull);
  });
}
