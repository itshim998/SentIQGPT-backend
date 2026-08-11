import 'package:flutter_test/flutter_test.dart';
import 'package:sentiq_chat/features/auth/application/auth_controller.dart';
import 'package:sentiq_chat/features/auth/domain/auth_models.dart';

import '../../support/auth_fakes.dart';

const AuthSessionSnapshot _session = AuthSessionSnapshot(
  userId: 'user-1',
  email: 'person@example.com',
  metadata: <String, Object?>{},
);

void main() {
  group('AuthController', () {
    test('cold start without a session opens sign in', () async {
      final FakeAuthGateway gateway = FakeAuthGateway();
      final AuthController controller = AuthController(
        gateway: gateway,
        profileRepository: FakeProfileRepository(),
      );

      await controller.initialize();

      expect(controller.state.status, AppAuthStatus.signedOut);
      controller.dispose();
      await gateway.close();
    });

    test('restored session opens the authenticated workspace', () async {
      final FakeAuthGateway gateway = FakeAuthGateway()
        ..restoredSession = _session;
      final AuthController controller = AuthController(
        gateway: gateway,
        profileRepository: FakeProfileRepository(displayName: 'Sounak'),
      );

      await controller.initialize();

      expect(controller.state.status, AppAuthStatus.authenticated);
      expect(controller.state.identity?.displayName, 'Sounak');
      controller.dispose();
      await gateway.close();
    });

    test('restored session without a name requires completion', () async {
      final FakeAuthGateway gateway = FakeAuthGateway()
        ..restoredSession = _session;
      final AuthController controller = AuthController(
        gateway: gateway,
        profileRepository: FakeProfileRepository(),
      );

      await controller.initialize();

      expect(controller.state.status, AppAuthStatus.requiresDisplayName);
      controller.dispose();
      await gateway.close();
    });

    test('guest can transition into an authenticated account', () async {
      final FakeAuthGateway gateway = FakeAuthGateway()
        ..signInResult = const AuthActionResult(session: _session);
      final AuthController controller = AuthController(
        gateway: gateway,
        profileRepository: FakeProfileRepository(displayName: 'Sounak'),
      );
      await controller.initialize();
      controller.continueAsGuest();

      expect(controller.state.status, AppAuthStatus.guest);
      await controller.signIn('person@example.com', 'password123');

      expect(controller.state.status, AppAuthStatus.authenticated);
      expect(controller.state.identity?.isGuest, isFalse);
      controller.dispose();
      await gateway.close();
    });

    test('OAuth and recovery callbacks drive explicit states', () async {
      final FakeAuthGateway gateway = FakeAuthGateway();
      final AuthController controller = AuthController(
        gateway: gateway,
        profileRepository: FakeProfileRepository(displayName: 'Sounak'),
      );
      await controller.initialize();

      await controller.signInWithGoogle();
      expect(gateway.googleStarted, isTrue);
      gateway.emit(
        const AuthGatewayEvent(
          type: AuthGatewayEventType.signedIn,
          session: _session,
        ),
      );
      await Future<void>.delayed(Duration.zero);
      expect(controller.state.status, AppAuthStatus.authenticated);

      gateway.emit(
        const AuthGatewayEvent(
          type: AuthGatewayEventType.passwordRecovery,
          session: _session,
        ),
      );
      await Future<void>.delayed(Duration.zero);
      expect(controller.state.status, AppAuthStatus.passwordRecovery);
      controller.dispose();
      await gateway.close();
    });

    test('Google callback cannot be overwritten by launcher completion', () async {
      final FakeAuthGateway gateway = FakeAuthGateway()
        ..googleEventBeforeReturn = const AuthGatewayEvent(
          type: AuthGatewayEventType.signedIn,
          session: _session,
        );
      final AuthController controller = AuthController(
        gateway: gateway,
        profileRepository: FakeProfileRepository(displayName: 'Sounak'),
      );
      await controller.initialize();

      await controller.signInWithGoogle();
      await Future<void>.delayed(Duration.zero);

      expect(gateway.googleStarted, isTrue);
      expect(controller.state.status, AppAuthStatus.authenticated);
      expect(controller.state.identity?.email, 'person@example.com');
      controller.dispose();
      await gateway.close();
    });

    test('resuming from external auth reconciles an existing session', () async {
      final FakeAuthGateway gateway = FakeAuthGateway();
      final AuthController controller = AuthController(
        gateway: gateway,
        profileRepository: FakeProfileRepository(displayName: 'Sounak'),
      );
      await controller.initialize();
      expect(controller.state.status, AppAuthStatus.signedOut);

      gateway.restoredSession = _session;
      await controller.reconcileExternalSession();

      expect(controller.state.status, AppAuthStatus.authenticated);
      expect(controller.state.identity?.email, 'person@example.com');
      controller.dispose();
      await gateway.close();
    });
  });
}
