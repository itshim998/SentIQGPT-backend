import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:sentiq_chat/core/config/app_config.dart';
import 'package:sentiq_chat/core/network/anonymous_identity.dart';
import 'package:sentiq_chat/core/network/api_client.dart';
import 'package:sentiq_chat/core/network/network_status.dart';
import 'package:sentiq_chat/core/network/request_headers.dart';
import 'package:sentiq_chat/core/preferences/theme_controller.dart';
import 'package:sentiq_chat/features/auth/application/auth_controller.dart';
import 'package:sentiq_chat/features/auth/data/auth_gateway.dart';
import 'package:sentiq_chat/features/auth/data/profile_repository.dart';
import 'package:sentiq_chat/features/auth/data/supabase_auth_gateway.dart';
import 'package:sentiq_chat/features/auth/domain/auth_models.dart';
import 'package:sentiq_chat/features/chat/application/chat_controller.dart';
import 'package:sentiq_chat/features/chat/data/chat_cache.dart';
import 'package:sentiq_chat/features/chat/data/chat_remote_source.dart';
import 'package:sentiq_chat/features/chat/data/chat_repository.dart';
import 'package:sentiq_chat/features/workspace/application/workspace_controller.dart';
import 'package:sentiq_chat/features/workspace/data/cloud_conversation_source.dart';
import 'package:sentiq_chat/features/workspace/data/conversation_cache.dart';
import 'package:sentiq_chat/features/workspace/data/conversation_repository.dart';
import 'package:supabase_flutter/supabase_flutter.dart';

final StateNotifierProvider<ThemeController, ThemeMode>
themeControllerProvider = StateNotifierProvider<ThemeController, ThemeMode>(
  (Ref ref) => ThemeController(),
);

final Provider<NetworkMonitor> networkMonitorProvider =
    Provider<NetworkMonitor>((Ref ref) => ConnectivityNetworkMonitor());

final Provider<AuthGateway> authGatewayProvider = Provider<AuthGateway>((
  Ref ref,
) {
  return SupabaseAuthGateway(
    client: Supabase.instance.client,
    config: ref.watch(appConfigProvider),
  );
});

final Provider<SentIQApiClient> apiClientProvider = Provider<SentIQApiClient>((
  Ref ref,
) {
  final AppConfig config = ref.watch(appConfigProvider);
  final SentIQApiClient client = SentIQApiClient(
    baseUri: config.apiBaseUri,
    requestHeaders: SentIQRequestHeaders(
      authTokenProvider: SupabaseAuthTokenProvider(Supabase.instance.client),
      anonymousIdentityStore: SharedPreferencesAnonymousIdentityStore(),
      mobileContractVersion: config.mobileContractVersion,
    ),
  );
  ref.onDispose(client.close);
  return client;
});

final Provider<ProfileRepository> profileRepositoryProvider =
    Provider<ProfileRepository>(
      (Ref ref) => ApiProfileRepository(ref.watch(apiClientProvider)),
    );

final StateNotifierProvider<AuthController, AppAuthState>
authControllerProvider = StateNotifierProvider<AuthController, AppAuthState>((
  Ref ref,
) {
  final AuthController controller = AuthController(
    gateway: ref.watch(authGatewayProvider),
    profileRepository: ref.watch(profileRepositoryProvider),
  );
  unawaited(controller.initialize());
  return controller;
});

final Provider<ConversationCache> conversationCacheProvider =
    Provider<ConversationCache>((Ref ref) {
      final ConversationCache cache = ConversationCache();
      ref.onDispose(() => unawaited(cache.close()));
      return cache;
    });

final Provider<CloudConversationSource> cloudConversationSourceProvider =
    Provider<CloudConversationSource>(
      (Ref ref) => CloudConversationSource(ref.watch(apiClientProvider)),
    );

final Provider<ConversationRepository> conversationRepositoryProvider =
    Provider<ConversationRepository>((Ref ref) {
      return ConversationRepository(
        cache: ref.watch(conversationCacheProvider),
        cloud: ref.watch(cloudConversationSourceProvider),
      );
    });

final Provider<ChatCache> chatCacheProvider = Provider<ChatCache>(
  (Ref ref) => ChatCache(ref.watch(conversationCacheProvider)),
);

final Provider<ChatRemoteSource> chatRemoteSourceProvider =
    Provider<ChatRemoteSource>(
      (Ref ref) => ChatRemoteSource(ref.watch(apiClientProvider)),
    );

final Provider<ChatRepository> chatRepositoryProvider =
    Provider<ChatRepository>((Ref ref) {
      return ChatRepository(
        cache: ref.watch(chatCacheProvider),
        remote: ref.watch(chatRemoteSourceProvider),
      );
    });

final workspaceControllerProvider = StateNotifierProvider.autoDispose
    .family<WorkspaceController, WorkspaceState, WorkspaceSession>((
      Ref ref,
      WorkspaceSession session,
    ) {
      final WorkspaceController controller = WorkspaceController(
        session: session,
        repository: ref.watch(conversationRepositoryProvider),
        networkMonitor: ref.watch(networkMonitorProvider),
      );
      unawaited(controller.initialize());
      return controller;
    });

final chatControllerProvider = StateNotifierProvider.autoDispose
    .family<ChatController, ChatState, WorkspaceSession>((
      Ref ref,
      WorkspaceSession session,
    ) {
      final ChatController controller = ChatController(
        session: session,
        repository: ref.watch(chatRepositoryProvider),
        networkMonitor: ref.watch(networkMonitorProvider),
      );
      unawaited(controller.initialize());
      return controller;
    });
