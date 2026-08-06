import 'package:sentiq_chat/core/network/anonymous_identity.dart';
import 'package:sentiq_chat/core/network/auth_token_provider.dart';

class SentIQRequestHeaders {
  const SentIQRequestHeaders({
    required AuthTokenProvider authTokenProvider,
    required AnonymousIdentityStore anonymousIdentityStore,
    required int mobileContractVersion,
  })  : _authTokenProvider = authTokenProvider,
        _anonymousIdentityStore = anonymousIdentityStore,
        _mobileContractVersion = mobileContractVersion;

  final AuthTokenProvider _authTokenProvider;
  final AnonymousIdentityStore _anonymousIdentityStore;
  final int _mobileContractVersion;

  Future<Map<String, String>> build({
    Map<String, String> base = const <String, String>{},
    bool json = true,
  }) async {
    final String anonymousId = await _anonymousIdentityStore.getOrCreate();
    final String? accessToken = await _authTokenProvider.readAccessToken();
    return <String, String>{
      if (json) 'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-SentIQ-Anonymous-Id': anonymousId,
      'X-SentIQ-Mobile-Contract': _mobileContractVersion.toString(),
      if (accessToken != null && accessToken.isNotEmpty)
        'Authorization': 'Bearer $accessToken',
      ...base,
    };
  }
}
