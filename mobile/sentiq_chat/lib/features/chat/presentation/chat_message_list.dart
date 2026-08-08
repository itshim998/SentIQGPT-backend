import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart' show ScrollCacheExtent, SelectedContent;
import 'package:flutter/services.dart';
import 'package:sentiq_chat/core/design_system/sentiq_tokens.dart';
import 'package:sentiq_chat/core/performance/performance_policy.dart';
import 'package:sentiq_chat/features/chat/application/chat_controller.dart';
import 'package:sentiq_chat/features/chat/domain/chat_models.dart';
import 'package:sentiq_chat/features/chat/presentation/progressive_native_rich_text.dart';
import 'package:sentiq_chat/features/multimodal/domain/multimodal_models.dart';
import 'package:sentiq_chat/features/multimodal/presentation/multimodal_message_extras.dart';

class ChatMessageList extends StatefulWidget {
  const ChatMessageList({
    required this.thread,
    required this.onRetry,
    required this.onContinue,
    required this.onAskSelected,
    this.onImageAction,
    this.onArtifactAction,
    this.onDeleteImage,
    this.onDeleteArtifact,
    this.onSaveArtifactHtml,
    super.key,
  });

  final ChatThreadState thread;
  final ValueChanged<ChatMessage> onRetry;
  final ValueChanged<ChatMessage> onContinue;
  final ValueChanged<String> onAskSelected;
  final Future<void> Function(GeneratedImagePayload, ArtifactAction)?
  onImageAction;
  final Future<void> Function(GeneratedArtifactPayload, ArtifactAction)?
  onArtifactAction;
  final Future<void> Function(ChatMessage, GeneratedImagePayload)?
  onDeleteImage;
  final Future<void> Function(ChatMessage, GeneratedArtifactPayload)?
  onDeleteArtifact;
  final Future<GeneratedArtifactPayload> Function(
    GeneratedArtifactPayload,
    String,
  )?
  onSaveArtifactHtml;

  @override
  State<ChatMessageList> createState() => _ChatMessageListState();
}

class _ChatMessageListState extends State<ChatMessageList> {
  final ScrollController _scrollController = ScrollController();
  int _lastMessageCount = 0;
  int _lastContentLength = 0;

  @override
  void initState() {
    super.initState();
    _scrollController.addListener(_handleScroll);
    _scheduleScroll(force: true);
  }

  void _handleScroll() {
    if (mounted) setState(() {});
  }

  @override
  void didUpdateWidget(covariant ChatMessageList oldWidget) {
    super.didUpdateWidget(oldWidget);
    final int contentLength = widget.thread.messages.fold<int>(
      0,
      (int sum, ChatMessage item) => sum + item.content.length,
    );
    final bool newMessage = widget.thread.messages.length > _lastMessageCount;
    final bool streamingGrowth =
        contentLength > _lastContentLength &&
        widget.thread.generating &&
        _nearBottom;
    _lastMessageCount = widget.thread.messages.length;
    _lastContentLength = contentLength;
    if (newMessage || streamingGrowth) _scheduleScroll(force: newMessage);
  }

  bool get _nearBottom {
    if (!_scrollController.hasClients) return true;
    return _scrollController.position.maxScrollExtent -
            _scrollController.position.pixels <
        180;
  }

  void _scheduleScroll({required bool force}) {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || !_scrollController.hasClients) return;
      if (!force && !_nearBottom) return;
      final double target = _scrollController.position.maxScrollExtent;
      if (SentIQPerformancePolicy.reduceMotion(context)) {
        _scrollController.jumpTo(target);
      } else {
        _scrollController.animateTo(
          target,
          duration: const Duration(milliseconds: 220),
          curve: Curves.easeOutCubic,
        );
      }
    });
  }

  @override
  Widget build(BuildContext context) {
    final List<ChatMessage> messages = widget.thread.messages;
    final List<ChatProgressEvent> visibleProgress = widget.thread.progress
        .where((ChatProgressEvent event) => event.kind != ChatProgressKind.sync)
        .toList(growable: false);
    if (messages.isEmpty) {
      return const _ChatWelcome();
    }
    return Stack(
      children: <Widget>[
        ListView.builder(
          key: const PageStorageKey<String>('chat-message-list'),
          controller: _scrollController,
          keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
          padding: const EdgeInsets.fromLTRB(
            SentIQSpacing.md,
            SentIQSpacing.lg,
            SentIQSpacing.md,
            SentIQSpacing.xl,
          ),
          scrollCacheExtent: const ScrollCacheExtent.pixels(900),
          addAutomaticKeepAlives: false,
          addRepaintBoundaries: true,
          itemCount: messages.length + (visibleProgress.isEmpty ? 0 : 1),
          itemBuilder: (BuildContext context, int index) {
            if (index == messages.length) {
              return _ProgressTimeline(events: visibleProgress);
            }
            final ChatMessage message = messages[index];
            return RepaintBoundary(
              key: ValueKey<String>(message.id),
              child: Padding(
                padding: const EdgeInsets.only(bottom: SentIQSpacing.md),
                child: ChatMessageView(
                  message: message,
                  onRetry: message.canRetry
                      ? () => widget.onRetry(message)
                      : null,
                  onContinue: message.canContinue
                      ? () => widget.onContinue(message)
                      : null,
                  onAskSelected: widget.onAskSelected,
                  onImageAction: widget.onImageAction,
                  onArtifactAction: widget.onArtifactAction,
                  onDeleteImage: widget.onDeleteImage,
                  onDeleteArtifact: widget.onDeleteArtifact,
                  onSaveArtifactHtml: widget.onSaveArtifactHtml,
                ),
              ),
            );
          },
        ),
        if (!_nearBottom)
          Positioned(
            right: SentIQSpacing.md,
            bottom: SentIQSpacing.md,
            child: FloatingActionButton.small(
              tooltip: 'Jump to latest message',
              onPressed: () => _scheduleScroll(force: true),
              child: const Icon(Icons.arrow_downward_rounded),
            ),
          ),
      ],
    );
  }

  @override
  void dispose() {
    _scrollController
      ..removeListener(_handleScroll)
      ..dispose();
    super.dispose();
  }
}

class ChatMessageView extends StatefulWidget {
  const ChatMessageView({
    required this.message,
    required this.onAskSelected,
    this.onRetry,
    this.onContinue,
    this.onImageAction,
    this.onArtifactAction,
    this.onDeleteImage,
    this.onDeleteArtifact,
    this.onSaveArtifactHtml,
    super.key,
  });

  final ChatMessage message;
  final ValueChanged<String> onAskSelected;
  final Future<void> Function(GeneratedImagePayload, ArtifactAction)?
  onImageAction;
  final Future<void> Function(GeneratedArtifactPayload, ArtifactAction)?
  onArtifactAction;
  final Future<void> Function(ChatMessage, GeneratedImagePayload)?
  onDeleteImage;
  final Future<void> Function(ChatMessage, GeneratedArtifactPayload)?
  onDeleteArtifact;
  final Future<GeneratedArtifactPayload> Function(
    GeneratedArtifactPayload,
    String,
  )?
  onSaveArtifactHtml;
  final VoidCallback? onRetry;
  final VoidCallback? onContinue;

  @override
  State<ChatMessageView> createState() => _ChatMessageViewState();
}

class _ChatMessageViewState extends State<ChatMessageView> {
  String _selectedText = '';

  bool get _isUser => widget.message.role == ChatMessageRole.user;

  Future<void> _copy() async {
    await Clipboard.setData(ClipboardData(text: widget.message.content));
    if (!mounted) return;
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(const SnackBar(content: Text('Message copied')));
  }

  Future<void> _openSelection() async {
    String selected = _selectedText;
    await showDialog<void>(
      context: context,
      builder: (BuildContext dialogContext) => AlertDialog(
        title: const Text('Select text'),
        content: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 620, maxHeight: 520),
          child: SingleChildScrollView(
            child: SelectionArea(
              onSelectionChanged: (SelectedContent? content) {
                selected = content?.plainText ?? '';
              },
              child: Text(widget.message.content),
            ),
          ),
        ),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(),
            child: const Text('Done'),
          ),
          FilledButton.tonalIcon(
            onPressed: () {
              final String value = selected.trim();
              if (value.isEmpty) return;
              Navigator.of(dialogContext).pop();
              widget.onAskSelected(value);
            },
            icon: const Icon(Icons.chat_bubble_outline_rounded),
            label: const Text('Ask about selection'),
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final SentIQPalette palette = context.sentiqPalette;
    final Widget content = _isUser
        ? SelectableText(
            widget.message.content,
            style: Theme.of(
              context,
            ).textTheme.bodyLarge?.copyWith(height: 1.45),
          )
        : ProgressiveNativeRichText(
            data: widget.message.content,
            citations: widget.message.citations,
            streaming: widget.message.status == ChatMessageStatus.streaming,
            onSelectionChanged: (String value) => _selectedText = value,
          );
    return Align(
      alignment: _isUser ? Alignment.centerRight : Alignment.centerLeft,
      child: ConstrainedBox(
        constraints: BoxConstraints(maxWidth: _isUser ? 620 : 760),
        child: Column(
          crossAxisAlignment: _isUser
              ? CrossAxisAlignment.end
              : CrossAxisAlignment.start,
          children: <Widget>[
            if (_isUser)
              Container(
                padding: const EdgeInsets.symmetric(
                  horizontal: SentIQSpacing.md,
                  vertical: SentIQSpacing.sm,
                ),
                decoration: BoxDecoration(
                  color: palette.surfaceElevated,
                  border: Border.all(color: palette.glassBorder),
                  borderRadius: BorderRadius.circular(22),
                ),
                child: content,
              )
            else
              content,
            if (!_isUser)
              MultimodalMessageExtras(
                message: widget.message,
                onImageAction:
                    widget.onImageAction ??
                    (GeneratedImagePayload _, ArtifactAction _) async {},
                onArtifactAction:
                    widget.onArtifactAction ??
                    (GeneratedArtifactPayload _, ArtifactAction _) async {},
                onDeleteImage: (GeneratedImagePayload image) async {
                  await widget.onDeleteImage?.call(widget.message, image);
                },
                onDeleteArtifact: (GeneratedArtifactPayload artifact) async {
                  await widget.onDeleteArtifact?.call(widget.message, artifact);
                },
                onSaveArtifactHtml:
                    (GeneratedArtifactPayload artifact, String html) async {
                      final callback = widget.onSaveArtifactHtml;
                      if (callback == null) return artifact;
                      return callback(artifact, html);
                    },
              ),
            if (widget.message.errorMessage != null)
              Padding(
                padding: const EdgeInsets.only(top: SentIQSpacing.xs),
                child: Text(
                  widget.message.errorMessage!,
                  style: Theme.of(
                    context,
                  ).textTheme.bodySmall?.copyWith(color: palette.danger),
                ),
              ),
            const SizedBox(height: 4),
            Wrap(
              spacing: 2,
              crossAxisAlignment: WrapCrossAlignment.center,
              children: <Widget>[
                IconButton(
                  visualDensity: VisualDensity.compact,
                  tooltip: 'Copy message',
                  onPressed: () => unawaited(_copy()),
                  icon: const Icon(Icons.copy_rounded, size: 17),
                ),
                IconButton(
                  visualDensity: VisualDensity.compact,
                  tooltip: 'Select text',
                  onPressed: () => unawaited(_openSelection()),
                  icon: const Icon(Icons.select_all_rounded, size: 17),
                ),
                if (!_isUser)
                  IconButton(
                    visualDensity: VisualDensity.compact,
                    tooltip: 'Ask about selected text',
                    onPressed: _selectedText.trim().isEmpty
                        ? null
                        : () => widget.onAskSelected(_selectedText.trim()),
                    icon: const Icon(
                      Icons.chat_bubble_outline_rounded,
                      size: 17,
                    ),
                  ),
                if (widget.onRetry != null)
                  TextButton.icon(
                    onPressed: widget.onRetry,
                    icon: const Icon(Icons.refresh_rounded, size: 17),
                    label: const Text('Retry'),
                  ),
                if (widget.onContinue != null)
                  TextButton.icon(
                    onPressed: widget.onContinue,
                    icon: const Icon(Icons.play_arrow_rounded, size: 17),
                    label: const Text('Continue'),
                  ),
                if (widget.message.executionMode != null)
                  Padding(
                    padding: const EdgeInsets.symmetric(horizontal: 6),
                    child: Text(
                      widget.message.executionMode == ChatExecutionMode.fast
                          ? 'Fast'
                          : 'Intuitive',
                      style: Theme.of(context).textTheme.labelSmall?.copyWith(
                        color: palette.textMuted,
                      ),
                    ),
                  ),
              ],
            ),
          ],
        ),
      ),
    );
  }
}

class _ProgressTimeline extends StatelessWidget {
  const _ProgressTimeline({required this.events});

  final List<ChatProgressEvent> events;

  @override
  Widget build(BuildContext context) {
    final SentIQPalette palette = context.sentiqPalette;
    return Padding(
      padding: const EdgeInsets.only(bottom: SentIQSpacing.md),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: events
            .map(
              (ChatProgressEvent event) => Padding(
                padding: const EdgeInsets.only(bottom: 6),
                child: Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Padding(
                      padding: const EdgeInsets.only(top: 3),
                      child: Icon(
                        event.error
                            ? Icons.error_outline_rounded
                            : event.terminal
                            ? Icons.check_circle_outline_rounded
                            : Icons.more_horiz_rounded,
                        size: 16,
                        color: event.error ? palette.danger : palette.textMuted,
                      ),
                    ),
                    const SizedBox(width: SentIQSpacing.xs),
                    Expanded(
                      child: Text(
                        event.label,
                        style: Theme.of(context).textTheme.bodySmall?.copyWith(
                          color: palette.textSecondary,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            )
            .toList(),
      ),
    );
  }
}

class _ChatWelcome extends StatelessWidget {
  const _ChatWelcome();

  @override
  Widget build(BuildContext context) {
    final SentIQPalette palette = context.sentiqPalette;
    return Center(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 560),
        child: Padding(
          padding: const EdgeInsets.all(SentIQSpacing.xl),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              Icon(
                Icons.chat_bubble_outline_rounded,
                size: 42,
                color: palette.accent,
              ),
              const SizedBox(height: SentIQSpacing.md),
              Text(
                'What can I help with?',
                textAlign: TextAlign.center,
                style: Theme.of(context).textTheme.headlineSmall,
              ),
            ],
          ),
        ),
      ),
    );
  }
}
