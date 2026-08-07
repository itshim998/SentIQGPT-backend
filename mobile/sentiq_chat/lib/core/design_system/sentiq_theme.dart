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
    final TextTheme textTheme =
        Typography.material2021(platform: TargetPlatform.android).black.apply(
          bodyColor: palette.textPrimary,
          displayColor: palette.textPrimary,
        );
    return ThemeData(
      useMaterial3: true,
      materialTapTargetSize: MaterialTapTargetSize.padded,
      brightness: brightness,
      colorScheme: scheme,
      scaffoldBackgroundColor: palette.canvas,
      canvasColor: palette.canvas,
      textTheme: textTheme.copyWith(
        headlineMedium: textTheme.headlineMedium?.copyWith(
          fontWeight: FontWeight.w600,
          letterSpacing: -0.8,
        ),
        titleLarge: textTheme.titleLarge?.copyWith(
          fontWeight: FontWeight.w600,
          letterSpacing: -0.35,
        ),
        bodyLarge: textTheme.bodyLarge?.copyWith(height: 1.48),
        bodyMedium: textTheme.bodyMedium?.copyWith(height: 1.5),
      ),
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
          TargetPlatform.android: PredictiveBackPageTransitionsBuilder(),
        },
      ),
    );
  }
}
