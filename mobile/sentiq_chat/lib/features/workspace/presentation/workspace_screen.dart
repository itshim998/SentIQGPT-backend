import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:sentiq_chat/app/app_providers.dart';
import 'package:sentiq_chat/core/design_system/sentiq_tokens.dart';
import 'package:sentiq_chat/core/layout/adaptive_window.dart';
import 'package:sentiq_chat/features/auth/domain/auth_models.dart';
import 'package:sentiq_chat/features/workspace/application/workspace_controller.dart';
import 'package:sentiq_chat/features/workspace/domain/conversation_summary.dart';
import 'package:sentiq_chat/features/workspace/presentation/conversation_sidebar.dart';
import 'package:sentiq_chat/shared/widgets/refractive_glass_surface.dart';
import 'package:sentiq_chat/shared/widgets/sentiq_button.dart';
import 'package:sentiq_chat/shared/widgets/sentiq_dialog.dart';
import 'package:sentiq_chat/shared/widgets/sentiq_empty_state.dart';
import 'package:sentiq_chat/shared/widgets/sentiq_sheet.dart';
import 'package:sentiq_chat/shared/widgets/sentiq_text_field.dart';

class WorkspaceScreen extends ConsumerWidget {
  const WorkspaceScreen({required this.identity, super.key});

  final AppIdentity identity;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final WorkspaceSession session = WorkspaceSession(
      ownerScope: identity.isGuest ? 'guest' : identity.id,
      cloudEnabled: !identity.isGuest,
    );
    final WorkspaceState state = ref.watch(
      workspaceControllerProvider(session),
    );
    final WorkspaceController controller = ref.read(
      workspaceControllerProvider(session).notifier,
    );
    return LayoutBuilder(
      builder: (BuildContext context, BoxConstraints constraints) {
        final AdaptiveWindowClass windowClass =
            classifyWindow(constraints.maxWidth);
        final GlobalKey<ScaffoldState> scaffoldKey = GlobalKey<ScaffoldState>();
        final Widget sidebar = ConversationSidebar(
          identity: identity,
          state: state,
          controller: controller,
          onRename: (ConversationSummary item) =>
              _showRename(context, controller, item),
          onDelete: (ConversationSummary item) =>
              _showDelete(context, controller, item),
          onAccount: () => _showAccount(context, ref),
          onSettings: () => _showSettings(context, ref),
          onConversationSelected: windowClass == AdaptiveWindowClass.expanded
              ? null
              : () => Navigator.of(context).maybePop(),
        );
        final Widget canvas = _WorkspaceCanvas(
          state: state,
          controller: controller,
          compact: windowClass == AdaptiveWindowClass.compact,
        );
        return PopScope(
          canPop: windowClass == AdaptiveWindowClass.expanded ||
              state.selectedConversationId == null,
          onPopInvokedWithResult: (bool didPop, Object? result) {
            if (!didPop && state.selectedConversationId != null) {
              controller.clearSelection();
            }
          },
          child: Scaffold(
            key: scaffoldKey,
            resizeToAvoidBottomInset: true,
            drawer: windowClass == AdaptiveWindowClass.expanded
                ? null
                : Drawer(
                    width: constraints.maxWidth >= 600 ? 380 : 330,
                    child: SafeArea(child: sidebar),
                  ),
            appBar: windowClass == AdaptiveWindowClass.expanded
                ? null
                : AppBar(
                    title: Text(state.selected?.title ?? 'SentIQ Chat'),
                    centerTitle: false,
                    leading: IconButton(
                      tooltip: 'Open conversations',
                      icon: const Icon(Icons.menu_rounded),
                      onPressed: () => scaffoldKey.currentState?.openDrawer(),
                    ),
                    actions: <Widget>[
                      IconButton(
                        tooltip: 'New chat',
                        icon: const Icon(Icons.add_rounded),
                        onPressed: controller.newConversation,
                      ),
                    ],
                  ),
            body: SafeArea(
              top: windowClass == AdaptiveWindowClass.expanded,
              child: windowClass == AdaptiveWindowClass.expanded
                  ? Row(
                      children: <Widget>[
                        SizedBox(width: 340, child: sidebar),
                        const VerticalDivider(width: 1),
                        Expanded(child: canvas),
                      ],
                    )
                  : canvas,
            ),
          ),
        );
      },
    );
  }

  Future<void> _showRename(
    BuildContext context,
    WorkspaceController controller,
    ConversationSummary conversation,
  ) async {
    final TextEditingController title =
        TextEditingController(text: conversation.title);
    await showDialog<void>(
      context: context,
      builder: (BuildContext dialogContext) => SentIQDialog(
        title: 'Rename conversation',
        body: SentIQTextField(
          label: 'Conversation title',
          controller: title,
          textInputAction: TextInputAction.done,
          onSubmitted: (_) {
            unawaited(controller.renameConversation(conversation, title.text));
            Navigator.of(dialogContext).pop();
          },
        ),
        secondaryLabel: 'Cancel',
        onSecondary: () => Navigator.of(dialogContext).pop(),
        primaryLabel: 'Save',
        onPrimary: () {
          unawaited(controller.renameConversation(conversation, title.text));
          Navigator.of(dialogContext).pop();
        },
      ),
    );
    title.dispose();
  }

  Future<void> _showDelete(
    BuildContext context,
    WorkspaceController controller,
    ConversationSummary conversation,
  ) {
    return showDialog<void>(
      context: context,
      builder: (BuildContext dialogContext) => SentIQDialog(
        title: 'Delete this conversation?',
        body: Text(
          '“${conversation.title}” will be removed from this device and your account.',
        ),
        secondaryLabel: 'Keep it',
        onSecondary: () => Navigator.of(dialogContext).pop(),
        primaryLabel: 'Delete',
        onPrimary: () {
          unawaited(controller.deleteConversation(conversation));
          Navigator.of(dialogContext).pop();
        },
      ),
    );
  }

  Future<void> _showAccount(BuildContext context, WidgetRef ref) {
    return showSentIQSheet<void>(
      context: context,
      builder: (BuildContext sheetContext) => Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          Text(
            identity.isGuest ? 'Guest session' : identity.displayName ?? 'Account',
            style: Theme.of(context).textTheme.titleLarge,
          ),
          const SizedBox(height: SentIQSpacing.xs),
          Text(
            identity.isGuest
                ? 'This session stays on this device. Sign in to keep conversations across sessions.'
                : identity.email ?? 'Signed in to SentIQ Chat',
          ),
          const SizedBox(height: SentIQSpacing.lg),
          SentIQButton(
            label: identity.isGuest ? 'Sign in or create account' : 'Sign out',
            style: identity.isGuest
                ? SentIQButtonStyle.primary
                : SentIQButtonStyle.secondary,
            expand: true,
            onPressed: () {
              Navigator.of(sheetContext).pop();
              if (identity.isGuest) {
                ref.read(authControllerProvider.notifier).returnToSignIn();
              } else {
                unawaited(ref.read(authControllerProvider.notifier).signOut());
              }
            },
          ),
          const SizedBox(height: SentIQSpacing.sm),
        ],
      ),
    );
  }

  Future<void> _showSettings(BuildContext context, WidgetRef ref) {
    return showSentIQSheet<void>(
      context: context,
      builder: (BuildContext sheetContext) => Consumer(
        builder: (BuildContext context, WidgetRef ref, Widget? child) {
          final ThemeMode mode = ref.watch(themeControllerProvider);
          return Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: <Widget>[
              Text('Appearance', style: Theme.of(context).textTheme.titleLarge),
              const SizedBox(height: SentIQSpacing.xs),
              const Text('Choose how SentIQ Chat looks on this device.'),
              const SizedBox(height: SentIQSpacing.lg),
              SegmentedButton<ThemeMode>(
                segments: const <ButtonSegment<ThemeMode>>[
                  ButtonSegment<ThemeMode>(
                    value: ThemeMode.system,
                    icon: Icon(Icons.brightness_auto_outlined),
                    label: Text('System'),
                  ),
                  ButtonSegment<ThemeMode>(
                    value: ThemeMode.light,
                    icon: Icon(Icons.light_mode_outlined),
                    label: Text('Light'),
                  ),
                  ButtonSegment<ThemeMode>(
                    value: ThemeMode.dark,
                    icon: Icon(Icons.dark_mode_outlined),
                    label: Text('Dark'),
                  ),
                ],
                selected: <ThemeMode>{mode},
                onSelectionChanged: (Set<ThemeMode> values) {
                  unawaited(
                    ref
                        .read(themeControllerProvider.notifier)
                        .setMode(values.first),
                  );
                },
              ),
              const SizedBox(height: SentIQSpacing.lg),
              SentIQButton(
                label: 'Done',
                expand: true,
                onPressed: () => Navigator.of(sheetContext).pop(),
              ),
              const SizedBox(height: SentIQSpacing.sm),
            ],
          );
        },
      ),
    );
  }
}

class _WorkspaceCanvas extends StatelessWidget {
  const _WorkspaceCanvas({
    required this.state,
    required this.controller,
    required this.compact,
  });

  final WorkspaceState state;
  final WorkspaceController controller;
  final bool compact;

  @override
  Widget build(BuildContext context) {
    final SentIQPalette palette = context.sentiqPalette;
    return Column(
      children: <Widget>[
        if (state.networkState != WorkspaceNetworkState.online)
          Material(
            color: state.networkState == WorkspaceNetworkState.offline
                ? palette.warning.withValues(alpha: 0.14)
                : palette.info.withValues(alpha: 0.14),
            child: Padding(
              padding: const EdgeInsets.symmetric(
                horizontal: SentIQSpacing.md,
                vertical: SentIQSpacing.xs,
              ),
              child: Row(
                children: <Widget>[
                  Icon(
                    state.networkState == WorkspaceNetworkState.offline
                        ? Icons.cloud_off_outlined
                        : Icons.sync_problem_outlined,
                    size: 18,
                  ),
                  const SizedBox(width: SentIQSpacing.xs),
                  Expanded(
                    child: Text(
                      state.networkState == WorkspaceNetworkState.offline
                          ? 'You are offline. Changes will stay on this device until you reconnect.'
                          : 'Cloud sync is taking longer than usual. Your cached conversations are still available.',
                    ),
                  ),
                  TextButton(
                    onPressed: controller.refresh,
                    child: const Text('Retry'),
                  ),
                ],
              ),
            ),
          ),
        if (state.message != null)
          Padding(
            padding: const EdgeInsets.all(SentIQSpacing.sm),
            child: Text(
              state.message!,
              style: TextStyle(color: palette.textSecondary),
            ),
          ),
        Expanded(
          child: state.selected == null
              ? SentIQEmptyState(
                  icon: Icons.auto_awesome_outlined,
                  title: 'Start a new conversation',
                  message:
                      'Create a chat and it will appear here, ready for your messages.',
                  actionLabel: 'New chat',
                  onAction: controller.newConversation,
                )
              : Center(
                  child: ConstrainedBox(
                    constraints: const BoxConstraints(maxWidth: 760),
                    child: Padding(
                      padding: EdgeInsets.all(
                        compact ? SentIQSpacing.md : SentIQSpacing.xl,
                      ),
                      child: Column(
                        children: <Widget>[
                          const Spacer(),
                          Icon(
                            Icons.chat_bubble_outline_rounded,
                            size: 44,
                            color: palette.accent,
                          ),
                          const SizedBox(height: SentIQSpacing.md),
                          Text(
                            state.selected!.title,
                            textAlign: TextAlign.center,
                            style: Theme.of(context).textTheme.headlineMedium,
                          ),
                          const SizedBox(height: SentIQSpacing.xs),
                          Text(
                            'This conversation is ready for your messages.',
                            textAlign: TextAlign.center,
                            style: Theme.of(context).textTheme.bodyLarge?.copyWith(
                                  color: palette.textSecondary,
                                ),
                          ),
                          const Spacer(),
                          RefractiveGlassSurface(
                            padding: const EdgeInsets.symmetric(
                              horizontal: SentIQSpacing.md,
                              vertical: SentIQSpacing.sm,
                            ),
                            child: Row(
                              children: <Widget>[
                                Expanded(
                                  child: Text(
                                    'Message SentIQ Chat',
                                    style: TextStyle(color: palette.textMuted),
                                  ),
                                ),
                                Icon(
                                  Icons.lock_clock_outlined,
                                  color: palette.textMuted,
                                ),
                              ],
                            ),
                          ),
                        ],
                      ),
                    ),
                  ),
                ),
        ),
      ],
    );
  }
}
