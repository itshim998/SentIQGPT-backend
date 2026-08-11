import 'package:flutter_test/flutter_test.dart';
import 'package:sentiq_chat/core/security/safe_external_link.dart';

void main() {
  test('external content accepts only credential-free HTTPS links', () {
    expect(
      SafeExternalLink.isSafeHttps(Uri.parse('https://openai.com/')),
      isTrue,
    );
    expect(
      SafeExternalLink.isSafeHttps(Uri.parse('https://example.com/a?b=c')),
      isTrue,
    );
    expect(
      SafeExternalLink.isSafeHttps(Uri.parse('http://example.com')),
      isFalse,
    );
    expect(
      SafeExternalLink.isSafeHttps(Uri.parse('javascript:alert(1)')),
      isFalse,
    );
    expect(
      SafeExternalLink.isSafeHttps(Uri.parse('intent://example.com')),
      isFalse,
    );
    expect(
      SafeExternalLink.isSafeHttps(Uri.parse('https://user:pass@example.com/')),
      isFalse,
    );
  });
}
