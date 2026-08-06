import 'package:sentiq_chat/core/network/anonymous_identity.dart';
import 'package:sentiq_chat/core/network/auth_token_provider.dart';

class SentIQRequestHeaders {
  const SentIQRequestHeaders({
    required this.authTokenProvider,
    required this.anonymousIdentityStore,
    required this.mobileContractVersion,
  });

  final AuthTokenProvider authTokenProvider;
  final AnonymousIdentityStore anonymousIdentityStore;
  final int mobileContractVersion;

  Future<Map<String, String>> build({
    Map<String, String> base = const <String, String>{},
    bool json = true,
  }) async {
    final String anonymousId = await anonymousIdentityStore.getOrCreate();
    final String? accessToken = await authTokenProvider.readAccessToken();
    return <String, String>{
      if (json) 'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-SentIQ-Anonymous-Id': anonymousId,
      'X-SentIQ-Mobile-Contract': mobileContractVersion.toString(),
      if (accessToken != null && accessToken.isNotEmpty)
        'Authorization': 'Bearer $accessToken',
      ...base,
    };
  }
}
