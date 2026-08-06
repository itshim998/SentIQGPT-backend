import 'package:flutter_test/flutter_test.dart';
import 'package:sentiq_chat/features/multimodal/data/content_policy.dart';

void main() {
  test('accepts supported file fixtures and rejects unsupported types', () {
    expect(
      AttachmentPolicy.validate(
        filename: 'report.pdf',
        mimeType: 'application/pdf',
        sizeBytes: 1024,
      ),
      isNull,
    );
    expect(
      AttachmentPolicy.validate(
        filename: 'analysis.py',
        mimeType: 'application/octet-stream',
        sizeBytes: 1024,
      ),
      isNull,
    );
    expect(
      AttachmentPolicy.validate(
        filename: 'archive.exe',
        mimeType: 'application/octet-stream',
        sizeBytes: 1024,
      ),
      contains('not supported'),
    );
  });

  test('rejects oversized files before network work starts', () {
    expect(
      AttachmentPolicy.validate(
        filename: 'large.pdf',
        mimeType: 'application/pdf',
        sizeBytes: AttachmentPolicy.maximumBytes + 1,
      ),
      contains('10 MB'),
    );
  });

  test('reports long and scanned PDF states honestly', () {
    expect(
      AttachmentPolicy.looksLikeScannedPdf(
        'This PDF appears to be scanned or image-based. No selectable text was found.',
      ),
      isTrue,
    );
    expect(
      AttachmentPolicy.isLongPdf(
        mimeType: 'application/pdf',
        sizeBytes: 6 * 1024 * 1024,
      ),
      isTrue,
    );
  });

  test('sanitizes active HTML and blocks unsafe navigation', () {
    final String clean = RemoteContentPolicy.sanitizeHtml(
      '<h1 onclick="steal()">Safe</h1><script>alert(1)</script>'
      '<a href="javascript:alert(1)">bad</a>',
    );
    expect(clean, isNot(contains('script')));
    expect(clean, isNot(contains('onclick')));
    expect(clean, isNot(contains('javascript:')));
    expect(
      RemoteContentPolicy.navigationAllowed('https://example.com/a'),
      isTrue,
    );
    expect(
      RemoteContentPolicy.navigationAllowed('http://example.com/a'),
      isFalse,
    );
    expect(RemoteContentPolicy.navigationAllowed('file:///tmp/a'), isFalse);
  });
}
