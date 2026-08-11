import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:sentiq_chat/app/app_providers.dart';
import 'package:sentiq_chat/core/design_system/sentiq_tokens.dart';
import 'package:sentiq_chat/features/live/application/live_controller.dart';
import 'package:sentiq_chat/features/live/domain/live_models.dart';
import 'package:sentiq_chat/shared/widgets/refractive_glass_surface.dart';
import 'package:sentiq_chat/shared/widgets/sentiq_button.dart';

class LiveScreen extends ConsumerStatefulWidget {
  const LiveScreen({required this.conversationId, super.key});

  final String conversationId;

  @override
  ConsumerState<LiveScreen> createState() => _LiveScreenState();
}

class _LiveScreenState extends ConsumerState<LiveScreen>
    with WidgetsBindingObserver {
  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    unawaited(ref.read(liveControllerProvider.notifier).handleLifecycle(state));
  }

  @override
  Widget build(BuildContext context) {
    final LiveState state = ref.watch(liveControllerProvider);
    final LiveController controller = ref.read(liveControllerProvider.notifier);
    return PopScope(
      canPop: !state.active,
      onPopInvokedWithResult: (bool didPop, Object? result) {
        if (!didPop) {
          final NavigatorState navigator = Navigator.of(context);
          unawaited(
            controller.end(reason: 'navigation').then((_) {
              if (mounted) navigator.pop();
            }),
          );
        }
      },
      child: Scaffold(
        appBar: AppBar(
          title: const Text('SentIQ Live'),
          actions: <Widget>[
            if (state.routes.isNotEmpty)
              PopupMenuButton<int>(
                tooltip: 'Choose audio route',
                icon: const Icon(Icons.headphones_rounded),
                onSelected: (int id) => unawaited(controller.selectRoute(id)),
                itemBuilder: (_) => state.routes
                    .map(
                      (LiveAudioRoute route) => CheckedPopupMenuItem<int>(
                        value: route.id,
                        checked:
                            route.selected || state.selectedRouteId == route.id,
                        child: Text(route.label),
                      ),
                    )
                    .toList(growable: false),
              ),
          ],
        ),
        body: SafeArea(
          child: Column(
            children: <Widget>[
              Expanded(
                child: ListView(
                  padding: const EdgeInsets.all(SentIQSpacing.md),
                  children: <Widget>[
                    Center(
                      child: _LiveOrb(
                        level: state.audioLevel,
                        active: state.connection == LiveConnectionState.active,
                      ),
                    ),
                    const SizedBox(height: SentIQSpacing.lg),
                    Center(
                      child: Text(
                        _connectionLabel(state.connection),
                        style: Theme.of(context).textTheme.titleMedium,
                      ),
                    ),
                    const SizedBox(height: SentIQSpacing.xs),
                    Center(
                      child: Text(
                        state.active
                            ? _duration(state.remainingSeconds)
                            : '${_duration(state.status.remainingSecondsToday)} available today',
                        style: Theme.of(context).textTheme.bodySmall,
                      ),
                    ),
                    if (state.message != null) ...<Widget>[
                      const SizedBox(height: SentIQSpacing.md),
                      Text(
                        state.message!,
                        textAlign: TextAlign.center,
                        style: TextStyle(color: context.sentiqPalette.warning),
                      ),
                    ],
                    if (state.transcript.isNotEmpty) ...<Widget>[
                      const SizedBox(height: SentIQSpacing.lg),
                      RefractiveGlassSurface(
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.stretch,
                          children: <Widget>[
                            Text(
                              'Transcript',
                              style: Theme.of(context).textTheme.titleSmall,
                            ),
                            const SizedBox(height: SentIQSpacing.sm),
                            for (final LiveTranscriptTurn turn
                                in state.transcript)
                              _TranscriptBubble(turn: turn),
                          ],
                        ),
                      ),
                    ],
                  ],
                ),
              ),
              Padding(
                padding: const EdgeInsets.all(SentIQSpacing.md),
                child:
                    state.active ||
                        state.connection == LiveConnectionState.connecting ||
                        state.connection == LiveConnectionState.waitingForSetup
                    ? SentIQButton(
                        label: state.connection == LiveConnectionState.ending
                            ? 'Ending…'
                            : 'End Live session',
                        style: SentIQButtonStyle.secondary,
                        expand: true,
                        onPressed:
                            state.connection == LiveConnectionState.ending
                            ? null
                            : () => unawaited(controller.end()),
                      )
                    : SentIQButton(
                        label: 'Start SentIQ Live',
                        expand: true,
                        onPressed:
                            state.status.available ||
                                state.connection == LiveConnectionState.idle ||
                                state.connection ==
                                    LiveConnectionState.failed ||
                                state.connection == LiveConnectionState.ended
                            ? () => unawaited(
                                controller.start(widget.conversationId),
                              )
                            : null,
                      ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    super.dispose();
  }
}

class _LiveOrb extends StatelessWidget {
  const _LiveOrb({required this.level, required this.active});

  final double level;
  final bool active;

  @override
  Widget build(BuildContext context) {
    final double normalized = level.clamp(0, 1).toDouble();
    final double size = 152 + normalized * 24;
    final SentIQPalette palette = context.sentiqPalette;
    return SizedBox(
      width: 210,
      height: 210,
      child: Stack(
        alignment: Alignment.center,
        children: <Widget>[
          AnimatedContainer(
            duration: const Duration(milliseconds: 90),
            width: size,
            height: size,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              gradient: RadialGradient(
                colors: <Color>[
                  palette.accent.withValues(alpha: active ? 0.72 : 0.24),
                  palette.info.withValues(alpha: active ? 0.34 : 0.12),
                  Colors.transparent,
                ],
              ),
              border: Border.all(
                color: palette.glassBorder.withValues(alpha: 0.9),
              ),
              boxShadow: <BoxShadow>[
                BoxShadow(
                  blurRadius: 38 + normalized * 20,
                  spreadRadius: normalized * 8,
                  color: palette.accent.withValues(
                    alpha: active ? 0.18 + normalized * 0.16 : 0.08,
                  ),
                ),
              ],
            ),
          ),
          CustomPaint(
            size: const Size(190, 72),
            painter: _WaveformPainter(
              level: normalized,
              color: palette.textPrimary,
            ),
          ),
        ],
      ),
    );
  }
}

class _WaveformPainter extends CustomPainter {
  const _WaveformPainter({required this.level, required this.color});

  final double level;
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final Paint paint = Paint()
      ..color = color.withValues(alpha: 0.72)
      ..strokeWidth = 2
      ..strokeCap = StrokeCap.round;
    const int bars = 17;
    final double spacing = size.width / bars;
    for (int index = 0; index < bars; index += 1) {
      final double envelope = math.sin((index + 1) / (bars + 1) * math.pi);
      final double movement = 0.16 + level * (0.45 + envelope * 0.55);
      final double height = size.height * movement * envelope;
      final double x = spacing * index + spacing / 2;
      canvas.drawLine(
        Offset(x, size.height / 2 - height / 2),
        Offset(x, size.height / 2 + height / 2),
        paint,
      );
    }
  }

  @override
  bool shouldRepaint(covariant _WaveformPainter oldDelegate) {
    return oldDelegate.level != level || oldDelegate.color != color;
  }
}

class _TranscriptBubble extends StatelessWidget {
  const _TranscriptBubble({required this.turn});

  final LiveTranscriptTurn turn;

  @override
  Widget build(BuildContext context) {
    final bool user = turn.role == LiveTranscriptRole.user;
    return Align(
      alignment: user ? Alignment.centerRight : Alignment.centerLeft,
      child: Container(
        constraints: const BoxConstraints(maxWidth: 560),
        margin: const EdgeInsets.only(bottom: SentIQSpacing.xs),
        padding: const EdgeInsets.symmetric(
          horizontal: SentIQSpacing.sm,
          vertical: SentIQSpacing.xs,
        ),
        decoration: BoxDecoration(
          color: user
              ? context.sentiqPalette.accent.withValues(alpha: 0.16)
              : context.sentiqPalette.surfaceElevated,
          borderRadius: BorderRadius.circular(16),
        ),
        child: Text(
          turn.text,
          style: TextStyle(
            color: turn.finalized
                ? context.sentiqPalette.textPrimary
                : context.sentiqPalette.textSecondary,
          ),
        ),
      ),
    );
  }
}

String _connectionLabel(LiveConnectionState state) {
  return switch (state) {
    LiveConnectionState.idle => 'Ready when you are',
    LiveConnectionState.requestingPermission => 'Checking microphone access…',
    LiveConnectionState.connecting => 'Creating a secure Live session…',
    LiveConnectionState.waitingForSetup => 'Connecting audio…',
    LiveConnectionState.active => 'Listening',
    LiveConnectionState.reconnecting => 'Reconnecting…',
    LiveConnectionState.suspended => 'Audio paused',
    LiveConnectionState.ending => 'Saving transcript…',
    LiveConnectionState.ended => 'Session complete',
    LiveConnectionState.failed => 'Live could not start',
  };
}

String _duration(int seconds) {
  final int safe = seconds < 0 ? 0 : seconds;
  final int minutes = safe ~/ 60;
  final int remainder = safe % 60;
  return '$minutes:${remainder.toString().padLeft(2, '0')}';
}
