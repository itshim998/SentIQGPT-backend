# SentIQ Chat for Android

This directory contains the native Flutter Android client for SentIQ Chat.

## Toolchain

- Flutter `3.44.8` stable
- Dart `3.12.x`
- Android package ID: `com.sentiqlabs.sentiqchat`
- Minimum Android target: API 28

The exact Flutter version is pinned in `.flutter-version`, `.fvmrc`, `pubspec.yaml`, and the GitHub Actions workflow.

## Environments

Builds select an environment with `--dart-define=SENTIQ_ENV=<development|staging|production>`.
Optional endpoint and Supabase overrides are supported with:

- `SENTIQ_API_BASE`
- `SENTIQ_SUPABASE_URL`
- `SENTIQ_SUPABASE_PUBLISHABLE_KEY`

```bash
flutter run --dart-define=SENTIQ_ENV=development
flutter build apk --debug --dart-define=SENTIQ_ENV=development
```

## Android platform scaffold

Run `./tool/bootstrap_android.sh` after checking out the repository. CI runs the same script before analysis and build. It generates the pinned Android platform files, applies `com.sentiqlabs.sentiqchat`, enforces API 28+, enables keyboard resize and predictive back support, disables Android backup for session safety, and registers the login and password-recovery deep links.

The following redirect URLs must remain allowed in Supabase Authentication URL Configuration:

- `com.sentiqlabs.sentiqchat://login-callback/**`
- `com.sentiqlabs.sentiqchat://reset-callback/**`

Supabase Flutter is initialized with PKCE and automatic session detection from incoming links.

## Structure

- `lib/app`: application root and dependency wiring
- `lib/core`: configuration, contracts, networking, identity, layout, preferences, and design system
- `lib/features/auth`: auth gateway, state machine, and native auth screens
- `lib/features/workspace`: SQLite cache, cloud reconciliation, conversation shell, and adaptive navigation
- `lib/shared`: reusable product components
- `test/contracts`: backend contract fixture replay
- `test/integration`: keyboard, rotation, callback, and navigation flows
- `test/goldens`: deterministic visual regression tests
