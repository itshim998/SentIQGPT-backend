import 'package:flutter/material.dart';
import 'package:sentiq_chat/core/config/app_config.dart';
import 'package:sentiq_chat/core/design_system/sentiq_tokens.dart';
import 'package:sentiq_chat/shared/widgets/refractive_glass_surface.dart';
import 'package:sentiq_chat/shared/widgets/sentiq_button.dart';
import 'package:sentiq_chat/shared/widgets/sentiq_dialog.dart';
import 'package:sentiq_chat/shared/widgets/sentiq_empty_state.dart';
import 'package:sentiq_chat/shared/widgets/sentiq_feedback.dart';
import 'package:sentiq_chat/shared/widgets/sentiq_loading_state.dart';
import 'package:sentiq_chat/shared/widgets/sentiq_sheet.dart';
import 'package:sentiq_chat/shared/widgets/sentiq_text_field.dart';

class FoundationGalleryScreen extends StatelessWidget {
  const FoundationGalleryScreen({required this.config, super.key});

  final AppConfig config;

  @override
  Widget build(BuildContext context) {
    final SentIQPalette palette = context.sentiqPalette;
    return Scaffold(
      body: Stack(
        children: <Widget>[
          Positioned(
            top: -130,
            right: -90,
            child: IgnorePointer(
              child: DecoratedBox(
                decoration: BoxDecoration(
                  shape: BoxShape.circle,
                  gradient: RadialGradient(
                    colors: <Color>[
                      palette.accent.withValues(alpha: 0.22),
                      palette.accent.withValues(alpha: 0),
                    ],
                  ),
                ),
                child: const SizedBox.square(dimension: 360),
              ),
            ),
          ),
          SafeArea(
            child: ListView(
              padding: const EdgeInsets.all(SentIQSpacing.lg),
              children: <Widget>[
                Text(
                  'SentIQ Chat',
                  style: Theme.of(context).textTheme.headlineMedium,
                ),
                const SizedBox(height: SentIQSpacing.xs),
                Text(
                  'Android foundation · ${config.environment.name}',
                  style: Theme.of(context).textTheme.bodyMedium?.copyWith(
                        color: palette.textSecondary,
                      ),
                ),
                const SizedBox(height: SentIQSpacing.lg),
                RefractiveGlassSurface(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: <Widget>[
                      Text(
                        'Calm, responsive foundations',
                        style: Theme.of(context).textTheme.titleLarge,
                      ),
                      const SizedBox(height: SentIQSpacing.xs),
                      Text(
                        'Refractive depth is reserved for controls and transient surfaces, keeping reading areas clear.',
                        style: TextStyle(color: palette.textSecondary),
                      ),
                    ],
                  ),
                ),
                const SizedBox(height: SentIQSpacing.md),
                const SentIQTextField(
                  label: 'Message SentIQ Chat',
                  hint: 'Ask anything',
                  prefixIcon: Icons.auto_awesome_outlined,
                  maxLines: 3,
                ),
                const SizedBox(height: SentIQSpacing.md),
                Wrap(
                  spacing: SentIQSpacing.xs,
                  runSpacing: SentIQSpacing.xs,
                  children: <Widget>[
                    SentIQButton(
                      label: 'Continue',
                      icon: Icons.arrow_forward_rounded,
                      onPressed: () => SentIQToast.show(
                        context,
                        'Foundation components are ready.',
                      ),
                    ),
                    SentIQButton(
                      label: 'Open sheet',
                      style: SentIQButtonStyle.secondary,
                      onPressed: () => showSentIQSheet<void>(
                        context: context,
                        builder: (BuildContext context) => const Padding(
                          padding: EdgeInsets.only(bottom: SentIQSpacing.lg),
                          child: SentIQEmptyState(
                            icon: Icons.chat_bubble_outline_rounded,
                            title: 'A clear place to begin',
                            message: 'Conversations will appear here in Phase 2.',
                          ),
                        ),
                      ),
                    ),
                    SentIQIconButton(
                      icon: Icons.tune_rounded,
                      tooltip: 'Show dialog',
                      onPressed: () => showDialog<void>(
                        context: context,
                        builder: (BuildContext context) => SentIQDialog(
                          title: 'Foundation ready',
                          body: const Text(
                            'The native design system is now connected to both themes.',
                          ),
                          primaryLabel: 'Done',
                          onPrimary: () => Navigator.of(context).pop(),
                        ),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: SentIQSpacing.lg),
                const SentIQLoadingState(label: 'Preparing your workspace…'),
                const SizedBox(height: SentIQSpacing.md),
                const SentIQInlineError(
                  message: 'This is how a recoverable problem will appear.',
                  actionLabel: 'Try again',
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
