import 'package:flutter_test/flutter_test.dart';
import 'package:sentiq_chat/core/layout/adaptive_window.dart';

void main() {
  test('classifies phone, foldable, and tablet widths', () {
    expect(classifyWindow(360), AdaptiveWindowClass.compact);
    expect(classifyWindow(720), AdaptiveWindowClass.medium);
    expect(classifyWindow(1200), AdaptiveWindowClass.expanded);
  });
}
