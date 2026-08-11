import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sentiq_chat/core/design_system/sentiq_theme.dart';
import 'package:sentiq_chat/features/multimodal/domain/multimodal_models.dart';
import 'package:sentiq_chat/features/multimodal/presentation/multimodal_message_extras.dart';

void main() {
  testWidgets('renders generated HTML through the sanitized native boundary', (
    WidgetTester tester,
  ) async {
    const GeneratedArtifactPayload artifact = GeneratedArtifactPayload(
      id: 'html-1',
      fileName: 'preview.html',
      format: 'html',
      mimeType: 'text/html',
      html:
          '<h1 onclick="steal()">Safe heading</h1>'
          '<script>alert(1)</script>'
          '<p>Visible paragraph</p>',
    );
    await tester.pumpWidget(
      MaterialApp(
        theme: SentIQTheme.light(),
        home: const Scaffold(body: SafeArtifactPreview(artifact: artifact)),
      ),
    );
    expect(find.textContaining('Safe heading'), findsOneWidget);
    expect(find.textContaining('Visible paragraph'), findsOneWidget);
    expect(find.textContaining('alert(1)'), findsNothing);
    expect(tester.takeException(), isNull);
  });

  test('rejects credential-bearing remote presentation URLs', () {
    expect(
      const GeneratedImagePayload(
        url: 'https://user:secret@example.com/image.png',
      ).valid,
      isFalse,
    );
    expect(
      WebSurfPayload.fromJson(<String, Object?>{
        'query': 'unsafe',
        'images': <String>[
          'https://user:secret@example.com/image.png',
          'https://example.com/image.png',
        ],
      }).imageUrls,
      <String>['https://example.com/image.png'],
    );
  });
}
