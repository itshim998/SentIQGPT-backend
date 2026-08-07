# SentIQ Chat Android — Android Studio setup and final testing

## Toolchain

Use the versions pinned by the repository:

- Flutter 3.44.8 stable;
- Dart 3.12.x;
- Java 17;
- Android Studio with an SDK that satisfies Flutter's current compile/target SDK;
- Android API 28 device/emulator for minimum-version coverage;
- current API 35 device/emulator for modern behavior.

Open `mobile/sentiq_chat/` as the Flutter project. From that directory run:

```bash
./tool/bootstrap_android.sh
flutter pub get
flutter doctor -v
flutter analyze
flutter test test/core test/features test/widgets
flutter test test/integration
flutter test test/contracts/contract_fixture_replay_test.dart
flutter test test/goldens
```

## Development run

The emulator development endpoint is intentionally the only cleartext exception and exists only in the debug manifest:

```bash
flutter run --dart-define=SENTIQ_ENV=development
```

For production-shaped testing:

```bash
flutter run --release --dart-define=SENTIQ_ENV=production
```

A release run requires `android/key.properties` and a local keystore. Never commit either.

## Local release signing

Create or obtain the organization upload keystore outside the repository. Create `android/key.properties` locally:

```properties
storePassword=<secret>
keyPassword=<secret>
keyAlias=<upload-key-alias>
storeFile=/absolute/path/to/sentiq-upload.jks
```

Then build:

```bash
flutter build apk --release --dart-define=SENTIQ_ENV=production
flutter build appbundle --release --dart-define=SENTIQ_ENV=production
```

Confirm the outputs:

- `build/app/outputs/flutter-apk/app-release.apk`;
- `build/app/outputs/bundle/release/app-release.aab`;
- `build/app/outputs/mapping/release/mapping.txt`.

Verify APK/AAB signatures with the Android build-tools `apksigner` and JDK `jarsigner`. Keep the mapping file with the exact release build.

## Device matrix

At minimum test:

| Device class | Required checks |
| --- | --- |
| API 28 phone | launch, auth, keyboard, chat streaming, files, camera intent, downloads, no cleartext dependency |
| API 35 phone | predictive back, runtime microphone/Bluetooth permissions, adaptive icon/splash, all product flows |
| small/low-performance Android device | forced/automatic low-cost effects, long thread, image-heavy conversation, streaming smoothness |
| tablet/foldable or resizable emulator | rail/drawer adaptation, rotation, multi-width composer, focus/keyboard flow |
| physical device with Bluetooth audio | Live input/output route switching and interruption recovery |

## Functional final pass

1. Fresh install and cold launch in light and dark system themes.
2. Guest conversation, quota presentation, and session-ending behavior.
3. Email sign-in/up, Google OAuth callback, password recovery callback, session restore, and sign-out.
4. Existing conversation recovery; new/rename/delete/search; background/foreground during streaming.
5. Fast and Intuitive messages; stop/retry/continue; Markdown/code/math/table/citation rendering; safe external HTTPS opening.
6. Multiple file/image attachment; cancellation/retry; long/scanned document state; camera-intent capture.
7. Image generation plus zoom, copy, share, save/open and delete.
8. Charts, generated document preview/save/share/open/delete, sanitized HTML edit/save.
9. WebSurf sources/images and partial/error handling.
10. Deep Research start, background recovery, cancel, completion, source open and export.
11. SentIQ Live permission denial/acceptance, speaker/earpiece/Bluetooth routes, interruption, reconnect, transcript commit and quota.
12. Billing catalog, Razorpay cancel/failure/success, backend verification, usage refresh and subscription cancellation.
13. Memory deletion, temporary/local data clearing, privacy/terms/support, sign-out cleanup.
14. Airplane/offline/degraded recovery and server error/quota states.
15. TalkBack traversal and labels, 200%+ text, reduced motion, keyboard focus order, 48 dp targets.

## Performance pass

Run a profile build with `SENTIQ_PERFORMANCE_TRACE=true`, record a cold launch, a 1,000-message thread, an ordinary streamed response, a code-heavy response, and an image-heavy conversation in DevTools. Repeat once with `SENTIQ_LOW_PERFORMANCE=true` and confirm blur/continuous motion are removed without disabling features.

## Play preflight

Before uploading the AAB, verify versionCode/versionName, application ID, upload-key certificate, privacy-policy URL, Data Safety answers, content rating, screenshots/icon/feature graphic, declared microphone/Bluetooth use, Supabase redirect allowlist, production backend health, and a closed/internal Play track install. Promote only the exact AAB whose CI and physical-device evidence passed.
