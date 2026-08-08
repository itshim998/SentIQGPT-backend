import 'package:flutter/material.dart';
import 'package:sentiq_chat/core/design_system/sentiq_tokens.dart';
import 'package:sentiq_chat/core/performance/performance_policy.dart';
import 'package:sentiq_chat/shared/widgets/refractive_glass_surface.dart';

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
    barrierColor: Colors.black.withValues(alpha: 0.34),
    transitionDuration: reduceMotion ? Duration.zero : SentIQMotion.standard,
    pageBuilder: (
      BuildContext dialogContext,
      Animation<double> animation,
      Animation<double> secondaryAnimation,
    ) {
      final double maxHeight = MediaQuery.sizeOf(dialogContext).height * 0.82;
      return SafeArea(
        top: false,
        child: Align(
          alignment: Alignment.bottomCenter,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(
              SentIQSpacing.sm,
              SentIQSpacing.sm,
              SentIQSpacing.sm,
              SentIQSpacing.sm,
            ),
            child: ConstrainedBox(
              constraints: BoxConstraints(maxWidth: 620, maxHeight: maxHeight),
              child: RefractiveGlassSurface(
                borderRadius: 30,
                child: SingleChildScrollView(
                  physics: const BouncingScrollPhysics(),
                  child: builder(dialogContext),
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
          scale: Tween<double>(begin: 0.975, end: 1).animate(curved),
          child: child,
        ),
      );
    },
  );
}
