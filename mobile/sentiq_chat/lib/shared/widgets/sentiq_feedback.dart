import 'package:flutter/material.dart';
import 'package:sentiq_chat/core/design_system/sentiq_tokens.dart';

class SentIQInlineError extends StatelessWidget {
  const SentIQInlineError({
    required this.message,
    this.actionLabel,
    this.onAction,
    super.key,
  });

  final String message;
  final String? actionLabel;
  final VoidCallback? onAction;

  @override
  Widget build(BuildContext context) {
    final SentIQPalette palette = context.sentiqPalette;
    return Semantics(
      liveRegion: true,
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: palette.danger.withValues(alpha: 0.10),
          border: Border.all(color: palette.danger.withValues(alpha: 0.28)),
          borderRadius: BorderRadius.circular(SentIQRadii.medium),
        ),
        child: Padding(
          padding: const EdgeInsets.all(SentIQSpacing.sm),
          child: Row(
            children: <Widget>[
              Icon(Icons.info_outline_rounded, color: palette.danger),
              const SizedBox(width: SentIQSpacing.sm),
              Expanded(child: Text(message)),
              if (actionLabel != null)
                TextButton(onPressed: onAction, child: Text(actionLabel!)),
            ],
          ),
        ),
      ),
    );
  }
}

class SentIQToast {
  const SentIQToast._();

  static void show(
    BuildContext context,
    String message, {
    IconData icon = Icons.check_circle_outline_rounded,
  }) {
    final SentIQPalette palette = context.sentiqPalette;
    final ScaffoldMessengerState messenger = ScaffoldMessenger.of(context);
    messenger
      ..hideCurrentSnackBar()
      ..showSnackBar(
        SnackBar(
          behavior: SnackBarBehavior.floating,
          margin: const EdgeInsets.all(SentIQSpacing.md),
          elevation: 0,
          backgroundColor: palette.surfaceElevated,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(SentIQRadii.medium),
            side: BorderSide(color: palette.glassBorder),
          ),
          content: Row(
            children: <Widget>[
              Icon(icon, color: palette.accent),
              const SizedBox(width: SentIQSpacing.sm),
              Expanded(child: Text(message)),
            ],
          ),
        ),
      );
  }
}
