import 'package:flutter/material.dart';
import 'package:sentiq_chat/core/design_system/sentiq_tokens.dart';
import 'package:sentiq_chat/shared/widgets/refractive_glass_surface.dart';

Future<T?> showSentIQSheet<T>({
  required BuildContext context,
  required WidgetBuilder builder,
  bool isDismissible = true,
}) {
  return showModalBottomSheet<T>(
    context: context,
    isScrollControlled: true,
    isDismissible: isDismissible,
    backgroundColor: Colors.transparent,
    barrierColor: Colors.black.withValues(alpha: 0.34),
    builder: (BuildContext context) {
      return SafeArea(
        top: false,
        child: Padding(
          padding: const EdgeInsets.fromLTRB(
            SentIQSpacing.sm,
            0,
            SentIQSpacing.sm,
            SentIQSpacing.sm,
          ),
          child: RefractiveGlassSurface(
            borderRadius: SentIQRadii.large,
            child: builder(context),
          ),
        ),
      );
    },
  );
}
