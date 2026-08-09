import 'package:flutter/material.dart';
import 'package:sentiq_chat/core/design_system/sentiq_tokens.dart';
import 'package:sentiq_chat/core/performance/performance_policy.dart';

Future<T?> showSentIQSheet<T>({
  required BuildContext context,
  required WidgetBuilder builder,
  bool isDismissible = true,
}) {
  final bool reduceMotion = SentIQPerformancePolicy.reduceMotion(context);
  return showGeneralDialog<T>(
    context: context,
    barrierDismissible: isDismissible,
    barrierLabel: MaterialLocalizations.of(context).modalBarrierDismissLabel,
    barrierColor: Colors.black.withValues(alpha: 0.48),
    transitionDuration: reduceMotion ? Duration.zero : SentIQMotion.quick,
    pageBuilder: (
      BuildContext dialogContext,
      Animation<double> animation,
      Animation<double> secondaryAnimation,
    ) {
      final SentIQPalette palette = dialogContext.sentiqPalette;
      final double maxHeight = MediaQuery.sizeOf(dialogContext).height * 0.48;
      final BorderRadius radius = BorderRadius.circular(30);
      return RepaintBoundary(
        child: SafeArea(
          top: false,
          child: Align(
            alignment: Alignment.bottomCenter,
            child: Padding(
              padding: const EdgeInsets.all(SentIQSpacing.sm),
              child: ConstrainedBox(
                constraints: BoxConstraints(maxWidth: 620, maxHeight: maxHeight),
                child: Material(
                  key: const Key('sentiq-sheet-surface'),
                  color: palette.surfaceElevated,
                  surfaceTintColor: Colors.transparent,
                  elevation: 10,
                  shadowColor: Colors.black.withValues(alpha: 0.28),
                  shape: RoundedRectangleBorder(
                    borderRadius: radius,
                    side: BorderSide(color: palette.glassBorder),
                  ),
                  clipBehavior: Clip.antiAlias,
                  child: SingleChildScrollView(
                    key: const Key('sentiq-sheet-scroll-view'),
                    physics: const BouncingScrollPhysics(),
                    padding: const EdgeInsets.all(SentIQSpacing.md),
                    child: builder(dialogContext),
                  ),
                ),
              ),
            ),
          ),
        ),
      );
    },
    transitionBuilder: (
      BuildContext dialogContext,
      Animation<double> animation,
      Animation<double> secondaryAnimation,
      Widget child,
    ) {
      if (reduceMotion) return child;
      final Animation<double> curved = CurvedAnimation(
        parent: animation,
        curve: SentIQMotion.emphasized,
        reverseCurve: Curves.easeInCubic,
      );
      return FadeTransition(
        opacity: curved,
        child: ScaleTransition(
          alignment: Alignment.bottomCenter,
          scale: Tween<double>(begin: 0.985, end: 1).animate(curved),
          child: child,
        ),
      );
    },
  );
}
