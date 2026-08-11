import 'package:sentiq_chat/core/config/app_config.dart';
import 'package:sentiq_chat/core/network/auth_token_provider.dart';
import 'package:sentiq_chat/features/auth/data/auth_gateway.dart';
import 'package:sentiq_chat/features/auth/domain/auth_models.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

class SupabaseAuthGateway implements AuthGateway {
  const SupabaseAuthGateway({
    required SupabaseClient client,
    required AppConfig config,
  }) : _client = client,
       _config = config;

  final SupabaseClient _client;
  final AppConfig _config;

  @override
  Stream<AuthGatewayEvent> get events => _client.auth.onAuthStateChange.map((
    AuthState state,
  ) {
    final AuthGatewayEventType? type = switch (state.event) {
      AuthChangeEvent.signedIn ||
      AuthChangeEvent.initialSession => AuthGatewayEventType.signedIn,
      AuthChangeEvent.signedOut => AuthGatewayEventType.signedOut,
      AuthChangeEvent.passwordRecovery => AuthGatewayEventType.passwordRecovery,
      AuthChangeEvent.tokenRefreshed => AuthGatewayEventType.tokenRefreshed,
      AuthChangeEvent.userUpdated => AuthGatewayEventType.userUpdated,
      _ => null,
    };
    return AuthGatewayEvent(
      type: type ?? AuthGatewayEventType.tokenRefreshed,
      session: _snapshot(state.session),
    );
  });

  @override
  Future<AuthSessionSnapshot?> restoreSession() async {
    return _snapshot(_client.auth.currentSession);
  }

  @override
  Future<AuthActionResult> signInWithPassword(
    String email,
    String password,
  ) async {
    final AuthResponse response = await _client.auth.signInWithPassword(
      email: email.trim(),
      password: password,
    );
    return AuthActionResult(session: _snapshot(response.session));
  }

  @override
  Future<AuthActionResult> signUp(String email, String password) async {
    final AuthResponse response = await _client.auth.signUp(
      email: email.trim(),
      password: password,
      emailRedirectTo: _config.loginRedirectUri.toString(),
    );
    return AuthActionResult(
      session: _snapshot(response.session),
      emailConfirmationRequired: response.session == null,
    );
  }

  @override
  Future<void> signInWithGoogle() async {
    await _client.auth.signInWithOAuth(
      OAuthProvider.google,
      redirectTo: _config.loginRedirectUri.toString(),
      authScreenLaunchMode: LaunchMode.externalApplication,
    );
  }

  @override
  Future<void> sendPasswordReset(String email) async {
    await _client.auth.resetPasswordForEmail(
      email.trim(),
      redirectTo: _config.recoveryRedirectUri.toString(),
    );
  }

  @override
  Future<AuthSessionSnapshot> updatePassword(String password) async {
    final UserResponse response = await _client.auth.updateUser(
      UserAttributes(password: password),
    );
    return _requiredSnapshot(response.user);
  }

  @override
  Future<AuthSessionSnapshot> updateDisplayName(String displayName) async {
    final UserResponse response = await _client.auth.updateUser(
      UserAttributes(
        data: <String, Object?>{'display_name': displayName.trim()},
      ),
    );
    return _requiredSnapshot(response.user);
  }

  @override
  Future<void> signOut() => _client.auth.signOut();

  AuthSessionSnapshot? _snapshot(Session? session) {
    final User? user = session?.user;
    return user == null ? null : _snapshotFromUser(user);
  }

  AuthSessionSnapshot _requiredSnapshot(User? user) {
    final User? resolved = user ?? _client.auth.currentUser;
    if (resolved == null) {
      throw StateError('The signed-in user could not be restored.');
    }
    return _snapshotFromUser(resolved);
  }

  AuthSessionSnapshot _snapshotFromUser(User user) {
    return AuthSessionSnapshot(
      userId: user.id,
      email: user.email,
      metadata:
          user.userMetadata?.map(
            (String key, Object? value) => MapEntry(key, value),
          ) ??
          const <String, Object?>{},
    );
  }
}

class SupabaseAuthTokenProvider implements AuthTokenProvider {
  const SupabaseAuthTokenProvider(this._client);

  final SupabaseClient _client;

  @override
  Future<String?> readAccessToken() async =>
      _client.auth.currentSession?.accessToken;
}
