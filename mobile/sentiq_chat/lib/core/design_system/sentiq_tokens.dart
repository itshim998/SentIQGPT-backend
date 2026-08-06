import 'package:flutter/material.dart';

abstract final class SentIQSpacing {
  static const double xxs = 4;
  static const double xs = 8;
  static const double sm = 12;
  static const double md = 16;
  static const double lg = 24;
  static const double xl = 32;
  static const double xxl = 48;
}

abstract final class SentIQRadii {
  static const double small = 10;
  static const double medium = 16;
  static const double large = 24;
  static const double pill = 999;
}

abstract final class SentIQMotion {
  static const Duration quick = Duration(milliseconds: 140);
  static const Duration standard = Duration(milliseconds: 240);
  static const Duration relaxed = Duration(milliseconds: 360);
  static const Curve emphasized = Cubic(0.2, 0.85, 0.2, 1);
}

@immutable
class SentIQPalette extends ThemeExtension<SentIQPalette> {
  const SentIQPalette({
    required this.canvas,
    required this.surface,
    required this.surfaceElevated,
    required this.glass,
    required this.glassBorder,
    required this.textPrimary,
    required this.textSecondary,
    required this.textMuted,
    required this.accent,
    required this.accentSoft,
    required this.info,
    required this.success,
    required this.warning,
    required this.danger,
  });

  static const SentIQPalette dark = SentIQPalette(
    canvas: Color(0xFF080A10),
    surface: Color(0xFF11131C),
    surfaceElevated: Color(0xFF181A26),
    glass: Color(0x1FFFFFFF),
    glassBorder: Color(0x2EFFFFFF),
    textPrimary: Color(0xFFF4F1FA),
    textSecondary: Color(0xFFB4AEC2),
    textMuted: Color(0xFF787286),
    accent: Color(0xFF9874E8),
    accentSoft: Color(0x299874E8),
    info: Color(0xFF7EB9D8),
    success: Color(0xFF72B58B),
    warning: Color(0xFFD5A967),
    danger: Color(0xFFD77A82),
  );

  static const SentIQPalette light = SentIQPalette(
    canvas: Color(0xFFF5F4F1),
    surface: Color(0xFFFCFBF8),
    surfaceElevated: Color(0xFFFFFFFF),
    glass: Color(0xBFFFFFFF),
    glassBorder: Color(0x66FFFFFF),
    textPrimary: Color(0xFF24232A),
    textSecondary: Color(0xFF615D69),
    textMuted: Color(0xFF8B8791),
    accent: Color(0xFF67558F),
    accentSoft: Color(0x1F67558F),
    info: Color(0xFF4E748C),
    success: Color(0xFF4D7C60),
    warning: Color(0xFF946F37),
    danger: Color(0xFF9A4F58),
  );

  final Color canvas;
  final Color surface;
  final Color surfaceElevated;
  final Color glass;
  final Color glassBorder;
  final Color textPrimary;
  final Color textSecondary;
  final Color textMuted;
  final Color accent;
  final Color accentSoft;
  final Color info;
  final Color success;
  final Color warning;
  final Color danger;

  @override
  SentIQPalette copyWith({
    Color? canvas,
    Color? surface,
    Color? surfaceElevated,
    Color? glass,
    Color? glassBorder,
    Color? textPrimary,
    Color? textSecondary,
    Color? textMuted,
    Color? accent,
    Color? accentSoft,
    Color? info,
    Color? success,
    Color? warning,
    Color? danger,
  }) {
    return SentIQPalette(
      canvas: canvas ?? this.canvas,
      surface: surface ?? this.surface,
      surfaceElevated: surfaceElevated ?? this.surfaceElevated,
      glass: glass ?? this.glass,
      glassBorder: glassBorder ?? this.glassBorder,
      textPrimary: textPrimary ?? this.textPrimary,
      textSecondary: textSecondary ?? this.textSecondary,
      textMuted: textMuted ?? this.textMuted,
      accent: accent ?? this.accent,
      accentSoft: accentSoft ?? this.accentSoft,
      info: info ?? this.info,
      success: success ?? this.success,
      warning: warning ?? this.warning,
      danger: danger ?? this.danger,
    );
  }

  @override
  SentIQPalette lerp(ThemeExtension<SentIQPalette>? other, double t) {
    if (other is! SentIQPalette) return this;
    return SentIQPalette(
      canvas: Color.lerp(canvas, other.canvas, t)!,
      surface: Color.lerp(surface, other.surface, t)!,
      surfaceElevated: Color.lerp(surfaceElevated, other.surfaceElevated, t)!,
      glass: Color.lerp(glass, other.glass, t)!,
      glassBorder: Color.lerp(glassBorder, other.glassBorder, t)!,
      textPrimary: Color.lerp(textPrimary, other.textPrimary, t)!,
      textSecondary: Color.lerp(textSecondary, other.textSecondary, t)!,
      textMuted: Color.lerp(textMuted, other.textMuted, t)!,
      accent: Color.lerp(accent, other.accent, t)!,
      accentSoft: Color.lerp(accentSoft, other.accentSoft, t)!,
      info: Color.lerp(info, other.info, t)!,
      success: Color.lerp(success, other.success, t)!,
      warning: Color.lerp(warning, other.warning, t)!,
      danger: Color.lerp(danger, other.danger, t)!,
    );
  }
}

extension SentIQThemeContext on BuildContext {
  SentIQPalette get sentiqPalette =>
      Theme.of(this).extension<SentIQPalette>() ?? SentIQPalette.dark;
}
