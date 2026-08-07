import 'package:flutter_test/flutter_test.dart';
import 'package:sentiq_chat/features/account/application/account_controller.dart';
import 'package:sentiq_chat/features/account/data/account_repository.dart';
import 'package:sentiq_chat/features/account/domain/account_models.dart';

void main() {
  test('loads and deletes cloud memories', () async {
    final _AccountFake gateway = _AccountFake();
    final AccountController controller = AccountController(
      repository: gateway,
      ownerScope: 'user-1',
      cloudEnabled: true,
    );
    await controller.initialize();

    expect(controller.state.memories, hasLength(2));
    await controller.deleteMemory('memory-1');
    expect(gateway.deleted, <String>['memory-1']);
    expect(
      controller.state.memories.map((AccountMemory item) => item.id),
      isNot(contains('memory-1')),
    );
    controller.dispose();
  });

  test('device clearing is scoped to the signed-in owner', () async {
    final _AccountFake gateway = _AccountFake();
    final AccountController controller = AccountController(
      repository: gateway,
      ownerScope: 'user-42',
      cloudEnabled: true,
    );

    expect(await controller.clearDeviceData(), isTrue);
    expect(gateway.clearedScope, 'user-42');
    expect(controller.state.message, contains('device'));
    controller.dispose();
  });

  test('temporary file clearing is independent from cloud memory', () async {
    final _AccountFake gateway = _AccountFake();
    final AccountController controller = AccountController(
      repository: gateway,
      ownerScope: 'guest',
      cloudEnabled: false,
    );

    expect(await controller.clearTemporaryFiles(), isTrue);
    expect(gateway.temporaryClears, 1);
    expect(gateway.memoryLoads, 0);
    controller.dispose();
  });
}

class _AccountFake implements AccountGateway {
  int memoryLoads = 0;
  int temporaryClears = 0;
  String? clearedScope;
  final List<String> deleted = <String>[];

  @override
  Future<List<AccountMemory>> memories() async {
    memoryLoads += 1;
    return const <AccountMemory>[
      AccountMemory(
        id: 'memory-1',
        summary: 'Prefers concise answers',
        type: 'preference',
        scope: 'global',
        importance: 8,
      ),
      AccountMemory(
        id: 'memory-2',
        summary: 'Project launch date',
        type: 'project',
        scope: 'chat',
        importance: 6,
      ),
    ];
  }

  @override
  Future<void> deleteMemory(String id) async => deleted.add(id);
  @override
  Future<void> clearTemporaryFiles() async => temporaryClears += 1;
  @override
  Future<void> clearDeviceData(String ownerScope) async =>
      clearedScope = ownerScope;
}
