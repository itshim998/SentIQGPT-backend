import 'package:flutter_test/flutter_test.dart';
import 'package:sentiq_chat/features/chat/application/token_batcher.dart';

void main() {
  test('batches rapid token fragments into one render update', () async {
    final List<String> flushes = <String>[];
    final TokenBatcher batcher = TokenBatcher(
      interval: const Duration(milliseconds: 20),
      onFlush: flushes.add,
    );

    batcher
      ..add('Sent')
      ..add('IQ')
      ..add(' Chat');
    await Future<void>.delayed(const Duration(milliseconds: 35));
    batcher.close();

    expect(flushes, <String>['SentIQ Chat']);
  });
}
