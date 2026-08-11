abstract interface class AuthTokenProvider {
  Future<String?> readAccessToken();
}

class EmptyAuthTokenProvider implements AuthTokenProvider {
  const EmptyAuthTokenProvider();

  @override
  Future<String?> readAccessToken() async => null;
}

class MutableAuthTokenProvider implements AuthTokenProvider {
  String? _token;

  void setToken(String? token) {
    final String normalized = token?.trim() ?? '';
    _token = normalized.isEmpty ? null : normalized;
  }

  @override
  Future<String?> readAccessToken() async => _token;
}
