import 'package:flutter_test/flutter_test.dart';
import 'package:sentiq_chat/features/chat/application/token_batcher.dart';

void main() {
  test('batches token updates on the configured interval', () async {
    final List<String> values = <String>[];
    final TokenBatcher batcher = TokenBatcher(
      onFlush: values.add,
      interval: const Duration(milliseconds: 10),
    );
    batcher
      ..add('Hello ')
      ..add('world');
    await Future<void>.delayed(const Duration(milliseconds: 20));
    expect(values, <String>['Hello ']);
    batcher.close();
    expect(values, <String>['Hello ', 'world']);
  });

  test('does not paint partial words but streams long unbroken content', () async {
    final List<String> values = <String>[];
    final TokenBatcher batcher = TokenBatcher(
      onFlush: values.add,
      interval: const Duration(milliseconds: 5),
    );
    batcher.add('part');
    await Future<void>.delayed(const Duration(milliseconds: 12));
    expect(values, isEmpty);
    batcher.add('ial word ');
    await Future<void>.delayed(const Duration(milliseconds: 12));
    expect(values, <String>['partial word ']);

    batcher.add(List<String>.filled(52, 'x').join());
    await Future<void>.delayed(const Duration(milliseconds: 12));
    expect(values.last.length, 52);
    batcher.close();
  });
}
