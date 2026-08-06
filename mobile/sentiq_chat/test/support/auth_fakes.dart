import 'dart:async';

import 'package:sentiq_chat/features/auth/data/auth_gateway.dart';
import 'package:sentiq_chat/features/auth/data/profile_repository.dart';
import 'package:sentiq_chat/features/auth/domain/auth_models.dart';

class FakeAuthGateway implements AuthGateway {
  final StreamController<AuthGatewayEvent> _events =
      StreamController<AuthGatewayEvent>.broadcast();

  AuthSessionSnapshot? restoredSession;
  AuthActionResult signInResult = const AuthActionResult(session: null);
  AuthActionResult signUpResult = const AuthActionResult(session: null);
  AuthSessionSnapshot updatedSession = const AuthSessionSnapshot(
    userId: 'user-1',
    email: 'person@example.com',
    metadata: <String, Object?>{},
  );
  bool googleStarted = false;
  bool resetRequested = false;
  bool signedOut = false;

  @override
  Stream<AuthGatewayEvent> get events => _events.stream;

  void emit(AuthGatewayEvent event) => _events.add(event);

  Future<void> close() => _events.close();

  @override
  Future<AuthSessionSnapshot?> restoreSession() async => restoredSession;

  @override
  Future<AuthActionResult> signInWithPassword(
    String email,
    String password,
  ) async => signInResult;

  @override
  Future<AuthActionResult> signUp(String email, String password) async =>
      signUpResult;

  @override
  Future<void> signInWithGoogle() async {
    googleStarted = true;
  }

  @override
  Future<void> sendPasswordReset(String email) async {
    resetRequested = true;
  }

  @override
  Future<AuthSessionSnapshot> updatePassword(String password) async =>
      updatedSession;

  @override
  Future<AuthSessionSnapshot> updateDisplayName(String displayName) async =>
      AuthSessionSnapshot(
        userId: updatedSession.userId,
        email: updatedSession.email,
        metadata: <String, Object?>{'display_name': displayName},
      );

  @override
  Future<void> signOut() async {
    signedOut = true;
  }
}

class FakeProfileRepository implements ProfileRepository {
  FakeProfileRepository({this.displayName});

  String? displayName;

  @override
  Future<String?> getDisplayName() async => displayName;

  @override
  Future<String> updateDisplayName(String value) async {
    displayName = value.trim();
    return displayName!;
  }
}
