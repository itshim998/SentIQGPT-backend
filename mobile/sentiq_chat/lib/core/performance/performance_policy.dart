import 'dart:io';
import 'dart:ui' show ImageFilter;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

/// Centralized Android performance policy for animation, blur and image memory.
abstract final class SentIQPerformancePolicy {
  static const bool forceLowPerformance = bool.fromEnvironment(
    'SENTIQ_LOW_PERFORMANCE',
    defaultValue: false,
  );

  static const double maximumBlurSigma = 18;
  static const int normalImageCacheBytes = 72 * 1024 * 1024;
  static const int lowImageCacheBytes = 36 * 1024 * 1024;

  static bool get lowPerformanceDevice {
    if (forceLowPerformance) return true;
    // Keep tests and developer builds deterministic. The conservative CPU
    // heuristic is only used by production builds on real Android devices.
    return kReleaseMode &&
        Platform.isAndroid &&
        Platform.numberOfProcessors <= 4;
  }

  static bool reduceMotion(BuildContext context) {
    return MediaQuery.maybeOf(context)?.disableAnimations ??
        WidgetsBinding
            .instance
            .platformDispatcher
            .accessibilityFeatures
            .disableAnimations;
  }

  static bool useLowCostEffects(BuildContext context) {
    return lowPerformanceDevice || reduceMotion(context);
  }

  static Duration motionDuration(BuildContext context, Duration requested) {
    return reduceMotion(context) ? Duration.zero : requested;
  }

  static ImageFilter? glassFilter(BuildContext context, double requestedSigma) {
    if (useLowCostEffects(context) || requestedSigma <= 0) return null;
    final double sigma = requestedSigma.clamp(0, maximumBlurSigma).toDouble();
    return ImageFilter.blur(sigmaX: sigma, sigmaY: sigma);
  }

  static int decodedImageWidth(
    BuildContext context, {
    int normal = 2048,
    int low = 1280,
  }) {
    return useLowCostEffects(context) ? low : normal;
  }

  static void configureImageCache() {
    final ImageCache cache = PaintingBinding.instance.imageCache;
    final bool low = lowPerformanceDevice;
    cache.maximumSize = low ? 96 : 180;
    cache.maximumSizeBytes = low ? lowImageCacheBytes : normalImageCacheBytes;
  }
}
