# SentIQ Chat for Android

This directory contains the native Flutter Android client for SentIQ Chat.

## Toolchain

- Flutter `3.44.8` stable
- Dart `3.12.x`
- Android package ID: `com.sentiqlabs.sentiqchat`
- Minimum Android target for the product: API 28

The exact Flutter version is pinned in `.flutter-version`, `.fvmrc`, `pubspec.yaml`, and the GitHub Actions workflow.

## Environments

Builds select an environment with `--dart-define=SENTIQ_ENV=<development|staging|production>`.
Optional endpoint overrides are supported with `--dart-define=SENTIQ_API_BASE=<url>`.

```bash
flutter run --dart-define=SENTIQ_ENV=development
flutter build apk --debug --dart-define=SENTIQ_ENV=development
```

## Android platform scaffold

CI runs `flutter create --platforms=android --org com.sentiqlabs --project-name sentiq_chat --empty .` from this directory before analysis and build. This keeps generated platform files tied to the pinned Flutter SDK during the foundation phase. Native release configuration, signing, adaptive icons, and Play Store metadata are committed in the release-readiness phase.

## Structure

- `lib/app`: application root and dependency wiring
- `lib/core`: configuration, contracts, networking, identity, and design system
- `lib/features`: feature-owned presentation and domain boundaries
- `lib/shared`: reusable product components
- `test/contracts`: backend contract fixture replay
- `test/goldens`: deterministic visual regression tests
