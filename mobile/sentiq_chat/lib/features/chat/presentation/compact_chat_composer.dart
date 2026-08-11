import 'dart:async';
import 'dart:typed_data';

import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';
import 'package:sentiq_chat/core/design_system/sentiq_tokens.dart';
import 'package:sentiq_chat/core/performance/performance_policy.dart';
import 'package:sentiq_chat/features/chat/domain/chat_models.dart';
import 'package:sentiq_chat/features/chat/presentation/chat_attachment_picker_support.dart';
import 'package:sentiq_chat/features/multimodal/data/content_policy.dart';
import 'package:sentiq_chat/features/multimodal/domain/multimodal_models.dart';
import 'package:sentiq_chat/shared/widgets/refractive_glass_surface.dart';
import 'package:sentiq_chat/shared/widgets/sentiq_sheet.dart';
import 'package:uuid/uuid.dart';

class ChatExecutionModeButton extends StatelessWidget {
  const ChatExecutionModeButton({
    required this.mode,
    required this.quota,
    required this.onChanged,
    super.key,
  });

  final ChatExecutionMode mode;
  final ChatQuotaState quota;
  final ValueChanged<ChatExecutionMode> onChanged;

  Future<void> _showPicker(BuildContext context) {
    return showSentIQSheet<void>(
      context: context,
      builder: (BuildContext sheetContext) => Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          Padding(
            padding: const EdgeInsets.fromLTRB(
              SentIQSpacing.xs,
              SentIQSpacing.xs,
              SentIQSpacing.xs,
              SentIQSpacing.sm,
            ),
            child: Text(
              'Response style',
              style: Theme.of(sheetContext).textTheme.titleLarge,
            ),
          ),
          _ModeOption(
            icon: Icons.bolt_rounded,
            title: 'Fast',
            subtitle: 'Quick, direct responses',
            selected: mode == ChatExecutionMode.fast,
            enabled: quota.fastAvailable,
            onTap: () {
              Navigator.of(sheetContext).pop();
              onChanged(ChatExecutionMode.fast);
            },
          ),
          const SizedBox(height: 4),
          _ModeOption(
            icon: Icons.auto_awesome_rounded,
            title: 'Intuitive',
            subtitle: 'Deeper reasoning for complex work',
            selected: mode == ChatExecutionMode.intuitive,
            enabled: quota.intuitiveAvailable,
            onTap: () {
              Navigator.of(sheetContext).pop();
              onChanged(ChatExecutionMode.intuitive);
            },
          ),
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final SentIQPalette palette = context.sentiqPalette;
    return Semantics(
      button: true,
      label: '${mode.name} response mode',
      child: Material(
        color: Colors.transparent,
        child: InkWell(
          borderRadius: BorderRadius.circular(SentIQRadii.pill),
          onTap: () => unawaited(_showPicker(context)),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 4, vertical: 8),
            child: AnimatedSwitcher(
              duration: SentIQMotion.quick,
              switchInCurve: SentIQMotion.emphasized,
              transitionBuilder: (Widget child, Animation<double> animation) {
                return FadeTransition(
                  opacity: animation,
                  child: ScaleTransition(
                    scale: Tween<double>(
                      begin: 0.96,
                      end: 1,
                    ).animate(animation),
                    child: child,
                  ),
                );
              },
              child: Row(
                key: ValueKey<ChatExecutionMode>(mode),
                mainAxisSize: MainAxisSize.min,
                children: <Widget>[
                  Text(
                    mode == ChatExecutionMode.fast ? 'Fast' : 'Intuitive',
                    style: Theme.of(context).textTheme.titleLarge?.copyWith(
                      color: palette.textPrimary,
                      fontWeight: FontWeight.w600,
                      letterSpacing: -0.35,
                    ),
                  ),
                  const SizedBox(width: 4),
                  Icon(
                    Icons.keyboard_arrow_down_rounded,
                    size: 21,
                    color: palette.textSecondary,
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class CompactChatComposer extends StatefulWidget {
  const CompactChatComposer({
    required this.executionMode,
    required this.quota,
    required this.generating,
    required this.attachments,
    required this.webSearchEnabled,
    required this.enabled,
    this.attachmentsEnabled = true,
    this.imageGenerationMode = false,
    this.imageQuota = const ImageQuotaState(),
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
  final bool attachmentsEnabled;
  final bool imageGenerationMode;
  final ImageQuotaState imageQuota;
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
  State<CompactChatComposer> createState() => _CompactChatComposerState();
}

class _CompactChatComposerState extends State<CompactChatComposer> {
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

  bool get _showContextRow =>
      widget.imageGenerationMode || widget.webSearchEnabled;

  @override
  void initState() {
    super.initState();
    _controller.addListener(_onTextChanged);
  }

  @override
  void didUpdateWidget(covariant CompactChatComposer oldWidget) {
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
    final bool accepted = await widget.onSend(_controller.text);
    if (!mounted) return;
    if (accepted) _controller.clear();
    setState(() => _sending = false);
    if (!accepted) _focusNode.requestFocus();
  }

  Future<void> _pickFiles(BuildContext sheetContext) async {
    if (!widget.attachmentsEnabled) return;
    Navigator.of(sheetContext).pop();
    final FilePickerResult? result;
    try {
      result = await FilePicker.platform.pickFiles(
        allowMultiple: true,
        type: FileType.custom,
        allowedExtensions: sentIQAllowedAttachmentExtensions,
        withData: false,
      );
    } catch (_) {
      if (!mounted) return;
      _showAttachmentNotice('Could not read that file. Please try again.');
      return;
    }
    if (result == null) return;
    final List<PickedChatAttachmentResult> picked =
        await pickedChatAttachmentsFromFiles(result.files);
    if (!mounted) return;
    for (final PickedChatAttachmentResult item in picked) {
      final ChatAttachment? attachment = item.attachment;
      if (attachment != null) {
        widget.onAttachmentAdded(attachment);
        continue;
      }
      _showAttachmentNotice('${item.name}: ${item.error}');
    }
  }

  Future<void> _pickImage(
    BuildContext sheetContext, {
    required ImageSource source,
  }) async {
    if (!widget.attachmentsEnabled) return;
    Navigator.of(sheetContext).pop();
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
    final String mimeType = chatAttachmentMimeType(extension);
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

  void _showAttachmentNotice(String message) {
    ScaffoldMessenger.of(
      context,
    ).showSnackBar(SnackBar(content: Text(message)));
  }

  Future<void> _showTools() {
    return showSentIQSheet<void>(
      context: context,
      builder: (BuildContext sheetContext) {
        return Column(
          mainAxisSize: MainAxisSize.min,
          children: <Widget>[
            if (widget.attachmentsEnabled) ...<Widget>[
              _ToolTile(
                icon: Icons.attach_file_rounded,
                title: 'Attach files',
                subtitle: 'PDF, text, code and supported images',
                onTap: () => unawaited(_pickFiles(sheetContext)),
              ),
              _ToolTile(
                icon: Icons.photo_library_outlined,
                title: 'Choose images',
                subtitle: 'Select one or more from your gallery',
                onTap: () => unawaited(
                  _pickImage(sheetContext, source: ImageSource.gallery),
                ),
              ),
              _ToolTile(
                icon: Icons.photo_camera_outlined,
                title: 'Take a photo',
                subtitle: 'Use your Android camera',
                onTap: () => unawaited(
                  _pickImage(sheetContext, source: ImageSource.camera),
                ),
              ),
            ],
            if (widget.onImageGenerationModeChanged != null)
              _ToolTile(
                icon: Icons.auto_awesome_outlined,
                title: 'Visualize',
                subtitle: widget.imageGenerationMode
                    ? 'Image creation is ready for your next prompt'
                    : widget.imageQuota.available
                    ? 'Create an image from your description'
                    : 'Image creation is unavailable right now',
                selected: widget.imageGenerationMode,
                enabled:
                    widget.imageGenerationMode || widget.imageQuota.available,
                onTap: () {
                  Navigator.of(sheetContext).pop();
                  widget.onImageGenerationModeChanged!(
                    !widget.imageGenerationMode,
                  );
                },
              ),
            if (widget.onDeepResearch != null)
              _ToolTile(
                icon: Icons.manage_search_rounded,
                title: 'Deep Research',
                subtitle: 'Build a sourced, detailed report',
                onTap: () {
                  Navigator.of(sheetContext).pop();
                  widget.onDeepResearch!();
                },
              ),
            if (widget.onLive != null)
              _ToolTile(
                icon: Icons.graphic_eq_rounded,
                title: 'SentIQ Live',
                subtitle: 'Have a real-time voice conversation',
                onTap: () {
                  Navigator.of(sheetContext).pop();
                  widget.onLive!();
                },
              ),
            _ToolTile(
              icon: Icons.public_rounded,
              title: 'Search the web',
              subtitle: 'Use current sources for this message',
              selected: widget.webSearchEnabled,
              trailing: Switch.adaptive(
                value: widget.webSearchEnabled,
                onChanged: (bool enabled) {
                  widget.onWebSearchChanged(enabled);
                  Navigator.of(sheetContext).pop();
                },
              ),
              onTap: () {
                widget.onWebSearchChanged(!widget.webSearchEnabled);
                Navigator.of(sheetContext).pop();
              },
            ),
          ],
        );
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    final bool lowCost = SentIQPerformancePolicy.useLowCostEffects(context);
    return Stack(
      clipBehavior: Clip.none,
      children: <Widget>[
        if (!lowCost) const _CompactComposerAura(),
        RefractiveGlassSurface(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
          borderRadius: 34,
          blurSigma: 14,
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: <Widget>[
              if (widget.attachments.isNotEmpty)
                SizedBox(
                  height: 58,
                  child: ListView.separated(
                    scrollDirection: Axis.horizontal,
                    padding: const EdgeInsets.fromLTRB(4, 4, 4, 2),
                    itemCount: widget.attachments.length,
                    separatorBuilder: (_, _) => const SizedBox(width: 6),
                    itemBuilder: (BuildContext context, int index) {
                      final ChatAttachment attachment =
                          widget.attachments[index];
                      return _AttachmentPreview(
                        attachment: attachment,
                        onRemove: () =>
                            widget.onAttachmentRemoved(attachment.id),
                        onRetry: () => widget.onAttachmentRetry(attachment.id),
                        onCancel: widget.onAttachmentCancel == null
                            ? null
                            : () => widget.onAttachmentCancel!(attachment.id),
                      );
                    },
                  ),
                ),
              Row(
                crossAxisAlignment: CrossAxisAlignment.center,
                children: <Widget>[
                  IconButton(
                    tooltip: 'Tools and attachments',
                    visualDensity: VisualDensity.compact,
                    onPressed: widget.enabled && !widget.generating
                        ? () => unawaited(_showTools())
                        : null,
                    icon: Badge(
                      isLabelVisible:
                          widget.webSearchEnabled ||
                          widget.imageGenerationMode ||
                          widget.attachments.isNotEmpty,
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
                      maxLines: 6,
                      keyboardType: TextInputType.multiline,
                      textCapitalization: TextCapitalization.sentences,
                      textInputAction: TextInputAction.newline,
                      decoration: InputDecoration(
                        hintText: widget.imageGenerationMode
                            ? 'Describe what you want to visualize'
                            : 'Message SentIQ Chat',
                        border: InputBorder.none,
                        filled: false,
                        isDense: true,
                        contentPadding: const EdgeInsets.symmetric(
                          horizontal: 7,
                          vertical: 10,
                        ),
                      ),
                      onSubmitted: (_) {},
                    ),
                  ),
                  const SizedBox(width: 4),
                  if (widget.generating)
                    IconButton.filled(
                      tooltip: 'Stop generating',
                      visualDensity: VisualDensity.compact,
                      onPressed: widget.onStop,
                      icon: const Icon(Icons.stop_rounded, size: 20),
                    )
                  else
                    IconButton.filled(
                      tooltip: 'Send message',
                      visualDensity: VisualDensity.compact,
                      onPressed: _canSend ? () => unawaited(_send()) : null,
                      icon: _sending
                          ? const SizedBox.square(
                              dimension: 17,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            )
                          : const Icon(Icons.arrow_upward_rounded, size: 20),
                    ),
                ],
              ),
              if (_showContextRow)
                Padding(
                  padding: const EdgeInsets.fromLTRB(12, 0, 12, 4),
                  child: Row(
                    children: <Widget>[
                      if (widget.imageGenerationMode)
                        _ContextChip(
                          icon: Icons.auto_awesome_rounded,
                          label: 'Visualize',
                        ),
                      if (widget.imageGenerationMode && widget.webSearchEnabled)
                        const SizedBox(width: 8),
                      if (widget.webSearchEnabled)
                        const _ContextChip(
                          icon: Icons.public_rounded,
                          label: 'Web',
                        ),
                    ],
                  ),
                ),
            ],
          ),
        ),
      ],
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

class _CompactComposerAura extends StatelessWidget {
  const _CompactComposerAura();

  @override
  Widget build(BuildContext context) {
    final SentIQPalette palette = context.sentiqPalette;
    return Positioned(
      left: 18,
      right: 18,
      bottom: -5,
      height: 58,
      child: IgnorePointer(
        child: RepaintBoundary(
          child: DecoratedBox(
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(34),
              boxShadow: <BoxShadow>[
                BoxShadow(
                  color: palette.accent.withValues(alpha: 0.28),
                  blurRadius: 30,
                  spreadRadius: 4,
                  offset: const Offset(0, 12),
                ),
                BoxShadow(
                  color: palette.accent.withValues(alpha: 0.12),
                  blurRadius: 18,
                  spreadRadius: 1,
                  offset: const Offset(0, 5),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _ContextChip extends StatelessWidget {
  const _ContextChip({required this.icon, required this.label});

  final IconData icon;
  final String label;

  @override
  Widget build(BuildContext context) {
    final SentIQPalette palette = context.sentiqPalette;
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: <Widget>[
        Icon(icon, size: 14, color: palette.accent),
        const SizedBox(width: 4),
        Text(
          label,
          style: Theme.of(
            context,
          ).textTheme.labelSmall?.copyWith(color: palette.textSecondary),
        ),
      ],
    );
  }
}

class _ModeOption extends StatelessWidget {
  const _ModeOption({
    required this.icon,
    required this.title,
    required this.subtitle,
    required this.selected,
    required this.enabled,
    required this.onTap,
  });

  final IconData icon;
  final String title;
  final String subtitle;
  final bool selected;
  final bool enabled;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final SentIQPalette palette = context.sentiqPalette;
    return AnimatedContainer(
      duration: SentIQMotion.standard,
      curve: SentIQMotion.emphasized,
      decoration: BoxDecoration(
        color: selected ? palette.accentSoft : Colors.transparent,
        borderRadius: BorderRadius.circular(21),
        border: Border.all(
          color: selected
              ? palette.accent.withValues(alpha: 0.34)
              : Colors.transparent,
        ),
      ),
      child: Material(
        type: MaterialType.transparency,
        child: ListTile(
          enabled: enabled,
          minVerticalPadding: SentIQSpacing.sm,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(21),
          ),
          leading: AnimatedContainer(
            duration: SentIQMotion.standard,
            width: 42,
            height: 42,
            decoration: BoxDecoration(
              color: selected
                  ? palette.accent.withValues(alpha: 0.18)
                  : palette.surface,
              borderRadius: BorderRadius.circular(14),
            ),
            child: Icon(icon, color: selected ? palette.accent : null),
          ),
          title: Text(
            title,
            style: const TextStyle(fontWeight: FontWeight.w600),
          ),
          subtitle: Text(subtitle),
          trailing: AnimatedSwitcher(
            duration: SentIQMotion.quick,
            child: selected
                ? Icon(
                    Icons.check_circle_rounded,
                    key: const ValueKey<String>('selected'),
                    color: palette.accent,
                  )
                : const SizedBox(
                    key: ValueKey<String>('unselected'),
                    width: 24,
                  ),
          ),
          onTap: enabled ? onTap : null,
        ),
      ),
    );
  }
}

class _ToolTile extends StatelessWidget {
  const _ToolTile({
    required this.icon,
    required this.title,
    required this.subtitle,
    required this.onTap,
    this.selected = false,
    this.enabled = true,
    this.trailing,
  });

  final IconData icon;
  final String title;
  final String subtitle;
  final VoidCallback onTap;
  final bool selected;
  final bool enabled;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    final SentIQPalette palette = context.sentiqPalette;
    return AnimatedContainer(
      duration: SentIQMotion.quick,
      margin: const EdgeInsets.only(bottom: 2),
      decoration: BoxDecoration(
        color: selected ? palette.accentSoft : Colors.transparent,
        borderRadius: BorderRadius.circular(20),
      ),
      child: Material(
        type: MaterialType.transparency,
        child: ListTile(
          enabled: enabled,
          minVerticalPadding: SentIQSpacing.sm,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(20),
          ),
          leading: Icon(icon, color: selected ? palette.accent : null),
          title: Text(
            title,
            style: const TextStyle(fontWeight: FontWeight.w600),
          ),
          subtitle: Text(subtitle),
          trailing:
              trailing ??
              (selected
                  ? Icon(Icons.check_rounded, color: palette.accent)
                  : null),
          onTap: enabled ? onTap : null,
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
      width: 158,
      padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 5),
      decoration: BoxDecoration(
        color: Theme.of(context).colorScheme.surfaceContainerHigh,
        borderRadius: BorderRadius.circular(14),
      ),
      child: Row(
        children: <Widget>[
          Icon(
            attachment.isImage
                ? Icons.image_outlined
                : Icons.description_outlined,
            size: 17,
          ),
          const SizedBox(width: 6),
          Expanded(
            child: Text(
              attachment.name,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: Theme.of(context).textTheme.labelSmall,
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
              size: 16,
            ),
          ),
        ],
      ),
    );
  }
}
