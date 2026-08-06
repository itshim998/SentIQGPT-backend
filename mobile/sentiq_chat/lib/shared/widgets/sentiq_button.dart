import 'package:flutter/material.dart';
import 'package:sentiq_chat/core/design_system/sentiq_tokens.dart';

enum SentIQButtonStyle { primary, secondary, quiet, danger }

class SentIQButton extends StatelessWidget {
  const SentIQButton({
    required this.label,
    required this.onPressed,
    this.icon,
    this.style = SentIQButtonStyle.primary,
    this.loading = false,
    this.expand = false,
    super.key,
  });

  final String label;
  final VoidCallback? onPressed;
  final IconData? icon;
  final SentIQButtonStyle style;
  final bool loading;
  final bool expand;

  @override
  Widget build(BuildContext context) {
    final SentIQPalette palette = context.sentiqPalette;
    final Color foreground = switch (style) {
      SentIQButtonStyle.primary => Colors.white,
      SentIQButtonStyle.secondary || SentIQButtonStyle.quiet =>
        palette.textPrimary,
      SentIQButtonStyle.danger => palette.danger,
    };
    final Color background = switch (style) {
      SentIQButtonStyle.primary => palette.accent,
      SentIQButtonStyle.secondary => palette.surfaceElevated,
      SentIQButtonStyle.quiet => Colors.transparent,
      SentIQButtonStyle.danger => palette.danger.withValues(alpha: 0.12),
    };
    final Widget content = AnimatedSwitcher(
      duration: SentIQMotion.quick,
      child: loading
          ? SizedBox(
              key: const ValueKey<String>('loading'),
              width: 18,
              height: 18,
              child: CircularProgressIndicator(
                strokeWidth: 2,
                color: foreground,
              ),
            )
          : Row(
              key: const ValueKey<String>('label'),
              mainAxisSize: MainAxisSize.min,
              mainAxisAlignment: MainAxisAlignment.center,
              children: <Widget>[
                if (icon != null) ...<Widget>[
                  Icon(icon, size: 18),
                  const SizedBox(width: SentIQSpacing.xs),
                ],
                Text(label),
              ],
            ),
    );
    final Widget button = FilledButton(
      onPressed: loading ? null : onPressed,
      style: FilledButton.styleFrom(
        foregroundColor: foreground,
        backgroundColor: background,
        disabledBackgroundColor: background.withValues(alpha: 0.45),
        minimumSize: const Size(48, 48),
        padding: const EdgeInsets.symmetric(
          horizontal: SentIQSpacing.md,
          vertical: SentIQSpacing.sm,
        ),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(SentIQRadii.medium),
          side: style == SentIQButtonStyle.secondary
              ? BorderSide(color: palette.glassBorder)
              : BorderSide.none,
        ),
        elevation: 0,
      ),
      child: content,
    );
    return expand ? SizedBox(width: double.infinity, child: button) : button;
  }
}

class SentIQIconButton extends StatelessWidget {
  const SentIQIconButton({
    required this.icon,
    required this.tooltip,
    required this.onPressed,
    super.key,
  });

  final IconData icon;
  final String tooltip;
  final VoidCallback? onPressed;

  @override
  Widget build(BuildContext context) {
    final SentIQPalette palette = context.sentiqPalette;
    return IconButton(
      tooltip: tooltip,
      onPressed: onPressed,
      icon: Icon(icon),
      color: palette.textSecondary,
      style: IconButton.styleFrom(
        minimumSize: const Size(48, 48),
        backgroundColor: palette.glass,
        side: BorderSide(color: palette.glassBorder),
      ),
    );
  }
}
