import 'dart:async';
import 'dart:typed_data';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:sentiq_chat/core/design_system/sentiq_tokens.dart';
import 'package:sentiq_chat/features/chat/domain/chat_models.dart';
import 'package:sentiq_chat/features/multimodal/data/content_policy.dart';
import 'package:sentiq_chat/features/multimodal/domain/multimodal_models.dart';
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
    this.imageGenerationMode = false,
    this.imageQuota = const ImageQuotaState(),
    required this.onExecutionModeChanged,
    required this.onWebSearchChanged,
    required this.onAttachmentAdded,
    this.onImageGenerationModeChanged,
    this.onDeepResearch,
    this.onLive,
    this.onAttachmentCancel,
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
  final bool imageGenerationMode;
  final ImageQuotaState imageQuota;
  final ValueChanged<ChatExecutionMode> onExecutionModeChanged;
  final ValueChanged<bool> onWebSearchChanged;
  final ValueChanged<ChatAttachment> onAttachmentAdded;
  final ValueChanged<bool>? onImageGenerationModeChanged;
  final VoidCallback? onDeepResearch;
  final VoidCallback? onLive;
  final ValueChanged<String>? onAttachmentCancel;
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
  final ImagePicker _imagePicker = ImagePicker();
  bool _sending = false;

  bool get _canSend =>
      widget.enabled &&
      !_sending &&
      !widget.generating &&
      _controller.text.trim().isNotEmpty &&
      (widget.imageGenerationMode ||
          widget.attachments.every(
            (ChatAttachment item) => !item.uploading && !item.failed,
          )) &&
      (widget.imageGenerationMode ||
          widget.quota.allows(widget.executionMode)) &&
      (!widget.imageGenerationMode || widget.imageQuota.available);

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

  Future<void> _pickFiles() async {
    Navigator.of(context).pop();
    final FilePickerResult? result = await FilePicker.platform.pickFiles(
      allowMultiple: true,
      type: FileType.custom,
      allowedExtensions: const <String>[
        'pdf',
        'txt',
        'md',
        'csv',
        'json',
        'html',
        'htm',
        'xml',
        'yaml',
        'yml',
        'dart',
        'js',
        'ts',
        'py',
        'java',
        'kt',
        'c',
        'cpp',
        'h',
        'css',
        'sql',
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
      _addPickedAttachment(
        name: file.name,
        extension: file.extension,
        size: file.size,
        bytes: bytes,
      );
    }
  }

  Future<void> _pickImage({required ImageSource source}) async {
    Navigator.of(context).pop();
    if (source == ImageSource.gallery) {
      final List<XFile> images = await _imagePicker.pickMultiImage(
        imageQuality: 94,
      );
      for (final XFile image in images) {
        await _addXFile(image);
      }
      return;
    }
    final XFile? image = await _imagePicker.pickImage(
      source: source,
      imageQuality: 94,
    );
    if (image != null) await _addXFile(image);
  }

  Future<void> _addXFile(XFile file) async {
    final Uint8List bytes = await file.readAsBytes();
    _addPickedAttachment(
      name: file.name,
      extension: file.name.contains('.') ? file.name.split('.').last : 'jpg',
      size: bytes.length,
      bytes: bytes,
    );
  }

  void _addPickedAttachment({
    required String name,
    required String? extension,
    required int size,
    required Uint8List bytes,
  }) {
    final String mimeType = _mimeType(extension);
    final String? validation = AttachmentPolicy.validate(
      filename: name,
      mimeType: mimeType,
      sizeBytes: size,
    );
    if (validation != null) {
      ScaffoldMessenger.of(
        context,
      ).showSnackBar(SnackBar(content: Text('$name: $validation')));
      return;
    }
    widget.onAttachmentAdded(
      ChatAttachment(
        id: _uuid.v4(),
        name: name,
        mimeType: mimeType,
        sizeBytes: size,
        bytes: bytes,
      ),
    );
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
                subtitle: const Text('PDF, text, code and supported images'),
                onTap: () => unawaited(_pickFiles()),
              ),
              ListTile(
                leading: const Icon(Icons.photo_library_outlined),
                title: const Text('Choose images'),
                subtitle: const Text('Select one or more from your gallery'),
                onTap: () => unawaited(_pickImage(source: ImageSource.gallery)),
              ),
              ListTile(
                leading: const Icon(Icons.photo_camera_outlined),
                title: const Text('Take a photo'),
                subtitle: const Text('Use your Android camera'),
                onTap: () => unawaited(_pickImage(source: ImageSource.camera)),
              ),
              if (widget.onDeepResearch != null)
                ListTile(
                  leading: const Icon(Icons.manage_search_rounded),
                  title: const Text('Deep Research'),
                  subtitle: const Text('Build a sourced, detailed report'),
                  onTap: () {
                    Navigator.of(sheetContext).pop();
                    widget.onDeepResearch!();
                  },
                ),
              if (widget.onLive != null)
                ListTile(
                  leading: const Icon(Icons.graphic_eq_rounded),
                  title: const Text('SentIQ Live'),
                  subtitle: const Text('Have a real-time voice conversation'),
                  onTap: () {
                    Navigator.of(sheetContext).pop();
                    widget.onLive!();
                  },
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
                    onCancel: widget.onAttachmentCancel == null
                        ? null
                        : () => widget.onAttachmentCancel!(attachment.id),
                  );
                },
              ),
            ),
          Row(
            crossAxisAlignment: CrossAxisAlignment.end,
            children: <Widget>[
              IconButton(
                tooltip: 'Tools and attachments',
                onPressed:
                    widget.enabled &&
                        !widget.generating &&
                        !widget.imageGenerationMode
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
                  decoration: InputDecoration(
                    hintText: widget.imageGenerationMode
                        ? 'Describe the image you want'
                        : 'Message SentIQ Chat',
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
                _ImageModeToggle(
                  enabled: widget.imageGenerationMode,
                  available: widget.imageQuota.available,
                  onChanged: widget.onImageGenerationModeChanged,
                ),
                const SizedBox(width: 4),
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
                if (widget.imageGenerationMode &&
                    widget.imageQuota.remaining != null)
                  Padding(
                    padding: const EdgeInsets.only(right: SentIQSpacing.xs),
                    child: Text(
                      '${widget.imageQuota.remaining} images left',
                      style: Theme.of(context).textTheme.labelSmall?.copyWith(
                        color: palette.textMuted,
                      ),
                    ),
                  ),
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

class _ImageModeToggle extends StatelessWidget {
  const _ImageModeToggle({
    required this.enabled,
    required this.available,
    required this.onChanged,
  });

  final bool enabled;
  final bool available;
  final ValueChanged<bool>? onChanged;

  @override
  Widget build(BuildContext context) {
    return Tooltip(
      message: available ? 'Create images' : 'Image allowance unavailable',
      child: FilterChip(
        avatar: const Icon(Icons.image_outlined, size: 16),
        label: const Text('Image'),
        selected: enabled,
        onSelected: available && onChanged != null ? onChanged : null,
        visualDensity: VisualDensity.compact,
      ),
    );
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
    this.onCancel,
  });

  final ChatAttachment attachment;
  final VoidCallback onRemove;
  final VoidCallback onRetry;
  final VoidCallback? onCancel;

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
                  attachment.statusMessage ??
                      (attachment.failed
                          ? 'Upload failed'
                          : attachment.uploading
                          ? 'Preparing…'
                          : _fileSize(attachment.sizeBytes)),
                  maxLines: 1,
                  style: Theme.of(context).textTheme.labelSmall,
                ),
                if (attachment.uploading)
                  Padding(
                    padding: const EdgeInsets.only(top: 4),
                    child: LinearProgressIndicator(
                      value: attachment.progress > 0
                          ? attachment.progress
                          : null,
                      minHeight: 2,
                    ),
                  ),
              ],
            ),
          ),
          IconButton(
            visualDensity: VisualDensity.compact,
            tooltip: attachment.uploading
                ? 'Cancel upload'
                : attachment.failed
                ? 'Retry attachment'
                : 'Remove attachment',
            onPressed: attachment.uploading
                ? onCancel
                : attachment.failed
                ? onRetry
                : onRemove,
            icon: Icon(
              attachment.uploading
                  ? Icons.stop_circle_outlined
                  : attachment.failed
                  ? Icons.refresh_rounded
                  : Icons.close_rounded,
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
