import 'dart:async';
import 'dart:typed_data';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:sentiq_chat/core/design_system/sentiq_tokens.dart';
import 'package:sentiq_chat/features/chat/domain/chat_models.dart';
import 'package:sentiq_chat/shared/widgets/refractive_glass_surface.dart';
import 'package:uuid/uuid.dart';

class ChatComposer extends StatefulWidget {
  const ChatComposer({
    required this.executionMode,
    required this.quota,
    required this.generating,
    required this.attachments,
    required this.webSearchEnabled,
    required this.enabled,
    required this.onExecutionModeChanged,
    required this.onWebSearchChanged,
    required this.onAttachmentAdded,
    required this.onAttachmentRemoved,
    required this.onAttachmentRetry,
    required this.onSend,
    required this.onStop,
    this.initialText,
    super.key,
  });

  final ChatExecutionMode executionMode;
  final ChatQuotaState quota;
  final bool generating;
  final List<ChatAttachment> attachments;
  final bool webSearchEnabled;
  final bool enabled;
  final ValueChanged<ChatExecutionMode> onExecutionModeChanged;
  final ValueChanged<bool> onWebSearchChanged;
  final ValueChanged<ChatAttachment> onAttachmentAdded;
  final ValueChanged<String> onAttachmentRemoved;
  final ValueChanged<String> onAttachmentRetry;
  final Future<bool> Function(String text) onSend;
  final VoidCallback onStop;
  final String? initialText;

  @override
  State<ChatComposer> createState() => _ChatComposerState();
}

class _ChatComposerState extends State<ChatComposer> {
  late final TextEditingController _controller = TextEditingController(
    text: widget.initialText,
  );
  final FocusNode _focusNode = FocusNode();
  static const Uuid _uuid = Uuid();
  bool _sending = false;

  bool get _canSend =>
      widget.enabled &&
      !_sending &&
      !widget.generating &&
      _controller.text.trim().isNotEmpty &&
      widget.attachments.every(
        (ChatAttachment item) => !item.uploading && !item.failed,
      ) &&
      widget.quota.allows(widget.executionMode);

  @override
  void initState() {
    super.initState();
    _controller.addListener(_onTextChanged);
  }

  @override
  void didUpdateWidget(covariant ChatComposer oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.initialText != null &&
        widget.initialText != oldWidget.initialText &&
        widget.initialText != _controller.text) {
      _controller.text = widget.initialText!;
      _controller.selection = TextSelection.collapsed(
        offset: _controller.text.length,
      );
    }
  }

  void _onTextChanged() {
    if (mounted) setState(() {});
  }

  Future<void> _send() async {
    if (!_canSend) return;
    setState(() => _sending = true);
    final String text = _controller.text;
    final bool accepted = await widget.onSend(text);
    if (!mounted) return;
    if (accepted) _controller.clear();
    setState(() => _sending = false);
    if (!accepted) _focusNode.requestFocus();
  }

  Future<void> _pickFiles({required bool imagesOnly}) async {
    Navigator.of(context).pop();
    final FilePickerResult? result = await FilePicker.platform.pickFiles(
      allowMultiple: !imagesOnly,
      type: imagesOnly ? FileType.image : FileType.custom,
      allowedExtensions: imagesOnly
          ? null
          : const <String>[
              'pdf',
              'txt',
              'md',
              'csv',
              'json',
              'doc',
              'docx',
              'ppt',
              'pptx',
              'xls',
              'xlsx',
              'png',
              'jpg',
              'jpeg',
              'webp',
            ],
      withData: true,
    );
    if (result == null) return;
    for (final PlatformFile file in result.files) {
      final Uint8List? bytes = file.bytes;
      if (bytes == null || bytes.isEmpty) continue;
      widget.onAttachmentAdded(
        ChatAttachment(
          id: _uuid.v4(),
          name: file.name,
          mimeType: _mimeType(file.extension),
          sizeBytes: file.size,
          bytes: bytes,
        ),
      );
    }
  }

  Future<void> _showTools() {
    final SentIQPalette palette = context.sentiqPalette;
    return showModalBottomSheet<void>(
      context: context,
      showDragHandle: true,
      builder: (BuildContext sheetContext) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(
            SentIQSpacing.md,
            0,
            SentIQSpacing.md,
            SentIQSpacing.lg,
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              ListTile(
                leading: const Icon(Icons.attach_file_rounded),
                title: const Text('Attach files'),
                subtitle: const Text('PDF, documents, spreadsheets and text'),
                onTap: () => unawaited(_pickFiles(imagesOnly: false)),
              ),
              ListTile(
                leading: const Icon(Icons.image_outlined),
                title: const Text('Attach an image'),
                subtitle: const Text('PNG, JPEG or WebP'),
                onTap: () => unawaited(_pickFiles(imagesOnly: true)),
              ),
              SwitchListTile.adaptive(
                secondary: Icon(
                  Icons.public_rounded,
                  color: widget.webSearchEnabled ? palette.accent : null,
                ),
                title: const Text('Search the web'),
                subtitle: const Text('Use current sources for this message'),
                value: widget.webSearchEnabled,
                onChanged: (bool enabled) {
                  widget.onWebSearchChanged(enabled);
                  Navigator.of(sheetContext).pop();
                },
              ),
            ],
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final SentIQPalette palette = context.sentiqPalette;
    return RefractiveGlassSurface(
      padding: const EdgeInsets.all(SentIQSpacing.xs),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: <Widget>[
          if (widget.attachments.isNotEmpty)
            SizedBox(
              height: 68,
              child: ListView.separated(
                scrollDirection: Axis.horizontal,
                padding: const EdgeInsets.fromLTRB(
                  SentIQSpacing.xs,
                  SentIQSpacing.xs,
                  SentIQSpacing.xs,
                  0,
                ),
                itemCount: widget.attachments.length,
                separatorBuilder: (_, _) =>
                    const SizedBox(width: SentIQSpacing.xs),
                itemBuilder: (BuildContext context, int index) {
                  final ChatAttachment attachment = widget.attachments[index];
                  return _AttachmentPreview(
                    attachment: attachment,
                    onRemove: () => widget.onAttachmentRemoved(attachment.id),
                    onRetry: () => widget.onAttachmentRetry(attachment.id),
                  );
                },
              ),
            ),
          Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: <Widget>[
              IconButton(
                tooltip: 'Tools and attachments',
                onPressed: widget.enabled && !widget.generating
                    ? () => unawaited(_showTools())
                    : null,
                icon: Badge(
                  isLabelVisible:
                      widget.webSearchEnabled || widget.attachments.isNotEmpty,
                  smallSize: 7,
                  child: const Icon(Icons.add_rounded),
                ),
              ),
              Expanded(
                child: TextField(
                  controller: _controller,
                  focusNode: _focusNode,
                  enabled: widget.enabled,
                  minLines: 1,
                  maxLines: 8,
                  keyboardType: TextInputType.multiline,
                  textCapitalization: TextCapitalization.sentences,
                  textInputAction: TextInputAction.newline,
                  decoration: const InputDecoration(
                    hintText: 'Message SentIQ Chat',
                    border: InputBorder.none,
                    filled: false,
                    contentPadding: EdgeInsets.symmetric(
                      horizontal: SentIQSpacing.xs,
                      vertical: 13,
                    ),
                  ),
                  onSubmitted: (_) {},
                ),
              ),
              if (widget.generating)
                IconButton.filled(
                  tooltip: 'Stop generating',
                  onPressed: widget.onStop,
                  icon: const Icon(Icons.stop_rounded),
                )
              else
                IconButton.filled(
                  tooltip: 'Send message',
                  onPressed: _canSend ? () => unawaited(_send()) : null,
                  icon: _sending
                      ? const SizedBox.square(
                          dimension: 18,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        )
                      : const Icon(Icons.arrow_upward_rounded),
                ),
            ],
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(
              SentIQSpacing.xs,
              0,
              SentIQSpacing.xs,
              SentIQSpacing.xs,
            ),
            child: Row(
              children: <Widget>[
                _ModeSelector(
                  mode: widget.executionMode,
                  quota: widget.quota,
                  onChanged: widget.onExecutionModeChanged,
                ),
                if (widget.webSearchEnabled) ...<Widget>[
                  const SizedBox(width: SentIQSpacing.xs),
                  Icon(Icons.public_rounded, size: 15, color: palette.accent),
                  const SizedBox(width: 4),
                  Text(
                    'Web search',
                    style: Theme.of(context).textTheme.labelSmall?.copyWith(
                      color: palette.textSecondary,
                    ),
                  ),
                ],
                const Spacer(),
                Text(
                  '${_controller.text.characters.length}/10000',
                  style: Theme.of(
                    context,
                  ).textTheme.labelSmall?.copyWith(color: palette.textMuted),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  @override
  void dispose() {
    _controller
      ..removeListener(_onTextChanged)
      ..dispose();
    _focusNode.dispose();
    super.dispose();
  }
}

class _ModeSelector extends StatelessWidget {
  const _ModeSelector({
    required this.mode,
    required this.quota,
    required this.onChanged,
  });

  final ChatExecutionMode mode;
  final ChatQuotaState quota;
  final ValueChanged<ChatExecutionMode> onChanged;

  @override
  Widget build(BuildContext context) {
    return PopupMenuButton<ChatExecutionMode>(
      tooltip: 'Choose response mode',
      initialValue: mode,
      onSelected: onChanged,
      itemBuilder: (BuildContext context) =>
          <PopupMenuEntry<ChatExecutionMode>>[
            PopupMenuItem<ChatExecutionMode>(
              value: ChatExecutionMode.fast,
              enabled: quota.fastAvailable,
              child: const ListTile(
                contentPadding: EdgeInsets.zero,
                leading: Icon(Icons.bolt_rounded),
                title: Text('Fast'),
                subtitle: Text('Quick, direct responses'),
              ),
            ),
            PopupMenuItem<ChatExecutionMode>(
              value: ChatExecutionMode.intuitive,
              enabled: quota.intuitiveAvailable,
              child: const ListTile(
                contentPadding: EdgeInsets.zero,
                leading: Icon(Icons.auto_awesome_rounded),
                title: Text('Intuitive'),
                subtitle: Text('Deeper reasoning for complex work'),
              ),
            ),
          ],
      child: Semantics(
        button: true,
        label: '${mode.name} response mode',
        child: Padding(
          padding: const EdgeInsets.symmetric(
            horizontal: SentIQSpacing.xs,
            vertical: 6,
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              Icon(
                mode == ChatExecutionMode.fast
                    ? Icons.bolt_rounded
                    : Icons.auto_awesome_rounded,
                size: 16,
              ),
              const SizedBox(width: 4),
              Text(mode == ChatExecutionMode.fast ? 'Fast' : 'Intuitive'),
              const Icon(Icons.keyboard_arrow_down_rounded, size: 17),
            ],
          ),
        ),
      ),
    );
  }
}

class _AttachmentPreview extends StatelessWidget {
  const _AttachmentPreview({
    required this.attachment,
    required this.onRemove,
    required this.onRetry,
  });

  final ChatAttachment attachment;
  final VoidCallback onRemove;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: 172,
      padding: const EdgeInsets.all(SentIQSpacing.xs),
      decoration: BoxDecoration(
        color: Theme.of(context).colorScheme.surfaceContainerHigh,
        borderRadius: BorderRadius.circular(14),
      ),
      child: Row(
        children: <Widget>[
          CircleAvatar(
            radius: 18,
            child: attachment.uploading
                ? const SizedBox.square(
                    dimension: 16,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : Icon(
                    attachment.isImage
                        ? Icons.image_outlined
                        : Icons.description_outlined,
                    size: 18,
                  ),
          ),
          const SizedBox(width: SentIQSpacing.xs),
          Expanded(
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(
                  attachment.name,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: Theme.of(context).textTheme.labelMedium,
                ),
                Text(
                  attachment.failed
                      ? 'Upload failed'
                      : attachment.uploading
                      ? 'Preparing…'
                      : _fileSize(attachment.sizeBytes),
                  maxLines: 1,
                  style: Theme.of(context).textTheme.labelSmall,
                ),
              ],
            ),
          ),
          IconButton(
            visualDensity: VisualDensity.compact,
            tooltip: attachment.failed
                ? 'Retry attachment'
                : 'Remove attachment',
            onPressed: attachment.failed ? onRetry : onRemove,
            icon: Icon(
              attachment.failed ? Icons.refresh_rounded : Icons.close_rounded,
              size: 18,
            ),
          ),
        ],
      ),
    );
  }
}

String _mimeType(String? extension) {
  return switch (extension?.toLowerCase()) {
    'png' => 'image/png',
    'jpg' || 'jpeg' => 'image/jpeg',
    'webp' => 'image/webp',
    'pdf' => 'application/pdf',
    'csv' => 'text/csv',
    'json' => 'application/json',
    'md' => 'text/markdown',
    'txt' => 'text/plain',
    'doc' => 'application/msword',
    'docx' =>
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'ppt' => 'application/vnd.ms-powerpoint',
    'pptx' =>
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'xls' => 'application/vnd.ms-excel',
    'xlsx' =>
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    _ => 'application/octet-stream',
  };
}

String _fileSize(int bytes) {
  if (bytes < 1024) return '$bytes B';
  if (bytes < 1024 * 1024) return '${(bytes / 1024).toStringAsFixed(1)} KB';
  return '${(bytes / (1024 * 1024)).toStringAsFixed(1)} MB';
}
