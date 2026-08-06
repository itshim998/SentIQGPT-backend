import 'dart:async';
import 'dart:convert';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:sentiq_chat/core/design_system/sentiq_tokens.dart';
import 'package:sentiq_chat/features/chat/domain/chat_models.dart';
import 'package:sentiq_chat/features/multimodal/data/content_policy.dart';
import 'package:sentiq_chat/features/multimodal/domain/multimodal_models.dart';
import 'package:url_launcher/url_launcher.dart';

class MultimodalMessageExtras extends StatelessWidget {
  const MultimodalMessageExtras({
    required this.message,
    required this.onImageAction,
    required this.onArtifactAction,
    required this.onDeleteImage,
    required this.onDeleteArtifact,
    required this.onSaveArtifactHtml,
    super.key,
  });

  final ChatMessage message;
  final Future<void> Function(GeneratedImagePayload, ArtifactAction)
  onImageAction;
  final Future<void> Function(GeneratedArtifactPayload, ArtifactAction)
  onArtifactAction;
  final Future<void> Function(GeneratedImagePayload) onDeleteImage;
  final Future<void> Function(GeneratedArtifactPayload) onDeleteArtifact;
  final Future<GeneratedArtifactPayload> Function(
    GeneratedArtifactPayload,
    String,
  )
  onSaveArtifactHtml;

  @override
  Widget build(BuildContext context) {
    final GeneratedImagePayload? image = _image(message.metadata);
    final GeneratedArtifactPayload? artifact = _artifact(message.metadata);
    final ChartPayload? chart = _chart(message.metadata);
    final WebSurfPayload? web = _web(message.metadata);
    final List<Widget> children = <Widget>[
      if (image != null && message.metadata['image_deleted'] != true)
        _ImageCard(
          image: image,
          onAction: onImageAction,
          onDelete: () => onDeleteImage(image),
        ),
      if (chart != null) NativeChartCard(payload: chart),
      if (artifact != null && message.metadata['artifact_deleted'] != true)
        _ArtifactCard(
          artifact: artifact,
          onAction: onArtifactAction,
          onDelete: () => onDeleteArtifact(artifact),
          onSave: (String html) => onSaveArtifactHtml(artifact, html),
        ),
      if (web != null) WebSurfResultView(payload: web),
    ];
    if (children.isEmpty) return const SizedBox.shrink();
    return Padding(
      padding: const EdgeInsets.only(top: SentIQSpacing.sm),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children:
            children
                .expand(
                  (Widget child) => <Widget>[
                    child,
                    const SizedBox(height: SentIQSpacing.sm),
                  ],
                )
                .toList()
              ..removeLast(),
      ),
    );
  }
}

class _ImageCard extends StatelessWidget {
  const _ImageCard({
    required this.image,
    required this.onAction,
    required this.onDelete,
  });
  final GeneratedImagePayload image;
  final Future<void> Function(GeneratedImagePayload, ArtifactAction) onAction;
  final Future<void> Function() onDelete;

  ImageProvider<Object>? _provider() {
    try {
      if (image.base64?.isNotEmpty == true) {
        return MemoryImage(RemoteContentPolicy.decodeImageData(image.base64!));
      }
      return NetworkImage(
        RemoteContentPolicy.requireHttps(image.url).toString(),
      );
    } on Object {
      return null;
    }
  }

  @override
  Widget build(BuildContext context) {
    final ImageProvider<Object>? provider = _provider();
    if (provider == null) {
      return const _Failure('The generated image could not be opened safely.');
    }
    return Container(
      constraints: const BoxConstraints(maxWidth: 720),
      decoration: _cardDecoration(context, 22),
      clipBehavior: Clip.antiAlias,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          GestureDetector(
            onTap: () => Navigator.of(context).push<void>(
              MaterialPageRoute<void>(
                builder: (_) => _ImageViewer(
                  image: image,
                  provider: provider,
                  onAction: onAction,
                  onDelete: onDelete,
                ),
              ),
            ),
            child: AspectRatio(
              aspectRatio: 1,
              child: Image(
                image: provider,
                fit: BoxFit.cover,
                filterQuality: FilterQuality.medium,
                errorBuilder: (_, _, _) =>
                    const _Failure('The generated image could not be loaded.'),
              ),
            ),
          ),
          if (image.warning?.isNotEmpty == true)
            Padding(
              padding: const EdgeInsets.fromLTRB(
                SentIQSpacing.xs,
                SentIQSpacing.xs,
                SentIQSpacing.xs,
                0,
              ),
              child: Text(
                image.warning!,
                style: Theme.of(context).textTheme.bodySmall?.copyWith(
                  color: context.sentiqPalette.warning,
                ),
              ),
            ),
          Padding(
            padding: const EdgeInsets.all(SentIQSpacing.xs),
            child: Row(
              children: <Widget>[
                Expanded(
                  child: Text(
                    image.prompt ?? 'Generated image',
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
                _action(
                  'Copy image',
                  Icons.copy_rounded,
                  () => _runUserAction(
                    context,
                    () => onAction(image, ArtifactAction.copy),
                  ),
                ),
                _action(
                  'Share image',
                  Icons.share_outlined,
                  () => _runUserAction(
                    context,
                    () => onAction(image, ArtifactAction.share),
                  ),
                ),
                _action(
                  'Download image',
                  Icons.download_outlined,
                  () => _runUserAction(
                    context,
                    () => onAction(image, ArtifactAction.download),
                  ),
                ),
                _action(
                  'Delete image',
                  Icons.delete_outline_rounded,
                  () => _runUserAction(context, onDelete),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _ImageViewer extends StatelessWidget {
  const _ImageViewer({
    required this.image,
    required this.provider,
    required this.onAction,
    required this.onDelete,
  });
  final GeneratedImagePayload image;
  final ImageProvider<Object> provider;
  final Future<void> Function(GeneratedImagePayload, ArtifactAction) onAction;
  final Future<void> Function() onDelete;

  @override
  Widget build(BuildContext context) => Scaffold(
    appBar: AppBar(
      title: const Text('Generated image'),
      actions: <Widget>[
        _action(
          'Copy image',
          Icons.copy_rounded,
          () => _runUserAction(
            context,
            () => onAction(image, ArtifactAction.copy),
          ),
        ),
        _action(
          'Share image',
          Icons.share_outlined,
          () => _runUserAction(
            context,
            () => onAction(image, ArtifactAction.share),
          ),
        ),
        _action(
          'Download image',
          Icons.download_outlined,
          () => _runUserAction(
            context,
            () => onAction(image, ArtifactAction.download),
          ),
        ),
        _action('Delete image', Icons.delete_outline_rounded, () async {
          bool deleted = false;
          await _runUserAction(context, () async {
            await onDelete();
            deleted = true;
          });
          if (deleted && context.mounted) Navigator.of(context).pop();
        }),
      ],
    ),
    body: InteractiveViewer(
      minScale: 0.5,
      maxScale: 6,
      boundaryMargin: const EdgeInsets.all(160),
      child: Center(
        child: Image(image: provider, fit: BoxFit.contain),
      ),
    ),
  );
}

class _ArtifactCard extends StatefulWidget {
  const _ArtifactCard({
    required this.artifact,
    required this.onAction,
    required this.onDelete,
    required this.onSave,
  });
  final GeneratedArtifactPayload artifact;
  final Future<void> Function(GeneratedArtifactPayload, ArtifactAction)
  onAction;
  final Future<void> Function() onDelete;
  final Future<GeneratedArtifactPayload> Function(String html) onSave;

  @override
  State<_ArtifactCard> createState() => _ArtifactCardState();
}

class _ArtifactCardState extends State<_ArtifactCard> {
  bool busy = false;
  late GeneratedArtifactPayload artifact;

  @override
  void initState() {
    super.initState();
    artifact = widget.artifact;
  }

  @override
  void didUpdateWidget(covariant _ArtifactCard oldWidget) {
    super.didUpdateWidget(oldWidget);
    artifact = widget.artifact;
  }

  Future<void> run(Future<void> Function() action) async {
    if (busy) return;
    setState(() => busy = true);
    try {
      await action();
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(const SnackBar(content: Text('File action completed')));
      }
    } catch (error) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(error.toString().replaceFirst('Exception: ', '')),
          ),
        );
      }
    } finally {
      if (mounted) setState(() => busy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final GeneratedArtifactPayload file = artifact;
    return Container(
      constraints: const BoxConstraints(maxWidth: 720),
      padding: const EdgeInsets.all(SentIQSpacing.sm),
      decoration: _cardDecoration(context, 18),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              const Icon(Icons.description_outlined),
              const SizedBox(width: SentIQSpacing.xs),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(
                      file.fileName,
                      style: Theme.of(context).textTheme.titleSmall,
                    ),
                    Text(
                      '${file.format.toUpperCase()}${file.fileSizeBytes == null ? '' : ' · ${_fileSize(file.fileSizeBytes!)}'}',
                      style: Theme.of(context).textTheme.labelSmall,
                    ),
                  ],
                ),
              ),
              if (busy)
                const SizedBox.square(
                  dimension: 18,
                  child: CircularProgressIndicator(strokeWidth: 2),
                ),
            ],
          ),
          if (file.html?.isNotEmpty == true ||
              file.text?.isNotEmpty == true ||
              file.preview?.isNotEmpty == true) ...<Widget>[
            const SizedBox(height: SentIQSpacing.sm),
            SafeArtifactPreview(artifact: file),
          ],
          Wrap(
            spacing: 4,
            children: <Widget>[
              TextButton.icon(
                onPressed: busy
                    ? null
                    : () => run(
                        () => widget.onAction(file, ArtifactAction.download),
                      ),
                icon: const Icon(Icons.download_outlined),
                label: const Text('Download'),
              ),
              TextButton.icon(
                onPressed: busy
                    ? null
                    : () =>
                          run(() => widget.onAction(file, ArtifactAction.open)),
                icon: const Icon(Icons.open_in_new_rounded),
                label: const Text('Open'),
              ),
              TextButton.icon(
                onPressed: busy
                    ? null
                    : () => run(
                        () => widget.onAction(file, ArtifactAction.share),
                      ),
                icon: const Icon(Icons.share_outlined),
                label: const Text('Share'),
              ),
              if (file.editable)
                TextButton.icon(
                  onPressed: busy ? null : edit,
                  icon: const Icon(Icons.edit_outlined),
                  label: const Text('Edit'),
                ),
              TextButton.icon(
                onPressed: busy ? null : () => run(widget.onDelete),
                icon: const Icon(Icons.delete_outline_rounded),
                label: const Text('Delete'),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Future<void> edit() async {
    final TextEditingController controller = TextEditingController(
      text: artifact.html ?? artifact.preview?['html']?.toString() ?? '',
    );
    final String? result = await showDialog<String>(
      context: context,
      builder: (BuildContext dialogContext) => AlertDialog(
        title: const Text('Edit HTML'),
        content: SizedBox(
          width: 760,
          height: 440,
          child: TextField(
            controller: controller,
            expands: true,
            maxLines: null,
            minLines: null,
            decoration: const InputDecoration(
              helperText:
                  'Scripts, embedded frames and unsafe links are removed on save.',
            ),
          ),
        ),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.of(dialogContext).pop(),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(dialogContext).pop(controller.text),
            child: const Text('Save'),
          ),
        ],
      ),
    );
    controller.dispose();
    if (result != null) {
      await run(() async {
        final GeneratedArtifactPayload updated = await widget.onSave(
          RemoteContentPolicy.sanitizeHtml(result),
        );
        if (mounted) setState(() => artifact = updated);
      });
    }
  }
}

class SafeArtifactPreview extends StatelessWidget {
  const SafeArtifactPreview({required this.artifact, super.key});
  final GeneratedArtifactPayload artifact;

  @override
  Widget build(BuildContext context) {
    String text = artifact.text ?? '';
    final String html =
        artifact.html ?? artifact.preview?['html']?.toString() ?? '';
    if (text.isEmpty && html.isNotEmpty) {
      text = _htmlToText(RemoteContentPolicy.sanitizeHtml(html));
    }
    text = text.isNotEmpty
        ? text
        : artifact.preview?['text']?.toString() ??
              artifact.preview?['document']?.toString() ??
              artifact.preview?['sheet']?.toString() ??
              artifact.preview?['slide']?.toString() ??
              'Preview available after opening the file.';
    return Container(
      width: double.infinity,
      constraints: const BoxConstraints(maxHeight: 220),
      padding: const EdgeInsets.all(SentIQSpacing.sm),
      decoration: BoxDecoration(
        color: context.sentiqPalette.surface,
        borderRadius: BorderRadius.circular(12),
      ),
      child: SingleChildScrollView(child: SelectableText(text, maxLines: 14)),
    );
  }
}

class NativeChartCard extends StatelessWidget {
  const NativeChartCard({required this.payload, super.key});
  final ChartPayload payload;

  @override
  Widget build(BuildContext context) {
    if (!payload.valid) {
      return _Failure(payload.error ?? 'Malformed chart data.');
    }
    return Container(
      constraints: const BoxConstraints(maxWidth: 720),
      padding: const EdgeInsets.all(SentIQSpacing.sm),
      decoration: _cardDecoration(context, 18),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          if (payload.title?.isNotEmpty == true)
            Padding(
              padding: const EdgeInsets.only(bottom: SentIQSpacing.sm),
              child: Text(
                payload.title!,
                style: Theme.of(context).textTheme.titleSmall,
              ),
            ),
          SizedBox(
            height: 280,
            child: CustomPaint(
              painter: _ChartPainter(
                payload,
                Theme.of(context).colorScheme.primary,
                context.sentiqPalette.glassBorder,
              ),
              child: const SizedBox.expand(),
            ),
          ),
        ],
      ),
    );
  }
}

class _ChartPainter extends CustomPainter {
  const _ChartPainter(this.payload, this.foreground, this.grid);
  final ChartPayload payload;
  final Color foreground;
  final Color grid;

  @override
  void paint(Canvas canvas, Size size) {
    final Rect plot = Rect.fromLTWH(36, 12, size.width - 48, size.height - 36);
    final Paint gridPaint = Paint()..color = grid;
    for (int i = 0; i <= 4; i += 1) {
      final double y = plot.top + plot.height * i / 4;
      canvas.drawLine(Offset(plot.left, y), Offset(plot.right, y), gridPaint);
    }
    final List<double> values = payload.series.first;
    final double maximum = payload.series
        .expand((List<double> value) => value)
        .fold<double>(
          1,
          (double old, double value) => math.max(old, value.abs()),
        );
    if (<String>{'pie', 'doughnut'}.contains(payload.type.toLowerCase())) {
      final double total = values.fold<double>(
        0,
        (double sum, double value) => sum + value.abs(),
      );
      double start = -math.pi / 2;
      for (int i = 0; i < values.length && total > 0; i += 1) {
        final double sweep = math.pi * 2 * values[i].abs() / total;
        canvas.drawArc(
          Rect.fromCircle(
            center: plot.center,
            radius: math.min(plot.width, plot.height) * .38,
          ),
          start,
          sweep,
          true,
          Paint()
            ..color = HSLColor.fromColor(foreground)
                .withLightness((.34 + i * .09).clamp(.25, .8).toDouble())
                .toColor(),
        );
        start += sweep;
      }
      return;
    }
    if (payload.type.toLowerCase() == 'bar') {
      final double width = plot.width / math.max(values.length, 1);
      for (int i = 0; i < values.length; i += 1) {
        final double height = plot.height * values[i].abs() / maximum;
        canvas.drawRRect(
          RRect.fromRectAndRadius(
            Rect.fromLTWH(
              plot.left + i * width + width * .15,
              plot.bottom - height,
              width * .7,
              height,
            ),
            const Radius.circular(4),
          ),
          Paint()..color = foreground.withValues(alpha: .82),
        );
      }
      return;
    }
    for (
      int seriesIndex = 0;
      seriesIndex < payload.series.length;
      seriesIndex += 1
    ) {
      final List<double> series = payload.series[seriesIndex];
      final Path path = Path();
      for (int i = 0; i < series.length; i += 1) {
        final double x = series.length == 1
            ? plot.center.dx
            : plot.left + plot.width * i / (series.length - 1);
        final double y = plot.bottom - plot.height * series[i] / maximum;
        i == 0 ? path.moveTo(x, y) : path.lineTo(x, y);
      }
      canvas.drawPath(
        path,
        Paint()
          ..color = foreground.withValues(alpha: 1 - seriesIndex * .18)
          ..style = PaintingStyle.stroke
          ..strokeWidth = 2.5,
      );
    }
  }

  @override
  bool shouldRepaint(covariant _ChartPainter oldDelegate) =>
      oldDelegate.payload != payload || oldDelegate.foreground != foreground;
}

class WebSurfResultView extends StatelessWidget {
  const WebSurfResultView({required this.payload, super.key});
  final WebSurfPayload payload;

  @override
  Widget build(BuildContext context) {
    if (payload.sources.isEmpty && payload.error != null) {
      return _Failure(payload.error!);
    }
    return Container(
      constraints: const BoxConstraints(maxWidth: 760),
      padding: const EdgeInsets.all(SentIQSpacing.sm),
      decoration: _cardDecoration(context, 18),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: <Widget>[
          Row(
            children: <Widget>[
              const Icon(Icons.public_rounded, size: 19),
              const SizedBox(width: SentIQSpacing.xs),
              Expanded(
                child: Text(
                  payload.query.isEmpty ? 'Web sources' : payload.query,
                  style: Theme.of(context).textTheme.titleSmall,
                ),
              ),
              if (payload.partial)
                const Chip(
                  visualDensity: VisualDensity.compact,
                  label: Text('Partial results'),
                ),
            ],
          ),
          if (payload.error != null) Text(payload.error!),
          if (payload.imageUrls.isNotEmpty) ...<Widget>[
            const SizedBox(height: SentIQSpacing.sm),
            _WebImageResults(imageUrls: payload.imageUrls),
          ],
          const SizedBox(height: SentIQSpacing.sm),
          SizedBox(
            height: 196,
            child: ListView.separated(
              scrollDirection: Axis.horizontal,
              itemCount: payload.sources.length,
              separatorBuilder: (_, _) =>
                  const SizedBox(width: SentIQSpacing.xs),
              itemBuilder: (_, int index) =>
                  _SourceCard(payload.sources[index]),
            ),
          ),
        ],
      ),
    );
  }
}

class _WebImageResults extends StatelessWidget {
  const _WebImageResults({required this.imageUrls});

  final List<String> imageUrls;

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      height: 104,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        itemCount: imageUrls.length,
        separatorBuilder: (_, _) => const SizedBox(width: SentIQSpacing.xs),
        itemBuilder: (BuildContext context, int index) {
          final String url = imageUrls[index];
          return InkWell(
            onTap: () => showDialog<void>(
              context: context,
              builder: (BuildContext dialogContext) => Dialog.fullscreen(
                child: Scaffold(
                  appBar: AppBar(
                    title: const Text('Web image result'),
                    leading: IconButton(
                      tooltip: 'Close',
                      onPressed: () => Navigator.of(dialogContext).pop(),
                      icon: const Icon(Icons.close_rounded),
                    ),
                  ),
                  body: InteractiveViewer(
                    minScale: 0.5,
                    maxScale: 5,
                    child: Center(
                      child: Image.network(
                        url,
                        fit: BoxFit.contain,
                        errorBuilder: (_, _, _) => const _Failure(
                          'This web image could not be loaded.',
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
            child: ClipRRect(
              borderRadius: BorderRadius.circular(12),
              child: Image.network(
                url,
                width: 148,
                height: 104,
                fit: BoxFit.cover,
                cacheWidth: 520,
                errorBuilder: (_, _, _) => const SizedBox(
                  width: 148,
                  child: Center(child: Icon(Icons.broken_image_outlined)),
                ),
              ),
            ),
          );
        },
      ),
    );
  }
}

class _SourceCard extends StatelessWidget {
  const _SourceCard(this.source);
  final WebSurfSourcePayload source;

  @override
  Widget build(BuildContext context) {
    final String? thumbnail =
        RemoteContentPolicy.navigationAllowed(source.thumbnailUrl ?? '')
        ? source.thumbnailUrl
        : null;
    return InkWell(
      onTap: () => unawaited(
        launchUrl(
          RemoteContentPolicy.requireHttps(source.url),
          mode: LaunchMode.externalApplication,
        ),
      ),
      child: Container(
        width: 250,
        decoration: _cardDecoration(context, 14),
        clipBehavior: Clip.antiAlias,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: <Widget>[
            if (thumbnail != null)
              Image.network(
                thumbnail,
                height: 72,
                width: double.infinity,
                fit: BoxFit.cover,
                cacheWidth: 700,
                errorBuilder: (_, _, _) => const SizedBox.shrink(),
              ),
            Padding(
              padding: const EdgeInsets.all(SentIQSpacing.xs),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: <Widget>[
                  Text(
                    source.title,
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                  ),
                  Text(
                    source.domain,
                    style: Theme.of(context).textTheme.labelSmall,
                  ),
                  const SizedBox(height: 4),
                  Text(
                    source.snippet,
                    maxLines: thumbnail == null ? 5 : 2,
                    overflow: TextOverflow.ellipsis,
                    style: Theme.of(context).textTheme.bodySmall,
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}

Future<void> _runUserAction(
  BuildContext context,
  Future<void> Function() action,
) async {
  try {
    await action();
  } catch (error) {
    if (!context.mounted) return;
    ScaffoldMessenger.of(context).showSnackBar(
      SnackBar(content: Text(error.toString().replaceFirst('Exception: ', ''))),
    );
  }
}

Widget _action(
  String tooltip,
  IconData icon,
  Future<void> Function() callback,
) => IconButton(
  tooltip: tooltip,
  visualDensity: VisualDensity.compact,
  onPressed: () => unawaited(callback()),
  icon: Icon(icon, size: 19),
);

class _Failure extends StatelessWidget {
  const _Failure(this.message);
  final String message;
  @override
  Widget build(BuildContext context) => Container(
    constraints: const BoxConstraints(maxWidth: 720),
    padding: const EdgeInsets.all(SentIQSpacing.md),
    decoration: BoxDecoration(
      color: context.sentiqPalette.warning.withValues(alpha: .12),
      borderRadius: BorderRadius.circular(14),
    ),
    child: Row(
      children: <Widget>[
        const Icon(Icons.broken_image_outlined),
        const SizedBox(width: SentIQSpacing.xs),
        Expanded(child: Text(message)),
      ],
    ),
  );
}

BoxDecoration _cardDecoration(BuildContext context, double radius) =>
    BoxDecoration(
      borderRadius: BorderRadius.circular(radius),
      border: Border.all(color: context.sentiqPalette.glassBorder),
      color: context.sentiqPalette.surfaceElevated,
    );

GeneratedImagePayload? _image(Map<String, Object?> metadata) {
  final Map<String, Object?> nested = _map(metadata['image']);
  final Map<String, Object?> source = nested.isNotEmpty ? nested : metadata;
  if (source['image_url'] == null &&
      source['url'] == null &&
      source['image_base64'] == null &&
      source['type'] != 'image') {
    return null;
  }
  final GeneratedImagePayload image = GeneratedImagePayload.fromJson(source);
  return image.valid ? image : null;
}

GeneratedArtifactPayload? _artifact(Map<String, Object?> metadata) {
  Map<String, Object?> source = _map(metadata['artifact']);
  if (source['artifact'] is Map) source = _map(source['artifact']);
  if (source['file'] is Map) source = _map(source['file']);
  if (source.isEmpty) source = _map(metadata['file']);
  if (source.isEmpty && metadata['file_id'] != null) source = metadata;
  if (source.isEmpty) return null;
  final GeneratedArtifactPayload artifact = GeneratedArtifactPayload.fromJson(
    source,
  );
  return artifact.valid ? artifact : null;
}

ChartPayload? _chart(Map<String, Object?> metadata) {
  final Map<String, Object?> preview = _map(metadata['preview']);
  Map<String, Object?> source = _map(metadata['chart'] ?? preview['chart']);
  if (source.isEmpty &&
      (metadata['chartjs_config'] != null || metadata['plotly_json'] != null)) {
    source = metadata;
  }
  return source.isEmpty ? null : ChartPayload.fromJson(source);
}

WebSurfPayload? _web(Map<String, Object?> metadata) {
  final Map<String, Object?> preview = _map(metadata['preview']);
  final Map<String, Object?> source = _map(
    metadata['websurf_v2'] ??
        metadata['web_search'] ??
        preview['websurf_v2'] ??
        preview['web_search'],
  );
  return source.isEmpty ? null : WebSurfPayload.fromJson(source);
}

Map<String, Object?> _map(Object? value) {
  if (value is String) {
    try {
      value = jsonDecode(value);
    } on FormatException {
      return <String, Object?>{};
    }
  }
  if (value is! Map) {
    return <String, Object?>{};
  }
  return value.map(
    (Object? key, Object? value) => MapEntry(key.toString(), value),
  );
}

String _htmlToText(String html) => html
    .replaceAll(RegExp(r'<\s*br\s*/?>', caseSensitive: false), '\n')
    .replaceAll(
      RegExp(
        r'<\s*/\s*(p|div|section|article|li|h[1-6])\s*>',
        caseSensitive: false,
      ),
      '\n',
    )
    .replaceAll(RegExp(r'<[^>]+>'), ' ')
    .replaceAll('&nbsp;', ' ')
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll(RegExp(r'[ \t]+'), ' ')
    .replaceAll(RegExp(r'\n\s*\n+'), '\n\n')
    .trim();

String _fileSize(int bytes) {
  if (bytes < 1024) return '$bytes B';
  if (bytes < 1024 * 1024) return '${(bytes / 1024).toStringAsFixed(1)} KB';
  return '${(bytes / (1024 * 1024)).toStringAsFixed(1)} MB';
}
