import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:sentiq_chat/app/app_providers.dart';
import 'package:sentiq_chat/core/design_system/sentiq_tokens.dart';
import 'package:sentiq_chat/core/network/api_client.dart';
import 'package:sentiq_chat/features/chat/presentation/native_rich_text.dart';
import 'package:sentiq_chat/features/multimodal/platform/artifact_platform_service.dart';
import 'package:sentiq_chat/features/research/application/deep_research_controller.dart';
import 'package:sentiq_chat/features/research/domain/deep_research_models.dart';
import 'package:sentiq_chat/shared/widgets/refractive_glass_surface.dart';
import 'package:sentiq_chat/shared/widgets/sentiq_button.dart';
import 'package:url_launcher/url_launcher.dart';

class DeepResearchScreen extends ConsumerStatefulWidget {
  const DeepResearchScreen({
    required this.conversationId,
    this.initialPrompt,
    super.key,
  });

  final String conversationId;
  final String? initialPrompt;

  @override
  ConsumerState<DeepResearchScreen> createState() => _DeepResearchScreenState();
}

class _DeepResearchScreenState extends ConsumerState<DeepResearchScreen>
    with WidgetsBindingObserver {
  late final TextEditingController _prompt = TextEditingController(
    text: widget.initialPrompt,
  );
  static const ArtifactPlatformService _artifacts = ArtifactPlatformService();

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    unawaited(
      ref
          .read(deepResearchControllerProvider(widget.conversationId).notifier)
          .handleLifecycle(state),
    );
  }

  @override
  Widget build(BuildContext context) {
    final DeepResearchState state = ref.watch(
      deepResearchControllerProvider(widget.conversationId),
    );
    final DeepResearchController controller = ref.read(
      deepResearchControllerProvider(widget.conversationId).notifier,
    );
    final DeepResearchReport? report = state.report;
    return Scaffold(
      appBar: AppBar(
        title: const Text('Deep Research'),
        actions: <Widget>[
          IconButton(
            tooltip: 'Resume a report',
            onPressed: () => _resume(controller),
            icon: const Icon(Icons.history_rounded),
          ),
          IconButton(
            tooltip: 'Refresh research status',
            onPressed: report == null
                ? controller.refreshQuota
                : controller.refresh,
            icon: const Icon(Icons.refresh_rounded),
          ),
        ],
      ),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(SentIQSpacing.md),
          children: <Widget>[
            RefractiveGlassSurface(
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: <Widget>[
                  Row(
                    children: <Widget>[
                      const Icon(Icons.travel_explore_rounded),
                      const SizedBox(width: SentIQSpacing.xs),
                      Expanded(
                        child: Text(
                          'Research a question across current sources and return a structured report.',
                          style: Theme.of(context).textTheme.bodyMedium,
                        ),
                      ),
                      _QuotaBadge(quota: state.quota),
                    ],
                  ),
                  const SizedBox(height: SentIQSpacing.md),
                  TextField(
                    controller: _prompt,
                    enabled: !state.running && !state.loading,
                    minLines: 3,
                    maxLines: 8,
                    maxLength: 10000,
                    textCapitalization: TextCapitalization.sentences,
                    decoration: const InputDecoration(
                      labelText: 'What should SentIQ Chat research?',
                      alignLabelWithHint: true,
                    ),
                  ),
                  SentIQButton(
                    label: state.loading ? 'Starting…' : 'Start research',
                    expand: true,
                    onPressed:
                        state.loading || state.running || !state.quota.available
                        ? null
                        : () => unawaited(controller.start(_prompt.text)),
                  ),
                ],
              ),
            ),
            if (state.message != null) ...<Widget>[
              const SizedBox(height: SentIQSpacing.sm),
              MaterialBanner(
                content: Text(state.message!),
                actions: <Widget>[
                  TextButton(
                    onPressed: controller.refresh,
                    child: const Text('Retry'),
                  ),
                ],
              ),
            ],
            if (report != null) ...<Widget>[
              const SizedBox(height: SentIQSpacing.md),
              _ResearchWorkspace(
                state: state,
                report: report,
                onCancel: controller.cancel,
                onSave: (String format) =>
                    _export(controller, format: format, share: false),
                onShare: () => _export(controller, format: 'pdf', share: true),
              ),
            ],
          ],
        ),
      ),
    );
  }

  Future<void> _resume(DeepResearchController controller) async {
    final TextEditingController reportId = TextEditingController();
    final String? value = await showDialog<String>(
      context: context,
      builder: (BuildContext context) => AlertDialog(
        title: const Text('Resume Deep Research'),
        content: TextField(
          controller: reportId,
          autofocus: true,
          decoration: const InputDecoration(labelText: 'Report ID'),
          textInputAction: TextInputAction.done,
          onSubmitted: (String value) => Navigator.of(context).pop(value),
        ),
        actions: <Widget>[
          TextButton(
            onPressed: () => Navigator.of(context).pop(),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(context).pop(reportId.text),
            child: const Text('Resume'),
          ),
        ],
      ),
    );
    reportId.dispose();
    if (value != null && value.trim().isNotEmpty) {
      await controller.resume(value.trim());
    }
  }

  Future<void> _export(
    DeepResearchController controller, {
    required String format,
    required bool share,
  }) async {
    final SentIQBinaryResponse? response = await controller.export(format);
    if (response == null || !mounted) return;
    final String filename = response.filename ?? 'deep-research-report.$format';
    if (share) {
      await _artifacts.shareFile(
        bytes: response.bytes,
        filename: filename,
        mimeType: response.contentType,
      );
    } else {
      await _artifacts.saveFile(
        bytes: response.bytes,
        filename: filename,
        mimeType: response.contentType,
      );
    }
    if (mounted) {
      ScaffoldMessenger.of(context).showSnackBar(
        SnackBar(
          content: Text(share ? 'Share sheet opened.' : 'Report saved.'),
        ),
      );
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _prompt.dispose();
    super.dispose();
  }
}

class _QuotaBadge extends StatelessWidget {
  const _QuotaBadge({required this.quota});

  final DeepResearchQuota quota;

  @override
  Widget build(BuildContext context) {
    return Chip(
      avatar: const Icon(Icons.query_stats_rounded, size: 16),
      label: Text('${quota.remaining}/${quota.limit} left'),
      visualDensity: VisualDensity.compact,
    );
  }
}

class _ResearchWorkspace extends StatelessWidget {
  const _ResearchWorkspace({
    required this.state,
    required this.report,
    required this.onCancel,
    required this.onSave,
    required this.onShare,
  });

  final DeepResearchState state;
  final DeepResearchReport report;
  final VoidCallback onCancel;
  final ValueChanged<String> onSave;
  final VoidCallback onShare;

  @override
  Widget build(BuildContext context) {
    return RefractiveGlassSurface(
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: <Widget>[
          Row(
            children: <Widget>[
              Icon(_statusIcon(report.status)),
              const SizedBox(width: SentIQSpacing.xs),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: <Widget>[
                    Text(
                      report.title,
                      maxLines: 2,
                      overflow: TextOverflow.ellipsis,
                      style: Theme.of(context).textTheme.titleMedium,
                    ),
                    Text(
                      report.statusText.isEmpty
                          ? _statusLabel(report.status)
                          : report.statusText,
                      style: Theme.of(context).textTheme.bodySmall,
                    ),
                  ],
                ),
              ),
              if (report.status == DeepResearchStatus.running)
                Chip(
                  avatar: state.streamConnected
                      ? const Icon(Icons.wifi_rounded, size: 15)
                      : const SizedBox.square(
                          dimension: 14,
                          child: CircularProgressIndicator(strokeWidth: 2),
                        ),
                  label: Text(
                    state.streamConnected ? 'Live updates' : 'Reconnecting',
                  ),
                  visualDensity: VisualDensity.compact,
                ),
            ],
          ),
          if (report.status == DeepResearchStatus.running) ...<Widget>[
            const SizedBox(height: SentIQSpacing.md),
            LinearProgressIndicator(value: report.progressPercent / 100),
            const SizedBox(height: SentIQSpacing.xs),
            Row(
              children: <Widget>[
                Text('${report.progressPercent}%'),
                const Spacer(),
                Text('${report.sources.length} sources'),
              ],
            ),
            const SizedBox(height: SentIQSpacing.md),
            OutlinedButton.icon(
              onPressed: report.cancellationRequested ? null : onCancel,
              icon: const Icon(Icons.stop_circle_outlined),
              label: Text(
                report.cancellationRequested
                    ? 'Cancelling…'
                    : 'Cancel research',
              ),
            ),
          ],
          if (report.visibleContent.trim().isNotEmpty) ...<Widget>[
            const SizedBox(height: SentIQSpacing.lg),
            NativeRichText(data: report.visibleContent),
          ],
          if (report.sources.isNotEmpty) ...<Widget>[
            const SizedBox(height: SentIQSpacing.lg),
            Text('Sources', style: Theme.of(context).textTheme.titleSmall),
            const SizedBox(height: SentIQSpacing.xs),
            for (final DeepResearchSource source in report.sources)
              ListTile(
                contentPadding: EdgeInsets.zero,
                leading: const Icon(Icons.link_rounded),
                title: Text(source.title),
                subtitle: source.hasSafeUrl
                    ? Text(
                        Uri.parse(source.url).host,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      )
                    : null,
                onTap: !source.hasSafeUrl
                    ? null
                    : () => launchUrl(
                        Uri.parse(source.url),
                        mode: LaunchMode.externalApplication,
                      ),
              ),
          ],
          if (report.status == DeepResearchStatus.completed) ...<Widget>[
            const SizedBox(height: SentIQSpacing.md),
            Row(
              children: <Widget>[
                Expanded(
                  child: PopupMenuButton<String>(
                    enabled: !state.exporting,
                    onSelected: onSave,
                    itemBuilder: (_) => const <PopupMenuEntry<String>>[
                      PopupMenuItem<String>(
                        value: 'md',
                        child: Text('Markdown'),
                      ),
                      PopupMenuItem<String>(
                        value: 'docx',
                        child: Text('Word document'),
                      ),
                      PopupMenuItem<String>(value: 'pdf', child: Text('PDF')),
                    ],
                    child: FilledButton.tonalIcon(
                      onPressed: null,
                      icon: state.exporting
                          ? const SizedBox.square(
                              dimension: 16,
                              child: CircularProgressIndicator(strokeWidth: 2),
                            )
                          : const Icon(Icons.download_rounded),
                      label: const Text('Export'),
                    ),
                  ),
                ),
                const SizedBox(width: SentIQSpacing.xs),
                Expanded(
                  child: FilledButton.icon(
                    onPressed: state.exporting ? null : onShare,
                    icon: const Icon(Icons.share_outlined),
                    label: const Text('Share PDF'),
                  ),
                ),
              ],
            ),
          ],
        ],
      ),
    );
  }
}

IconData _statusIcon(DeepResearchStatus status) {
  return switch (status) {
    DeepResearchStatus.running => Icons.travel_explore_rounded,
    DeepResearchStatus.completed => Icons.check_circle_outline_rounded,
    DeepResearchStatus.failed => Icons.error_outline_rounded,
    DeepResearchStatus.cancelled => Icons.cancel_outlined,
    DeepResearchStatus.idle => Icons.science_outlined,
  };
}

String _statusLabel(DeepResearchStatus status) {
  return switch (status) {
    DeepResearchStatus.running => 'Running in the background',
    DeepResearchStatus.completed => 'Report complete',
    DeepResearchStatus.failed => 'Research needs attention',
    DeepResearchStatus.cancelled => 'Research cancelled',
    DeepResearchStatus.idle => 'Ready',
  };
}
