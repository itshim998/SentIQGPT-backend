import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:sentiq_chat/app/app_providers.dart';
import 'package:sentiq_chat/core/design_system/sentiq_tokens.dart';
import 'package:sentiq_chat/core/layout/adaptive_window.dart';
import 'package:sentiq_chat/features/auth/domain/auth_models.dart';
import 'package:sentiq_chat/features/account/presentation/account_screen.dart';
import 'package:sentiq_chat/features/chat/application/chat_controller.dart';
import 'package:sentiq_chat/features/chat/domain/chat_models.dart';
import 'package:sentiq_chat/features/chat/presentation/chat_composer.dart';
import 'package:sentiq_chat/features/chat/presentation/chat_message_list.dart';
import 'package:sentiq_chat/features/chat/presentation/compact_chat_composer.dart';
import 'package:sentiq_chat/features/multimodal/domain/multimodal_models.dart';
import 'package:sentiq_chat/features/live/presentation/live_screen.dart';
import 'package:sentiq_chat/features/research/presentation/deep_research_screen.dart';
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
    final ChatController chatController = ref.read(
      chatControllerProvider(session).notifier,
    );
    final SentIQPalette palette = context.sentiqPalette;
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
        final bool compactShell =
            windowClass != AdaptiveWindowClass.expanded;
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
          session: session,
          identity: widget.identity,
          workspace: workspace,
          workspaceController: workspaceController,
          compact: compactShell,
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
                    toolbarHeight: 72,
                    backgroundColor: palette.canvas,
                    foregroundColor: palette.textPrimary,
                    surfaceTintColor: Colors.transparent,
                    shadowColor: Colors.transparent,
                    elevation: 0,
                    scrolledUnderElevation: 0,
                    titleSpacing: 8,
                    title: _WorkspaceExecutionModeTitle(session: session),
                    centerTitle: false,
                    leading: IconButton(
                      tooltip: 'Open conversations',
                      icon: const Icon(Icons.menu_rounded),
                      onPressed: () => _scaffoldKey.currentState?.openDrawer(),
                    ),
                    actions: <Widget>[
                      _WorkspaceHeaderActivity(
                        session: session,
                        conversationId: selectedId,
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

  Future<void> _showAccount(BuildContext context) async {
    await Navigator.of(context).push<void>(
      MaterialPageRoute<void>(
        builder: (_) =>
            AccountScreen(identity: widget.identity, session: _session),
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
                label: 'Account, privacy and data',
                style: SentIQButtonStyle.secondary,
                expand: true,
                onPressed: () {
                  Navigator.of(sheetContext).pop();
                  unawaited(_showAccount(context));
                },
              ),
              const SizedBox(height: SentIQSpacing.sm),
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

class _WorkspaceExecutionModeTitle extends ConsumerWidget {
  const _WorkspaceExecutionModeTitle({required this.session});

  final WorkspaceSession session;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final ({ChatExecutionMode mode, ChatQuotaState quota}) view = ref.watch(
      chatControllerProvider(session).select(
        (ChatState state) => (
          mode: state.executionMode,
          quota: state.quota,
        ),
      ),
    );
    final ChatController controller = ref.read(
      chatControllerProvider(session).notifier,
    );
    return ChatExecutionModeButton(
      mode: view.mode,
      quota: view.quota,
      onChanged: controller.setExecutionMode,
    );
  }
}

class _WorkspaceHeaderActivity extends ConsumerWidget {
  const _WorkspaceHeaderActivity({
    required this.session,
    required this.conversationId,
  });

  final WorkspaceSession session;
  final String? conversationId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final String? id = conversationId;
    final bool generating = ref.watch(
      chatControllerProvider(session).select(
        (ChatState state) => id != null && state.thread(id).generating,
      ),
    );
    if (!generating) return const SizedBox.shrink();
    return const Padding(
      padding: EdgeInsets.symmetric(horizontal: 4),
      child: _HeaderActivityIndicator(),
    );
  }
}

class _WorkspaceCanvas extends StatelessWidget {
  const _WorkspaceCanvas({
    required this.session,
    required this.identity,
    required this.workspace,
    required this.workspaceController,
    required this.compact,
  });

  final WorkspaceSession session;
  final AppIdentity identity;
  final WorkspaceState workspace;
  final WorkspaceController workspaceController;
  final bool compact;

  @override
  Widget build(BuildContext context) {
    final SentIQPalette palette = context.sentiqPalette;
    final String? conversationId = workspace.selectedConversationId;
    return Column(
      children: <Widget>[
        _WorkspaceNetworkBanner(
          session: session,
          workspace: workspace,
          workspaceController: workspaceController,
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
              : _ConversationBody(
                  session: session,
                  identity: identity,
                  conversationId: conversationId,
                ),
        ),
        if (conversationId != null)
          _ComposerHost(
            session: session,
            identity: identity,
            conversationId: conversationId,
            workspaceController: workspaceController,
            compact: compact,
          ),
      ],
    );
  }
}

class _WorkspaceNetworkBanner extends ConsumerWidget {
  const _WorkspaceNetworkBanner({
    required this.session,
    required this.workspace,
    required this.workspaceController,
  });

  final WorkspaceSession session;
  final WorkspaceState workspace;
  final WorkspaceController workspaceController;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final bool networkAvailable = ref.watch(
      chatControllerProvider(session).select(
        (ChatState state) => state.networkAvailable,
      ),
    );
    if (workspace.networkState == WorkspaceNetworkState.online &&
        networkAvailable) {
      return const SizedBox.shrink();
    }
    final SentIQPalette palette = context.sentiqPalette;
    final bool offline =
        !networkAvailable ||
        workspace.networkState == WorkspaceNetworkState.offline;
    return Material(
      color: (offline ? palette.warning : palette.info).withValues(alpha: 0.14),
      child: Padding(
        padding: const EdgeInsets.symmetric(
          horizontal: SentIQSpacing.md,
          vertical: SentIQSpacing.xs,
        ),
        child: Row(
          children: <Widget>[
            Icon(
              !networkAvailable
                  ? Icons.cloud_off_outlined
                  : Icons.sync_problem_outlined,
              size: 18,
            ),
            const SizedBox(width: SentIQSpacing.xs),
            Expanded(
              child: Text(
                !networkAvailable
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
    );
  }
}

class _ConversationBody extends ConsumerWidget {
  const _ConversationBody({
    required this.session,
    required this.identity,
    required this.conversationId,
  });

  final WorkspaceSession session;
  final AppIdentity identity;
  final String conversationId;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final ChatThreadState thread = ref.watch(
      chatControllerProvider(session).select(
        (ChatState state) => state.thread(conversationId),
      ),
    );
    final ChatController chatController = ref.read(
      chatControllerProvider(session).notifier,
    );
    return Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 900),
        child: thread.messages.isEmpty && !thread.loading
            ? const _CompactHomePrompt()
            : ChatMessageList(
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
                onImageAction: chatController.performImageAction,
                onArtifactAction: chatController.performArtifactAction,
                onDeleteImage:
                    (ChatMessage message, GeneratedImagePayload image) =>
                        chatController.deleteGeneratedImage(
                          conversationId,
                          message.id,
                          image,
                        ),
                onDeleteArtifact:
                    (ChatMessage message, GeneratedArtifactPayload artifact) =>
                        chatController.deleteGeneratedArtifact(
                          conversationId,
                          message.id,
                          artifact,
                        ),
                onSaveArtifactHtml: chatController.saveArtifactHtml,
              ),
      ),
    );
  }
}

class _ComposerHost extends ConsumerWidget {
  const _ComposerHost({
    required this.session,
    required this.identity,
    required this.conversationId,
    required this.workspaceController,
    required this.compact,
  });

  final WorkspaceSession session;
  final AppIdentity identity;
  final String conversationId;
  final WorkspaceController workspaceController;
  final bool compact;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final view = ref.watch(
      chatControllerProvider(session).select(
        (ChatState state) => (
          executionMode: state.executionMode,
          quota: state.quota,
          generating: state.thread(conversationId).generating,
          attachments: state.attachments,
          webSearchEnabled: state.webSearchEnabled,
          imageGenerationMode: state.imageGenerationMode,
          imageQuota: state.imageQuota,
          networkAvailable: state.networkAvailable,
        ),
      ),
    );
    final ChatController chatController = ref.read(
      chatControllerProvider(session).notifier,
    );
    final Future<bool> Function(String) onSend = (String text) async {
      final bool accepted = await chatController.send(
        conversationId: conversationId,
        text: text,
        trustedDisplayName: identity.displayName,
      );
      if (accepted) {
        unawaited(_refreshConversationTitle(workspaceController));
      }
      return accepted;
    };
    final ValueChanged<ChatAttachment> onAttachmentAdded =
        (ChatAttachment attachment) {
          unawaited(
            chatController.addAttachment(
              attachment,
              conversationId: conversationId,
            ),
          );
        };
    final ValueChanged<String> onAttachmentRetry = (String id) {
      unawaited(
        chatController.retryAttachment(
          id,
          conversationId: conversationId,
        ),
      );
    };
    final ValueChanged<String> onAttachmentCancel = (String id) {
      unawaited(chatController.cancelAttachmentUpload(id));
    };
    final VoidCallback? onDeepResearch = identity.isGuest
        ? null
        : () => unawaited(
            Navigator.of(context)
                .push<void>(
                  MaterialPageRoute<void>(
                    builder: (_) => DeepResearchScreen(
                      conversationId: conversationId,
                    ),
                  ),
                )
                .then((_) => workspaceController.refresh()),
          );
    final VoidCallback? onLive = identity.isGuest
        ? null
        : () => unawaited(
            Navigator.of(context)
                .push<void>(
                  MaterialPageRoute<void>(
                    builder: (_) => LiveScreen(
                      conversationId: conversationId,
                    ),
                  ),
                )
                .then((_) => workspaceController.refresh()),
          );

    return SafeArea(
      top: false,
      minimum: EdgeInsets.fromLTRB(
        compact ? SentIQSpacing.sm : SentIQSpacing.lg,
        SentIQSpacing.xs,
        compact ? SentIQSpacing.sm : SentIQSpacing.lg,
        SentIQSpacing.sm,
      ),
      child: Center(
        child: ConstrainedBox(
          constraints: BoxConstraints(maxWidth: compact ? 660 : 820),
          child: compact
              ? CompactChatComposer(
                  executionMode: view.executionMode,
                  quota: view.quota,
                  generating: view.generating,
                  attachments: view.attachments,
                  webSearchEnabled: view.webSearchEnabled,
                  imageGenerationMode: view.imageGenerationMode,
                  imageQuota: view.imageQuota,
                  enabled: view.networkAvailable,
                  onWebSearchChanged: chatController.setWebSearchEnabled,
                  onImageGenerationModeChanged:
                      chatController.setImageGenerationMode,
                  onAttachmentAdded: onAttachmentAdded,
                  onAttachmentRemoved: chatController.removeAttachment,
                  onAttachmentRetry: onAttachmentRetry,
                  onAttachmentCancel: onAttachmentCancel,
                  onDeepResearch: onDeepResearch,
                  onLive: onLive,
                  onSend: onSend,
                  onStop: () => unawaited(chatController.stop(conversationId)),
                )
              : ChatComposer(
                  executionMode: view.executionMode,
                  quota: view.quota,
                  generating: view.generating,
                  attachments: view.attachments,
                  webSearchEnabled: view.webSearchEnabled,
                  imageGenerationMode: view.imageGenerationMode,
                  imageQuota: view.imageQuota,
                  enabled: view.networkAvailable,
                  onExecutionModeChanged: chatController.setExecutionMode,
                  onWebSearchChanged: chatController.setWebSearchEnabled,
                  onImageGenerationModeChanged:
                      chatController.setImageGenerationMode,
                  onAttachmentAdded: onAttachmentAdded,
                  onAttachmentRemoved: chatController.removeAttachment,
                  onAttachmentRetry: onAttachmentRetry,
                  onAttachmentCancel: onAttachmentCancel,
                  onDeepResearch: onDeepResearch,
                  onLive: onLive,
                  onSend: onSend,
                  onStop: () => unawaited(chatController.stop(conversationId)),
                ),
        ),
      ),
    );
  }
}

class _CompactHomePrompt extends StatelessWidget {
  const _CompactHomePrompt();

  @override
  Widget build(BuildContext context) {
    final SentIQPalette palette = context.sentiqPalette;
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: SentIQSpacing.xl),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          Icon(
            Icons.chat_bubble_outline_rounded,
            size: 42,
            color: palette.accent,
          ),
          const SizedBox(height: SentIQSpacing.lg),
          Text(
            'What can I help with?',
            textAlign: TextAlign.center,
            style: Theme.of(context).textTheme.headlineSmall?.copyWith(
              fontWeight: FontWeight.w600,
              letterSpacing: -0.45,
            ),
          ),
        ],
      ),
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
