import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:sentiq_chat/app/app_providers.dart';
import 'package:sentiq_chat/core/design_system/sentiq_theme.dart';
import 'package:sentiq_chat/core/performance/performance_policy.dart';
import 'package:sentiq_chat/features/auth/domain/auth_models.dart';
import 'package:sentiq_chat/features/auth/presentation/auth_flow_screen.dart';
import 'package:sentiq_chat/features/auth/presentation/display_name_screen.dart';
import 'package:sentiq_chat/features/auth/presentation/launch_screen.dart';
import 'package:sentiq_chat/features/auth/presentation/password_update_screen.dart';
import 'package:sentiq_chat/features/workspace/presentation/workspace_screen.dart';

class SentIQApp extends ConsumerWidget {
  const SentIQApp({super.key});

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final ThemeMode themeMode = ref.watch(themeControllerProvider);
    final AppAuthState authState = ref.watch(authControllerProvider);
    final bool platformReducedMotion = WidgetsBinding
        .instance
        .platformDispatcher
        .accessibilityFeatures
        .disableAnimations;
    final Duration routeMotion = platformReducedMotion
        ? Duration.zero
        : const Duration(milliseconds: 280);
    return MaterialApp(
      title: 'SentIQ Chat',
      debugShowCheckedModeBanner: false,
      theme: SentIQTheme.light(),
      darkTheme: SentIQTheme.dark(),
      themeMode: themeMode,
      themeAnimationDuration: routeMotion,
      builder: (BuildContext context, Widget? child) {
        return FocusTraversalGroup(
          policy: ReadingOrderTraversalPolicy(),
          child: child ?? const SizedBox.shrink(),
        );
      },
      home: Builder(
        builder: (BuildContext context) => AnimatedSwitcher(
          duration: SentIQPerformancePolicy.motionDuration(
            context,
            const Duration(milliseconds: 280),
          ),
          switchInCurve: Curves.easeOutCubic,
          switchOutCurve: Curves.easeInCubic,
          child: _rootFor(authState),
        ),
      ),
    );
  }

  Widget _rootFor(AppAuthState state) {
    return switch (state.status) {
      AppAuthStatus.initializing => const LaunchScreen(
        key: ValueKey<String>('launch'),
      ),
      AppAuthStatus.requiresDisplayName => const DisplayNameScreen(
        key: ValueKey<String>('display-name'),
      ),
      AppAuthStatus.passwordRecovery => const PasswordUpdateScreen(
        key: ValueKey<String>('password-recovery'),
      ),
      AppAuthStatus.guest || AppAuthStatus.authenticated => WorkspaceScreen(
        key: ValueKey<String>('workspace-${state.identity?.id ?? 'guest'}'),
        identity: state.identity ?? const AppIdentity.guest(),
      ),
      _ => const AuthFlowScreen(key: ValueKey<String>('auth-flow')),
    };
  }
}
