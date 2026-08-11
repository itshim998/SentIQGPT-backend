import 'dart:async';

import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:sentiq_chat/features/auth/data/auth_gateway.dart';
import 'package:sentiq_chat/features/auth/data/profile_repository.dart';
import 'package:sentiq_chat/features/auth/domain/auth_models.dart';

class AuthController extends StateNotifier<AppAuthState> {
  AuthController({
    required AuthGateway gateway,
    required ProfileRepository profileRepository,
  }) : _gateway = gateway,
       _profileRepository = profileRepository,
       super(const AppAuthState.initializing()) {
    _subscription = _gateway.events.listen(_handleGatewayEvent);
  }

  final AuthGateway _gateway;
  final ProfileRepository _profileRepository;
  late final StreamSubscription<AuthGatewayEvent> _subscription;

  Future<void> initialize() async {
    state = const AppAuthState.initializing();
    try {
      final AuthSessionSnapshot? session = await _gateway.restoreSession();
      if (session == null) {
        state = const AppAuthState(status: AppAuthStatus.signedOut);
        return;
      }
      await _completeSignedInSession(session);
    } catch (_) {
      state = const AppAuthState(
        status: AppAuthStatus.signedOut,
        message:
            'We could not restore your session. You can still continue as a guest.',
      );
    }
  }

  void continueAsGuest() {
    state = const AppAuthState(
      status: AppAuthStatus.guest,
      identity: AppIdentity.guest(),
    );
  }

  void returnToSignIn() {
    state = const AppAuthState(status: AppAuthStatus.signedOut);
  }

  Future<void> signIn(String email, String password) async {
    await _runAuthAction(() async {
      final AuthActionResult result = await _gateway.signInWithPassword(
        email,
        password,
      );
      final AuthSessionSnapshot? session = result.session;
      if (session == null) throw StateError('No session was returned.');
      await _completeSignedInSession(session);
    });
  }

  Future<void> signUp(String email, String password) async {
    await _runAuthAction(() async {
      final AuthActionResult result = await _gateway.signUp(email, password);
      if (result.emailConfirmationRequired || result.session == null) {
        state = const AppAuthState(
          status: AppAuthStatus.awaitingEmailConfirmation,
          message: 'Check your email to finish creating your account.',
        );
        return;
      }
      await _completeSignedInSession(result.session!);
    });
  }

  Future<void> signInWithGoogle() async {
    await _runAuthAction(_gateway.signInWithGoogle);
  }

  Future<void> reconcileExternalSession() async {
    if (state.status != AppAuthStatus.signedOut) return;
    try {
      final AuthSessionSnapshot? session = await _gateway.restoreSession();
      if (session != null) await _completeSignedInSession(session);
    } catch (_) {
      // The auth-state stream remains authoritative; a later callback can retry.
    }
  }

  Future<void> requestPasswordReset(String email) async {
    await _runAuthAction(() async {
      await _gateway.sendPasswordReset(email);
      state = const AppAuthState(
        status: AppAuthStatus.signedOut,
        message: 'A password reset link has been sent to your email.',
      );
    });
  }

  Future<void> updatePassword(String password) async {
    await _runAuthAction(() async {
      final AuthSessionSnapshot session = await _gateway.updatePassword(
        password,
      );
      await _completeSignedInSession(session);
    });
  }

  Future<void> saveDisplayName(String displayName) async {
    final String normalized = displayName.trim();
    if (normalized.length < 2) {
      state = state.copyWith(
        message: 'Enter the name you would like SentIQ Chat to use.',
      );
      return;
    }
    await _runAuthAction(() async {
      final String saved = await _profileRepository.updateDisplayName(
        normalized,
      );
      final AuthSessionSnapshot session = await _gateway.updateDisplayName(
        saved,
      );
      _applySignedInSession(session, saved);
    });
  }

  Future<void> signOut() async {
    state = state.copyWith(busy: true, clearMessage: true);
    try {
      await _gateway.signOut();
    } finally {
      state = const AppAuthState(status: AppAuthStatus.signedOut);
    }
  }

  Future<void> _completeSignedInSession(AuthSessionSnapshot session) async {
    final String? metadataDisplayName = _metadataDisplayName(session.metadata);
    if (metadataDisplayName != null) {
      // Supabase already carries enough trusted identity data to enter the
      // workspace. Do not wait for an extra backend profile round trip.
      _applySignedInSession(session, metadataDisplayName);
      unawaited(_reconcileDisplayName(session));
      return;
    }

    String? displayName;
    try {
      displayName = await _profileRepository.getDisplayName();
    } catch (_) {
      displayName = null;
    }
    _applySignedInSession(session, displayName);
  }

  void _applySignedInSession(
    AuthSessionSnapshot session,
    String? displayName,
  ) {
    final AppIdentity identity = AppIdentity(
      id: session.userId,
      email: session.email,
      displayName: displayName,
      isGuest: false,
    );
    state = AppAuthState(
      status: displayName == null
          ? AppAuthStatus.requiresDisplayName
          : AppAuthStatus.authenticated,
      identity: identity,
    );
  }

  Future<void> _reconcileDisplayName(AuthSessionSnapshot session) async {
    try {
      final String? remoteDisplayName =
          await _profileRepository.getDisplayName();
      if (remoteDisplayName == null || remoteDisplayName.trim().isEmpty) return;
      final AppIdentity? current = state.identity;
      if (current == null || current.id != session.userId) return;
      if (current.displayName == remoteDisplayName) return;
      state = AppAuthState(
        status: AppAuthStatus.authenticated,
        identity: AppIdentity(
          id: session.userId,
          email: session.email,
          displayName: remoteDisplayName,
          isGuest: false,
        ),
      );
    } catch (_) {
      // Session metadata remains a valid immediate fallback. Profile refresh
      // can retry on a later auth/session event without blocking navigation.
    }
  }

  Future<void> _runAuthAction(Future<void> Function() action) async {
    state = state.copyWith(busy: true, clearMessage: true);
    try {
      await action();
    } catch (error) {
      state = state.copyWith(busy: false, message: _friendlyMessage(error));
      return;
    }
    if (state.busy) state = state.copyWith(busy: false);
  }

  void _handleGatewayEvent(AuthGatewayEvent event) {
    switch (event.type) {
      case AuthGatewayEventType.signedOut:
        state = const AppAuthState(status: AppAuthStatus.signedOut);
        return;
      case AuthGatewayEventType.passwordRecovery:
        state = AppAuthState(
          status: AppAuthStatus.passwordRecovery,
          identity: event.session == null
              ? null
              : AppIdentity(
                  id: event.session!.userId,
                  email: event.session!.email,
                  displayName: _metadataDisplayName(event.session!.metadata),
                  isGuest: false,
                ),
        );
        return;
      case AuthGatewayEventType.signedIn:
      case AuthGatewayEventType.tokenRefreshed:
      case AuthGatewayEventType.userUpdated:
        final AuthSessionSnapshot? session = event.session;
        if (session != null) unawaited(_completeSignedInSession(session));
        return;
    }
  }

  String? _metadataDisplayName(Map<String, Object?> metadata) {
    for (final String key in <String>['display_name', 'full_name', 'name']) {
      final String value = metadata[key]?.toString().trim() ?? '';
      if (value.isNotEmpty) return value;
    }
    return null;
  }

  String _friendlyMessage(Object error) {
    final String text = error.toString().toLowerCase();
    if (text.contains('invalid login') || text.contains('credentials')) {
      return 'That email and password do not match.';
    }
    if (text.contains('network') || text.contains('socket')) {
      return 'You appear to be offline. Check your connection and try again.';
    }
    if (text.contains('password')) {
      return 'Please use a stronger password and try again.';
    }
    return 'We could not finish that. Please try again.';
  }

  @override
  void dispose() {
    unawaited(_subscription.cancel());
    super.dispose();
  }
}
