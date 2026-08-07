# SentIQ Chat Android — Phase 6 performance report

## Performance budget

Phase 6 optimizes perceived startup and streaming smoothness without changing model quality, backend routing, or response semantics. The application keeps expensive visual work bounded and exposes opt-in Flutter timeline markers for profile-mode diagnosis.

| Area | Release policy / evidence |
| --- | --- |
| Startup | Android splash is native and immediate; `SENTIQ_PERFORMANCE_TRACE=true` emits `sentiq.first_flutter_frame` in the Flutter timeline. Emulator CI captures Android cold-start `am start -W` evidence on API 28 and API 35. |
| Streaming | token fragments are coalesced by `TokenBatcher` on a 32 ms interval rather than forcing a widget rebuild for every provider fragment; opt-in `sentiq.frame_timing` timeline events expose build/raster/total frame duration during real streamed responses. |
| Long threads | `ChatMessageList` is builder-virtualized with repaint boundaries and automatic keep-alives disabled. The 1,000-message regression requires fewer than 80 message views mounted at once. |
| Images | generated/remote image decode width is capped; thumbnail decode widths are bounded; the global image cache is capped at 72 MiB/180 entries normally and 36 MiB/96 entries in low-performance production mode. The image-heavy regression mounts 120 rich messages while requiring fewer than 30 rich message extras mounted. |
| Blur | refractive surfaces cap blur sigma at 18. Low-performance or reduced-motion mode removes backdrop blur and secondary glass shadows entirely. |
| Motion | OS reduced-motion removes launch pulsing, loading rotation, streaming caret fading, animated chat auto-scroll, and route/theme switching duration. |
| Low-performance fallback | production Android devices at four logical processors or fewer use the low-cost effects/image-cache path automatically. CI can force the same path with `SENTIQ_LOW_PERFORMANCE=true`. |

## Automated regressions

The authoritative release gate runs:

- `test/features/chat/token_batcher_test.dart` — rapid fragments collapse into one render update;
- `test/features/chat/chat_message_virtualization_test.dart` — 1,000-message lazy thread;
- `test/features/multimodal/memory_pressure_test.dart` — image-heavy long-report lazy mounting;
- `test/core/performance/low_performance_smoke_test.dart` — reduced-motion and forced low-performance blur fallback;
- complete widget/integration/golden coverage so performance changes cannot silently alter core workflows.

## Profile-mode procedure

For physical-device profiling, run:

```bash
flutter run --profile \
  --dart-define=SENTIQ_ENV=production \
  --dart-define=SENTIQ_PERFORMANCE_TRACE=true
```

In Flutter DevTools Performance:

1. record a cold app launch and locate `sentiq.first_flutter_frame`;
2. open a long existing thread, scroll from newest to older messages, and check for sustained jank;
3. send a normal Fast message and record from first streamed token through completion;
4. repeat with a response containing Markdown/code and with generated images;
5. inspect `sentiq.frame_timing` markers plus Flutter frame charts;
6. rerun with `--dart-define=SENTIQ_LOW_PERFORMANCE=true` to verify the fallback path.

Acceptance targets are no repeated jank clusters during ordinary streaming, no unbounded growth in mounted long-thread children, no unbounded decoded-image cache, and no visible loss of interaction capability in low-performance mode. Device/OEM numbers are recorded during the final physical-device pass because host CI timing is not representative of user hardware.

## Result

The source and automated regressions satisfy the Phase 6 performance architecture: bounded streaming updates, virtualization, image-memory limits, blur budget, reduced-motion support, and a deterministic low-performance fallback. Physical profile numbers are release evidence rather than hard-coded product claims and should be captured for each candidate device in the Android Studio final-testing pass.
