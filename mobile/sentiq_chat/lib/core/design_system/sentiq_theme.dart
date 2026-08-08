import 'package:flutter/material.dart';
import 'package:sentiq_chat/core/design_system/sentiq_tokens.dart';

abstract final class SentIQTheme {
  static ThemeData dark() =>
      _build(brightness: Brightness.dark, palette: SentIQPalette.dark);

  static ThemeData light() =>
      _build(brightness: Brightness.light, palette: SentIQPalette.light);

  static ThemeData _build({
    required Brightness brightness,
    required SentIQPalette palette,
  }) {
    final ColorScheme scheme = ColorScheme.fromSeed(
      seedColor: palette.accent,
      brightness: brightness,
      surface: palette.surface,
      error: palette.danger,
    );

    // Use Flutter's iOS typography metrics without bundling Apple's proprietary
    // font files. Android keeps a safe system-font fallback while spacing,
    // weights and hierarchy follow the calmer iOS-style rhythm.
    final TextTheme base = Typography.material2021(
      platform: TargetPlatform.iOS,
    ).black.apply(
      bodyColor: palette.textPrimary,
      displayColor: palette.textPrimary,
    );
    final TextTheme textTheme = base.copyWith(
      displayLarge: base.displayLarge?.copyWith(
        fontWeight: FontWeight.w700,
        letterSpacing: -1.25,
      ),
      displayMedium: base.displayMedium?.copyWith(
        fontWeight: FontWeight.w700,
        letterSpacing: -1.05,
      ),
      headlineLarge: base.headlineLarge?.copyWith(
        fontWeight: FontWeight.w700,
        letterSpacing: -0.9,
      ),
      headlineMedium: base.headlineMedium?.copyWith(
        fontWeight: FontWeight.w700,
        letterSpacing: -0.72,
      ),
      headlineSmall: base.headlineSmall?.copyWith(
        fontWeight: FontWeight.w600,
        letterSpacing: -0.5,
      ),
      titleLarge: base.titleLarge?.copyWith(
        fontWeight: FontWeight.w600,
        letterSpacing: -0.34,
      ),
      titleMedium: base.titleMedium?.copyWith(
        fontWeight: FontWeight.w600,
        letterSpacing: -0.18,
      ),
      bodyLarge: base.bodyLarge?.copyWith(height: 1.48, letterSpacing: -0.08),
      bodyMedium: base.bodyMedium?.copyWith(height: 1.5, letterSpacing: -0.04),
      labelLarge: base.labelLarge?.copyWith(fontWeight: FontWeight.w600),
    );

    return ThemeData(
      useMaterial3: true,
      materialTapTargetSize: MaterialTapTargetSize.padded,
      brightness: brightness,
      colorScheme: scheme,
      scaffoldBackgroundColor: palette.canvas,
      canvasColor: palette.canvas,
      textTheme: textTheme,
      splashFactory: InkSparkle.splashFactory,
      iconButtonTheme: IconButtonThemeData(
        style: IconButton.styleFrom(minimumSize: const Size(48, 48)),
      ),
      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(minimumSize: const Size(48, 48)),
      ),
      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(minimumSize: const Size(48, 48)),
      ),
      textButtonTheme: TextButtonThemeData(
        style: TextButton.styleFrom(minimumSize: const Size(48, 48)),
      ),
      extensions: <ThemeExtension<dynamic>>[palette],
      pageTransitionsTheme: const PageTransitionsTheme(
        builders: <TargetPlatform, PageTransitionsBuilder>{
          TargetPlatform.android: _SentIQPageTransitionsBuilder(),
        },
      ),
    );
  }
}

class _SentIQPageTransitionsBuilder extends PageTransitionsBuilder {
  const _SentIQPageTransitionsBuilder();

  @override
  Widget buildTransitions<T>(
    PageRoute<T> route,
    BuildContext context,
    Animation<double> animation,
    Animation<double> secondaryAnimation,
    Widget child,
  ) {
    if (route.isFirst || MediaQuery.disableAnimationsOf(context)) return child;
    final Animation<double> curved = CurvedAnimation(
      parent: animation,
      curve: SentIQMotion.emphasized,
      reverseCurve: Curves.easeInCubic,
    );
    return FadeTransition(
      opacity: curved,
      child: ScaleTransition(
        scale: Tween<double>(begin: 0.985, end: 1).animate(curved),
        alignment: Alignment.center,
        child: child,
      ),
    );
  }
}
