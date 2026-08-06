import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:sentiq_chat/app/app_providers.dart';
import 'package:sentiq_chat/core/design_system/sentiq_tokens.dart';
import 'package:sentiq_chat/core/layout/adaptive_window.dart';
import 'package:sentiq_chat/features/auth/domain/auth_models.dart';
import 'package:sentiq_chat/features/chat/application/chat_controller.dart';
import 'package:sentiq_chat/features/chat/domain/chat_models.dart';
import 'package:sentiq_chat/features/chat/presentation/chat_composer.dart';
import 'package:sentiq_chat/features/chat/presentation/chat_message_list.dart';
import 'package:sentiq_chat/features/workspace/application/workspace_controller.dart';
import 'package:sentiq_chat/features/workspace/domain/conversation_summary.dart';
import 'package:sentiq_chat/features/workspace/presentation/conversation_sidebar.dart';
import 'package:sentiq_chat/shared/widgets/sentiq_button.dart';
import 'package:sentiq_chat/shared/widgets/sentiq_dialog.dart';
import 'package:sentiq_chat/shared/widgets/sentiq_empty_state.dart';
import 'package:sentiq_chat/shared/widgets/sentiq_sheet.dart';
import 'package:sentiq_chat/shared/widgets/sentiq_text_field.dart';

class WorkspaceScreen extends ConsumerStatefulWidget {
  const WorkspaceScreen({required this.identity, super.key});

  final AppIdentity identity;

  @override
  ConsumerState<WorkspaceScreen> createState() => _WorkspaceScreenState();
}

class _WorkspaceScreenState extends ConsumerState<WorkspaceScreen>
    with WidgetsBindingObserver {
  final GlobalKey<ScaffoldState> _scaffoldKey = GlobalKey<ScaffoldState>();

  WorkspaceSession get _session => WorkspaceSession(
    ownerScope: widget.identity.isGuest ? 'guest' : widget.identity.id,
    cloudEnabled: !widget.identity.isGuest,
  );

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    unawaited(
      ref
          .read(chatControllerProvider(_session).notifier)
          .handleLifecycle(state),
    );
  }

  @override
  Widget build(BuildContext context) {
    final WorkspaceSession session = _session;
    final WorkspaceState workspace = ref.watch(
      workspaceControllerProvider(session),
    );
    final WorkspaceController workspaceController = ref.read(
      workspaceControllerProvider(session).notifier,
    );
    final ChatState chat = ref.watch(chatControllerProvider(session));
    final ChatController chatController = ref.read(
      chatControllerProvider(session).notifier,
    );
    final String? selectedId = workspace.selectedConversationId;
    if (selectedId != null) {
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) unawaited(chatController.loadConversation(selectedId));
      });
    }

    return LayoutBuilder(
      builder: (BuildContext context, BoxConstraints constraints) {
        final AdaptiveWindowClass windowClass = classifyWindow(
          constraints.maxWidth,
        );
        final Widget sidebar = ConversationSidebar(
          identity: widget.identity,
          state: workspace,
          controller: workspaceController,
          onRename: (ConversationSummary item) =>
              _showRename(context, workspaceController, item),
          onDelete: (ConversationSummary item) =>
              _showDelete(context, workspaceController, item),
          onAccount: () => _showAccount(context),
          onSettings: () => _showSettings(context),
          onConversationSelected: windowClass == AdaptiveWindowClass.expanded
              ? null
              : () => Navigator.of(context).maybePop(),
        );
        final Widget canvas = _WorkspaceCanvas(
          identity: widget.identity,
          workspace: workspace,
          workspaceController: workspaceController,
          chat: chat,
          chatController: chatController,
          compact: windowClass == AdaptiveWindowClass.compact,
        );
        return PopScope(
          canPop:
              windowClass == AdaptiveWindowClass.expanded ||
              workspace.selectedConversationId == null,
          onPopInvokedWithResult: (bool didPop, Object? result) {
            if (!didPop && workspace.selectedConversationId != null) {
              workspaceController.clearSelection();
            }
          },
          child: Scaffold(
            key: _scaffoldKey,
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
                    title: Text(workspace.selected?.title ?? 'SentIQ Chat'),
                    centerTitle: false,
                    leading: IconButton(
                      tooltip: 'Open conversations',
                      icon: const Icon(Icons.menu_rounded),
                      onPressed: () => _scaffoldKey.currentState?.openDrawer(),
                    ),
                    actions: <Widget>[
                      if (selectedId != null &&
                          chat.thread(selectedId).generating)
                        const Padding(
                          padding: EdgeInsets.symmetric(horizontal: 4),
                          child: _HeaderActivityIndicator(),
                        ),
                      IconButton(
                        tooltip: 'New chat',
                        icon: const Icon(Icons.add_rounded),
                        onPressed: workspaceController.newConversation,
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
    final TextEditingController title = TextEditingController(
      text: conversation.title,
    );
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

  Future<void> _showAccount(BuildContext context) {
    return showSentIQSheet<void>(
      context: context,
      builder: (BuildContext sheetContext) => Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          Text(
            widget.identity.isGuest
                ? 'Guest session'
                : widget.identity.displayName ?? 'Account',
            style: Theme.of(context).textTheme.titleLarge,
          ),
          const SizedBox(height: SentIQSpacing.xs),
          Text(
            widget.identity.isGuest
                ? 'This session stays on this device. Sign in to keep conversations across sessions.'
                : widget.identity.email ?? 'Signed in to SentIQ Chat',
          ),
          const SizedBox(height: SentIQSpacing.lg),
          SentIQButton(
            label: widget.identity.isGuest
                ? 'Sign in or create account'
                : 'Sign out',
            style: widget.identity.isGuest
                ? SentIQButtonStyle.primary
                : SentIQButtonStyle.secondary,
            expand: true,
            onPressed: () {
              Navigator.of(sheetContext).pop();
              if (widget.identity.isGuest) {
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

  Future<void> _showSettings(BuildContext context) {
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

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }
}

class _WorkspaceCanvas extends StatelessWidget {
  const _WorkspaceCanvas({
    required this.identity,
    required this.workspace,
    required this.workspaceController,
    required this.chat,
    required this.chatController,
    required this.compact,
  });

  final AppIdentity identity;
  final WorkspaceState workspace;
  final WorkspaceController workspaceController;
  final ChatState chat;
  final ChatController chatController;
  final bool compact;

  @override
  Widget build(BuildContext context) {
    final SentIQPalette palette = context.sentiqPalette;
    final String? conversationId = workspace.selectedConversationId;
    final ChatThreadState thread = conversationId == null
        ? const ChatThreadState()
        : chat.thread(conversationId);
    return Column(
      children: <Widget>[
        if (workspace.networkState != WorkspaceNetworkState.online ||
            !chat.networkAvailable)
          Material(
            color:
                (!chat.networkAvailable ||
                    workspace.networkState == WorkspaceNetworkState.offline)
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
                    !chat.networkAvailable
                        ? Icons.cloud_off_outlined
                        : Icons.sync_problem_outlined,
                    size: 18,
                  ),
                  const SizedBox(width: SentIQSpacing.xs),
                  Expanded(
                    child: Text(
                      !chat.networkAvailable
                          ? 'You are offline. Saved messages remain available and pending changes will retry after reconnecting.'
                          : 'Cloud sync is taking longer than usual. Cached conversations remain available.',
                    ),
                  ),
                  TextButton(
                    onPressed: workspaceController.refresh,
                    child: const Text('Retry'),
                  ),
                ],
              ),
            ),
          ),
        if (workspace.message != null)
          Padding(
            padding: const EdgeInsets.all(SentIQSpacing.sm),
            child: Text(
              workspace.message!,
              style: TextStyle(color: palette.textSecondary),
            ),
          ),
        Expanded(
          child: conversationId == null
              ? SentIQEmptyState(
                  icon: Icons.auto_awesome_outlined,
                  title: 'Start a new conversation',
                  message:
                      'Create a chat and it will appear here, ready for your messages.',
                  actionLabel: 'New chat',
                  onAction: workspaceController.newConversation,
                )
              : Center(
                  child: ConstrainedBox(
                    constraints: const BoxConstraints(maxWidth: 900),
                    child: ChatMessageList(
                      thread: thread,
                      onRetry: (ChatMessage message) {
                        unawaited(
                          chatController.retry(
                            conversationId: conversationId,
                            userMessage: message,
                            trustedDisplayName: identity.displayName,
                          ),
                        );
                      },
                      onContinue: (ChatMessage message) {
                        unawaited(
                          chatController.continueGenerating(
                            conversationId: conversationId,
                            partialAssistantMessage: message,
                            trustedDisplayName: identity.displayName,
                          ),
                        );
                      },
                      onAskSelected: (String selectedText) {
                        unawaited(
                          chatController.askAboutSelectedText(
                            conversationId: conversationId,
                            selectedText: selectedText,
                          ),
                        );
                      },
                    ),
                  ),
                ),
        ),
        if (conversationId != null)
          SafeArea(
            top: false,
            minimum: EdgeInsets.fromLTRB(
              compact ? SentIQSpacing.sm : SentIQSpacing.lg,
              SentIQSpacing.xs,
              compact ? SentIQSpacing.sm : SentIQSpacing.lg,
              SentIQSpacing.sm,
            ),
            child: Center(
              child: ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 820),
                child: ChatComposer(
                  executionMode: chat.executionMode,
                  quota: chat.quota,
                  generating: thread.generating,
                  attachments: chat.attachments,
                  webSearchEnabled: chat.webSearchEnabled,
                  enabled: chat.networkAvailable,
                  onExecutionModeChanged: chatController.setExecutionMode,
                  onWebSearchChanged: chatController.setWebSearchEnabled,
                  onAttachmentAdded: (ChatAttachment attachment) {
                    unawaited(chatController.addAttachment(attachment));
                  },
                  onAttachmentRemoved: chatController.removeAttachment,
                  onAttachmentRetry: (String id) {
                    unawaited(chatController.retryAttachment(id));
                  },
                  onSend: (String text) async {
                    final bool accepted = await chatController.send(
                      conversationId: conversationId,
                      text: text,
                      trustedDisplayName: identity.displayName,
                    );
                    if (accepted) {
                      unawaited(_refreshConversationTitle(workspaceController));
                    }
                    return accepted;
                  },
                  onStop: () => unawaited(chatController.stop(conversationId)),
                ),
              ),
            ),
          ),
      ],
    );
  }
}

Future<void> _refreshConversationTitle(WorkspaceController controller) async {
  await Future<void>.delayed(const Duration(seconds: 2));
  await controller.refresh();
  await Future<void>.delayed(const Duration(seconds: 6));
  await controller.refresh();
}

class _HeaderActivityIndicator extends StatefulWidget {
  const _HeaderActivityIndicator();

  @override
  State<_HeaderActivityIndicator> createState() =>
      _HeaderActivityIndicatorState();
}

class _HeaderActivityIndicatorState extends State<_HeaderActivityIndicator>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1100),
  )..repeat();

  @override
  Widget build(BuildContext context) {
    return RotationTransition(
      turns: _controller,
      child: const Icon(Icons.sync_rounded, size: 18),
    );
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }
}
