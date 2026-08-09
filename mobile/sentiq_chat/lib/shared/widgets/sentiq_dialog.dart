import 'package:flutter/material.dart';
import 'package:sentiq_chat/core/design_system/sentiq_tokens.dart';
import 'package:sentiq_chat/shared/widgets/sentiq_button.dart';

class SentIQDialog extends StatelessWidget {
  const SentIQDialog({
    required this.title,
    required this.body,
    this.primaryLabel,
    this.onPrimary,
    this.secondaryLabel,
    this.onSecondary,
    super.key,
  });

  final String title;
  final Widget body;
  final String? primaryLabel;
  final VoidCallback? onPrimary;
  final String? secondaryLabel;
  final VoidCallback? onSecondary;

  @override
  Widget build(BuildContext context) {
    final SentIQPalette palette = context.sentiqPalette;
    return Dialog(
      elevation: 0,
      backgroundColor: Colors.transparent,
      insetPadding: const EdgeInsets.all(SentIQSpacing.lg),
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 440),
        child: Material(
          color: palette.surfaceElevated,
          surfaceTintColor: Colors.transparent,
          elevation: 12,
          shadowColor: Colors.black.withValues(alpha: 0.28),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(SentIQRadii.large),
            side: BorderSide(color: palette.glassBorder),
          ),
          clipBehavior: Clip.antiAlias,
          child: Padding(
            padding: const EdgeInsets.all(SentIQSpacing.md),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: <Widget>[
                Text(title, style: Theme.of(context).textTheme.titleLarge),
                const SizedBox(height: SentIQSpacing.sm),
                body,
                if (primaryLabel != null || secondaryLabel != null) ...<Widget>[
                  const SizedBox(height: SentIQSpacing.lg),
                  Row(
                    mainAxisAlignment: MainAxisAlignment.end,
                    children: <Widget>[
                      if (secondaryLabel != null)
                        SentIQButton(
                          label: secondaryLabel!,
                          style: SentIQButtonStyle.quiet,
                          onPressed: onSecondary,
                        ),
                      if (primaryLabel != null) ...<Widget>[
                        const SizedBox(width: SentIQSpacing.xs),
                        SentIQButton(
                          label: primaryLabel!,
                          onPressed: onPrimary,
                        ),
                      ],
                    ],
                  ),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}
