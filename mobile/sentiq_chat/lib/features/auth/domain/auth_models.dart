enum AppAuthStatus {
  initializing,
  signedOut,
  guest,
  awaitingEmailConfirmation,
  requiresDisplayName,
  authenticated,
  passwordRecovery,
  failure,
}

class AppIdentity {
  const AppIdentity({
    required this.id,
    required this.email,
    required this.displayName,
    required this.isGuest,
  });

  const AppIdentity.guest()
    : id = 'guest',
      email = null,
      displayName = 'Guest',
      isGuest = true;

  final String id;
  final String? email;
  final String? displayName;
  final bool isGuest;

  AppIdentity copyWith({String? displayName}) {
    return AppIdentity(
      id: id,
      email: email,
      displayName: displayName ?? this.displayName,
      isGuest: isGuest,
    );
  }
}

class AppAuthState {
  const AppAuthState({
    required this.status,
    this.identity,
    this.message,
    this.busy = false,
  });

  const AppAuthState.initializing()
    : status = AppAuthStatus.initializing,
      identity = null,
      message = null,
      busy = true;

  final AppAuthStatus status;
  final AppIdentity? identity;
  final String? message;
  final bool busy;

  bool get hasWorkspace =>
      status == AppAuthStatus.guest || status == AppAuthStatus.authenticated;

  AppAuthState copyWith({
    AppAuthStatus? status,
    AppIdentity? identity,
    String? message,
    bool? busy,
    bool clearMessage = false,
  }) {
    return AppAuthState(
      status: status ?? this.status,
      identity: identity ?? this.identity,
      message: clearMessage ? null : message ?? this.message,
      busy: busy ?? this.busy,
    );
  }
}

enum AuthGatewayEventType {
  signedIn,
  signedOut,
  passwordRecovery,
  tokenRefreshed,
  userUpdated,
}

class AuthSessionSnapshot {
  const AuthSessionSnapshot({
    required this.userId,
    required this.email,
    required this.metadata,
  });

  final String userId;
  final String? email;
  final Map<String, Object?> metadata;
}

class AuthGatewayEvent {
  const AuthGatewayEvent({required this.type, this.session});

  final AuthGatewayEventType type;
  final AuthSessionSnapshot? session;
}

class AuthActionResult {
  const AuthActionResult({
    required this.session,
    this.emailConfirmationRequired = false,
  });

  final AuthSessionSnapshot? session;
  final bool emailConfirmationRequired;
}
