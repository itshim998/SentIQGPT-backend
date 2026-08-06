import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:sentiq_chat/core/network/api_client.dart';

void main() {
  test('multipart uploads expose idempotent cancellation', () async {
    int cancellations = 0;
    final Completer<Map<String, Object?>> response =
        Completer<Map<String, Object?>>();
    final SentIQMultipartUpload upload = SentIQMultipartUpload(
      response: response.future,
      progress: const Stream<double>.empty(),
      onCancel: () async {
        cancellations += 1;
        if (!response.isCompleted) {
          response.completeError(Exception('cancelled'));
        }
      },
    );
    final Future<void> failure = expectLater(upload.response, throwsException);
    await upload.cancel();
    await upload.cancel();
    expect(upload.isCancelled, isTrue);
    expect(cancellations, 1);
    await failure;
  });
}
