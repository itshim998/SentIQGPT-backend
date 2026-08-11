import 'package:sentiq_chat/features/auth/domain/auth_models.dart';

abstract interface class AuthGateway {
  Future<AuthSessionSnapshot?> restoreSession();
  Stream<AuthGatewayEvent> get events;
  Future<AuthActionResult> signInWithPassword(String email, String password);
  Future<AuthActionResult> signUp(String email, String password);
  Future<void> signInWithGoogle();
  Future<void> sendPasswordReset(String email);
  Future<AuthSessionSnapshot> updatePassword(String password);
  Future<AuthSessionSnapshot> updateDisplayName(String displayName);
  Future<void> signOut();
}
