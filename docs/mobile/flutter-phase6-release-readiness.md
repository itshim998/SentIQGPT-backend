# SentIQ Chat Android — Phase 6 release readiness

## Status

Phase 6 closes the Flutter Android implementation for production packaging and release verification. The native client now has explicit accessibility, performance, security, packaging, automated verification, and Play-readiness boundaries instead of relying on development defaults.

## Product polish

- Dark and light themes use the same restrained SentIQ design system, with WCAG-AA contrast checks for primary, secondary, and muted text.
- The temporary foundation gallery has been removed from production source.
- Android startup now uses the SentIQ Chat mark and theme-aware splash instead of the Flutter placeholder.
- Adaptive launcher resources are committed for every supported API 28+ device.
- Empty, loading, error, permission, quota, research, Live, billing, file, image, chart, and account states remain product-language states rather than protocol/debug output.

## Accessibility

The release gate verifies the following policies:

- icon and button targets are at least 48 dp;
- screen-reader-visible loading/error state uses semantic labels and live regions;
- application focus traversal follows reading order;
- primary/supporting text meets a 4.5:1 contrast floor against the principal canvas in both themes;
- 200% text scaling remains usable in the shared interaction surfaces;
- Android/Flutter reduced-motion preference disables continuous loading/caret/launch animation and animated auto-scroll;
- predictive back, keyboard resize, safe areas, foldable/tablet layouts, and adaptive navigation remain covered by the existing integration suite.

## Security boundary

- Supabase session material is persisted through `flutter_secure_storage`; plaintext SharedPreferences is not used for the auth session.
- Production and staging API/Supabase overrides must use credential-free HTTPS addresses.
- Android cleartext traffic is disabled in the production manifest and network-security configuration. Development retains a debug-only cleartext exception for the Android emulator host.
- Model- or user-provided external navigation is centralized in `SafeExternalLink` and accepts credential-free HTTPS only. The support email handoff is an explicit separate path.
- Generated HTML remains sanitized and non-executing; unsafe navigation schemes remain rejected.
- Android backup is disabled so encrypted session material is not restored independently of its device-bound key material.
- No release key, `key.properties`, service-role secret, provider private key, or payment secret is tracked in source control.
- Production release builds enable R8 code shrinking and resource shrinking, with mapping output retained as a release artifact.
- Release logging is intentionally quiet: application source contains no `print` or `debugPrint` calls, and performance markers are opt-in profile-mode timeline events rather than production logs.

## Android permissions

The main manifest declares only permissions required by shipped functionality:

| Permission | Purpose |
| --- | --- |
| `INTERNET` | SentIQ Chat API, Supabase auth, streamed responses, remote content |
| `RECORD_AUDIO` | SentIQ Live microphone input; requested at runtime only when Live is started |
| `MODIFY_AUDIO_SETTINGS` | Live speaker/earpiece/audio-route control |
| `BLUETOOTH_CONNECT` | Live Bluetooth communication-route selection on supported Android versions |

`CAMERA` is deliberately not declared. Image capture is delegated to the Android camera intent through the image picker, avoiding a standing camera permission. No broad storage permission is declared; files use scoped pickers, MediaStore, and the app-scoped/FileProvider boundary.

## Signing and release packaging

`android/app/build.gradle.kts` never falls back to the debug key for a release build. When `android/key.properties` is present it loads an external keystore and builds a signed, minified release. Automated verification creates an ephemeral verification keystore so every candidate proves that both APK and AAB release packaging and signature verification succeed without putting a distribution key in the repository.

The AAB verifier uses the exact ephemeral keystore as the trust source for `jarsigner -verify -strict`; this avoids treating the expected self-signed verification certificate as an untrusted-chain failure while still failing on an unexpected signer.

For Play distribution, use the organization-owned upload key and keep these values outside source control:

- keystore file;
- store password;
- key alias;
- key password.

The reusable GitHub workflow supports repository/environment secrets for a store-signed manual build when hosted Actions are available. Google Play App Signing should retain the app-signing key; SentIQ AI Labs should retain the upload-key backup and recovery documentation separately.

## Play Store readiness checklist

- [x] stable application ID `com.sentiqlabs.sentiqchat`;
- [x] version advanced to the 1.0 release line;
- [x] API 28 minimum and current Flutter target SDK;
- [x] adaptive launcher icon resources for supported API 28+ devices;
- [x] theme-aware pre-Android-12 and Android-12+ splash;
- [x] no debug signing fallback in release;
- [x] R8/minification and resource shrinking enabled;
- [x] cleartext production networking disabled;
- [x] dangerous permissions minimized and documented;
- [x] privacy/data/account controls available in product;
- [x] release mapping, APK, AAB, signature evidence, coverage, and emulator evidence are defined by the automated release gate;
- [x] source/secret/logging hygiene is enforced by the automated release gate;
- [ ] final Play Console listing, screenshots, content rating, Data Safety declarations, privacy-policy URL, and organization upload key are operator-owned publishing steps.

The final unchecked item is not an application-code gap: it requires SentIQ AI Labs' Play Console account and publishing credentials.

## Release acceptance rule

A Phase 6 build is accepted only when one of the two equivalent automated gates completes successfully against the exact PR head intended for merge:

1. the GitHub-hosted `Flutter Android Release Readiness` workflow is green; or
2. `mobile/sentiq_chat/tool/phase6_local_release.ps1 -RunEmulators` produces a `phase6-manifest.json` with `result: "PASS"` and `git.headSha` equal to that PR head.

Both routes require Flutter analysis/tests, backend compatibility, source/security checks, low-performance coverage, verification-signed minified APK/AAB generation, strict signature verification, API 28 emulator startup/lifecycle smoke, and API 35 emulator startup/lifecycle smoke. A `PARTIAL` local result is never merge-eligible.

The zero-Actions local procedure and evidence format are documented in `docs/mobile/phase6-local-release-verification.md`.

Store submission additionally requires an organization-upload-key-signed candidate plus the operator-owned physical-device and Play Console checks documented in `docs/mobile/android-studio-final-testing.md`.
