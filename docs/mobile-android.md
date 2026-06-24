# SentIQ Chat Android Foundation

This repository includes a Capacitor Android foundation for packaging the existing static SentIQ Chat frontend as a native Android app.

## Scope

The Android project is configured for:

- App ID: `com.sentiqlabs.sentiqchat`
- App name: `SentIQ Chat`
- Web asset root: `frontend`
- Bundled app API behavior: uses the deployed backend unless `window.SENTIQ_API_BASE` is explicitly set
- Local browser development: `http://localhost` and `http://127.0.0.1` still use `http://localhost:3001`
- Android native auth callback scheme: `com.sentiqlabs.sentiqchat://auth-callback`
- Android target SDK: API 36

The current Azure backend resource URL still contains `sentiqgpt-backend`. That is a deployed backend identifier, not user-facing app branding, and should not be renamed without a verified backend replacement.

## API Origin And CORS

Capacitor serves the bundled Android WebView from `https://localhost`. That origin is separate from the deployed backend URL and must be allowed by the Azure backend CORS configuration for guest chat, streaming chat, and other API calls to work on Android.

The frontend API-base resolver intentionally sends native Android to the deployed HTTPS backend unless `window.SENTIQ_API_BASE` is explicitly set. Local browser development on `http://localhost` and `http://127.0.0.1` still uses `http://localhost:3001`.

To update the live Azure Container App allowlist, preserve any existing approved origins and include `https://localhost`:

```powershell
$env:RESOURCE_GROUP = "rg-sentiqgpt-prod"
$env:CONTAINER_APP_NAME = "sentiqgpt-backend"
$env:CORS_ORIGINS = "https://sentiqchat.sentiqlabs.com,https://localhost"

az containerapp update `
  --name $env:CONTAINER_APP_NAME `
  --resource-group $env:RESOURCE_GROUP `
  --set-env-vars CORS_ORIGINS=$env:CORS_ORIGINS
```

No Supabase setting is required for guest chat CORS. Supabase redirect allowlist work is still only needed for native auth redirects in the section below.

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

Expected debug output:

```text
android/app/build/outputs/apk/debug/app-debug.apk
```

This validates that the Android project compiles. It does not validate runtime behavior on a device.

## Device Testing

Check connected devices:

```powershell
adb devices
```

Install the debug APK only after confirming an authorized device or emulator is listed:

```powershell
cd android
.\gradlew.bat installDebug
```

Or install the built APK directly:

```powershell
adb install -r app\build\outputs\apk\debug\app-debug.apk
```

If Android Emulator startup reports an AEHD or hypervisor acceleration issue, fix that in Android Studio Device Manager / SDK Manager first. Common checks are: install the latest Android Emulator package, enable Windows Hypervisor Platform or the Android Emulator Hypervisor Driver as appropriate for the machine, reboot after driver changes, then recreate the emulator if the old AVD remains unstable.

## Native Auth Redirects

Email/password auth remains an in-app WebView flow. It should call Supabase `signInWithPassword`, receive a session, update the app auth state, and close the auth modal without opening the hosted web app or a native browser tab.

The Android shell includes native redirect readiness for signup confirmation, password reset, and Google OAuth through:

- `com.sentiqlabs.sentiqchat://auth-callback?auth_mode=signin`
- `com.sentiqlabs.sentiqchat://auth-callback?auth_mode=recovery`
- `com.sentiqlabs.sentiqchat://auth-callback`

Supabase dashboard work is required before native OAuth/password-reset verification:

- Set Site URL to `https://sentiqchat.sentiqlabs.com/`.
- Keep the web redirect URL(s), including `https://sentiqchat.sentiqlabs.com/`.
- Add `com.sentiqlabs.sentiqchat://auth-callback` to Supabase Auth redirect URLs.
- Add `com.sentiqlabs.sentiqchat://auth-callback/` to Supabase Auth redirect URLs.
- In Supabase Auth Providers > Google, keep Google enabled with the Google Cloud client ID and client secret configured.
- In Google Cloud Console, the OAuth client authorized redirect URI must be the Supabase callback URL shown by Supabase for Google, normally `https://<project-ref>.supabase.co/auth/v1/callback`. Do not put the Android custom scheme in Google Cloud; Google returns to Supabase first, then Supabase redirects to the app custom scheme.
- Test both email confirmation and password recovery links on an Android device.
- Test Google OAuth on Android: tap Continue with Google, choose an account in the browser/custom tab, confirm the app reopens, the auth modal closes, and the signed-in account UI appears.

Do not remove existing web redirect URLs for `https://sentiqchat.sentiqlabs.com` or local development.

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

The following remain intentionally deferred for production readiness:

- Keyboard and composer behavior testing on real Android screens.
- Android back button behavior validation on device.
- Supabase OAuth redirect verification for the native Android package.
- File picker, upload, generated-file preview, and download testing on device.
- WebSurf and image generation mobile runtime verification on device.
- Push notifications or other native plugins.
- Privacy policy, account deletion flow, and Play Store Data Safety review.
- Release signing, Play App Signing, and Play Store compliance flow.
- Final adaptive icon and splash artwork.
- Play Store screenshots, feature graphic, listing copy, and support contact review.

## Manual Test Checklist

Run this checklist on an authorized Android device or emulator after `installDebug`:

- Launch: app opens to SentIQ Chat without a blank WebView.
- API base: chat requests go to the deployed backend, not Android WebView `localhost`.
- Login: email/password login succeeds.
- Signup: email signup sends confirmation and the confirmation redirect returns to the app after Supabase allowlist setup.
- Password reset: reset email opens the app and shows the new-password form after Supabase allowlist setup.
- Google OAuth: Google sign-in opens externally and returns to the app after Supabase/Google redirect setup.
- Chat streaming: send, streaming response, stop button, and interrupted response recovery work.
- Sidebar/back: Android back closes image lightbox, composer menu, account menu, settings/trust/auth modal, and mobile sidebar before exiting.
- File upload: Android file picker attaches supported documents/images and rejected files show safe copy.
- Generated files: preview, edit/save for HTML, and download/open behavior work.
- Images: image generation displays result, opens lightbox, and external image open/download path is usable.
- WebSurf: external source links open outside the WebView.
- Modals: settings, billing, memory, trust/support, and auth modals fit narrow screens without horizontal overflow.
