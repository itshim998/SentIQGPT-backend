# SentIQ Chat Android Foundation

This repository now includes a Capacitor Android foundation for packaging the existing static SentIQ Chat frontend as a native Android app.

## Scope

This is Phase 2 foundation work only. The Android project is configured for:

- App ID: `com.sentiqlabs.sentiqchat`
- App name: `SentIQ Chat`
- Web asset root: `frontend`
- Bundled app API behavior: uses the deployed backend unless `window.SENTIQ_API_BASE` is explicitly set
- Local browser development: `http://localhost` and `http://127.0.0.1` still use `http://localhost:3001`

The current Azure backend resource URL still contains `sentiqgpt-backend`. That is a deployed backend identifier, not user-facing app branding, and should not be renamed without a verified backend replacement.

## Prerequisites

- Node.js 22+ and npm for Capacitor 8 commands
- Android Studio
- Android SDK
- Android SDK platform-tools
- Java/JDK available to Gradle, usually via Android Studio's bundled JDK

Capacitor's current Android tooling expects a modern Android Studio and Android SDK installation. Use Android Studio SDK Manager to install at least one Android SDK Platform and platform-tools.

## Install

Install JavaScript dependencies:

```powershell
npm.cmd install
```

If PowerShell blocks `npx`, use `npx.cmd` directly:

```powershell
npx.cmd cap --version
```

## Sync Web Assets

The app uses the tracked static frontend directly. After changing files under `frontend/`, sync them into Android:

```powershell
npm.cmd run android:sync
```

Equivalent direct command:

```powershell
npx.cmd cap sync android
```

## Open Android Studio

Open the native Android project:

```powershell
npm.cmd run android:open
```

Equivalent direct command:

```powershell
npx.cmd cap open android
```

## Debug Build

Build a local debug APK without installing to a phone or emulator:

```powershell
npm.cmd run android:build
```

Equivalent direct command:

```powershell
cd android
.\gradlew.bat assembleDebug
```

This does not validate runtime behavior on a device. Device and emulator installs are deferred to the next mobile validation pass.

## Future Release AAB

Release signing is intentionally not configured in this pass. Future release work should create a private keystore outside the repository and wire signing through local Gradle properties or CI secrets.

Future AAB build command after signing is configured:

```powershell
npm.cmd run android:build:aab
```

Equivalent direct command:

```powershell
cd android
.\gradlew.bat bundleRelease
```

## Placeholder Assets

The Android project includes basic XML placeholder launcher and splash assets using SentIQ Chat colors. These are not final Play Store assets.

TODO for a later branding pass:

- Generate final adaptive launcher icon foreground/background assets.
- Generate final splash screen artwork.
- Add Play Store icon, feature graphic, screenshots, and listing artwork.

## Deferred Work

Do not treat this foundation pass as full mobile readiness. The following remain intentionally deferred:

- Keyboard and composer behavior testing on real Android screens.
- Android back button behavior.
- Supabase OAuth redirect verification for the native Android package.
- File picker, upload, generated-file preview, and download testing.
- WebSurf and image generation mobile runtime verification.
- Push notifications or other native plugins.
- Privacy policy, account deletion flow, and Play Store Data Safety review.
- Release signing, Play App Signing, and Play Store compliance flow.
