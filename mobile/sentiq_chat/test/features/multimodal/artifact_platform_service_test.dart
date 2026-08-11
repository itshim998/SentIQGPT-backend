import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:sentiq_chat/features/multimodal/platform/artifact_platform_service.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const MethodChannel channel = MethodChannel('phase4-artifact-test');
  final List<MethodCall> calls = <MethodCall>[];

  setUp(() {
    calls.clear();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (MethodCall call) async {
          calls.add(call);
          return call.method == 'saveFile' ? 'content://saved/file' : null;
        });
  });

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);
  });

  test(
    'routes image copy, share and download through native Android boundary',
    () async {
      const ArtifactPlatformService service = ArtifactPlatformService(
        channel: channel,
      );
      final Uint8List bytes = Uint8List.fromList(<int>[1, 2, 3]);
      await service.copyImage(
        bytes: bytes,
        filename: 'a.png',
        mimeType: 'image/png',
      );
      await service.shareFile(
        bytes: bytes,
        filename: 'a.png',
        mimeType: 'image/png',
      );
      final String? saved = await service.saveFile(
        bytes: bytes,
        filename: 'a.png',
        mimeType: 'image/png',
      );
      await service.openFile(
        bytes: bytes,
        filename: 'a.png',
        mimeType: 'image/png',
      );
      expect(calls.map((MethodCall call) => call.method), <String>[
        'copyImage',
        'shareFile',
        'saveFile',
        'openFile',
      ]);
      expect(saved, 'content://saved/file');
    },
  );
}
