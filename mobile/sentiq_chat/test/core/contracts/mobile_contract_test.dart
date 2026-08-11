import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:sentiq_chat/core/contracts/mobile_contract.dart';

void main() {
  test('reads the non-destructive mobile contract from config', () async {
    final String raw = await File('test/fixtures/config.json').readAsString();
    final Map<String, Object?> config = (jsonDecode(raw) as Map)
        .cast<String, Object?>();
    final MobileContract contract = MobileContract.fromConfig(config);

    expect(contract.contractVersion, 4);
    expect(contract.minimumClientContractVersion, 1);
    expect(contract.sseVersion, 1);
    expect(contract.unknownFieldsAreSafe, isTrue);
    expect(contract.unknownSseEventsAreSafe, isTrue);
    expect(contract.endpoints['chat_stream'], '/api/chat/stream');
    expect(contract.endpoints['image_quota'], '/api/images/quota');
    expect(
      contract.endpoints['generated_file_download'],
      '/api/generated-files/:id/download',
    );
    expect(
      contract.endpoints['deep_research_events'],
      '/api/deep-research/:id/events',
    );
    expect(contract.endpoints['billing_checkout'], '/api/billing/checkout');
    expect(
      contract.endpoints['live_session_commit'],
      '/api/live/session/:id/commit',
    );
    expect(contract.supportsClientVersion(1), isTrue);
  });
}
