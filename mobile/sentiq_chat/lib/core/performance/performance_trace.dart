import 'dart:developer' as developer;

import 'package:flutter/scheduler.dart';
import 'package:flutter/widgets.dart';

/// Opt-in profile markers. There is no production logging cost unless the
/// `SENTIQ_PERFORMANCE_TRACE` dart define is enabled for a profile build.
abstract final class SentIQPerformanceTrace {
  static const bool enabled = bool.fromEnvironment(
    'SENTIQ_PERFORMANCE_TRACE',
    defaultValue: false,
  );

  static final Stopwatch _startup = Stopwatch();
  static bool _frameTracingInstalled = false;

  static void beginStartup() {
    if (!enabled) return;
    _startup
      ..reset()
      ..start();
  }

  static void markFirstFlutterFrame() {
    if (!enabled) return;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      _startup.stop();
      developer.Timeline.instantSync(
        'sentiq.first_flutter_frame',
        arguments: <String, Object?>{
          'elapsed_ms': _startup.elapsedMilliseconds,
        },
      );
    });
  }

  static void installFrameTimingTrace() {
    if (!enabled || _frameTracingInstalled) return;
    _frameTracingInstalled = true;
    SchedulerBinding.instance.addTimingsCallback((List<FrameTiming> timings) {
      for (final FrameTiming timing in timings) {
        developer.Timeline.instantSync(
          'sentiq.frame_timing',
          arguments: <String, Object?>{
            'build_us': timing.buildDuration.inMicroseconds,
            'raster_us': timing.rasterDuration.inMicroseconds,
            'total_us': timing.totalSpan.inMicroseconds,
          },
        );
      }
    });
  }
}
