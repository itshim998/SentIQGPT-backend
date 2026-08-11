import 'package:flutter_test/flutter_test.dart';
import 'package:sentiq_chat/core/config/app_environment.dart';

void main() {
  group('AppEnvironment', () {
    test('parses supported aliases', () {
      expect(AppEnvironment.parse('dev'), AppEnvironment.development);
      expect(AppEnvironment.parse('staging'), AppEnvironment.staging);
      expect(AppEnvironment.parse('prod'), AppEnvironment.production);
    });

    test('fails closed to production', () {
      expect(AppEnvironment.parse('unexpected'), AppEnvironment.production);
    });
  });
}
