# SentIQ Chat Android — local Phase 6 release verification

This is the zero-GitHub-Actions release gate for the native Android client. It exists so Phase 6 can be verified on a developer workstation without weakening the acceptance criteria when GitHub-hosted jobs are unavailable.

## What the verifier proves

`mobile/sentiq_chat/tool/phase6_local_release.ps1` replays the release-readiness workflow against one exact Git commit and fails closed on any error.

It verifies:

- exact Flutter 3.44.8, Java 17 and Node 20.20.2 executables plus Android SDK/build-tools availability;
- clean tracked working tree and exact HEAD capture;
- deterministic Android scaffold bootstrap and locked Flutter dependency resolution;
- Dart formatting and Flutter static analysis;
- forced low-performance regression;
- unit, widget, accessibility, security and feature tests with coverage;
- navigation/adaptive integration tests;
- contract fixture replay and golden tests;
- source, secret, logging, transport, permission, secure-storage and R8 release boundaries;
- debug APK generation for emulator verification;
- `npm ci`, high-severity dependency audit, backend compilation and the full mobile backend compatibility set used by CI;
- minified production APK and AAB generation;
- production R8 `mapping.txt` generation;
- APK certificate verification with Android `apksigner`;
- strict AAB signature verification against the exact disposable verification keystore;
- SHA-256 checksums for APK, AAB and mapping output;
- API 28 and API 35 clean-boot emulator install, cold start, process-survival, force-stop/restart and fatal-logcat checks when `-RunEmulators` is supplied;
- a clean tracked working tree again after verification.

A full merge-eligible run ends with `result: "PASS"` in `phase6-manifest.json`. Runs that intentionally skip backend verification or omit the emulator matrix are marked `PARTIAL`, never `PASS`.

## Workstation prerequisites

Use Windows with:

- Git for Windows, including Git Bash;
- Android Studio / Android SDK;
- **Android SDK Command-line Tools (latest)**;
- Android virtualization enabled so x86_64 emulators can boot.

Flutter, Node and JDK 17 do **not** need to be installed globally. The launcher selects the exact required versions or bootstraps private toolchains under `%LOCALAPPDATA%\SentIQ\toolchains`: Flutter 3.44.8 from the official Windows stable archive, Node 20.20.2 from nodejs.org and Eclipse Temurin JDK 17 from Adoptium metadata. It also caches the official Gradle 9.1.0 distribution and seeds the standard wrapper cache so Java does not need to follow an external download redirect. Every download is checked against its official SHA-256 source before extraction or execution. Toolchain archives and valid extracted installations are cached, and only the verifier process receives the private `PATH`, `JAVA_HOME`, Git ownership exception, Flutter JDK configuration and analytics-suppression environment.

Before downloading a toolchain, the launcher performs a lightweight workstation preflight and reports missing Git/Git Bash, Android SDK or SDK Command-line Tools together. It then verifies the exact selected `node`, `npm`, `npx`, `java`, `keytool`, `jarsigner`, `flutter` and Flutter-bundled `dart` executables before starting the release gate. `flutter doctor --verbose` and `gradlew --version` evidence must show the selected Temurin JDK 17; Android Studio's bundled JBR is not accepted as a silent fallback.

The script locates the Android SDK from `ANDROID_SDK_ROOT`, `ANDROID_HOME`, or the normal `%LOCALAPPDATA%\Android\Sdk` location. It accepts SDK licenses non-interactively, then uses `sdkmanager` to ensure the Flutter 3.44.8 platform/build-tools/NDK requirements plus the API 28/API 35 Google APIs x86_64 system images. A manual license step is only necessary if the installed SDK rejects safe non-interactive acceptance.

## Preferred one-command gate

After checking out and pulling the intended PR branch, use the exact PR head SHA supplied for the release candidate:

```powershell
.\mobile\sentiq_chat\tool\phase6_local_release.cmd <expected-pr-head-sha>
```

The `.cmd` wrapper always enables the complete backend gate and API 28/API 35 emulator matrix. It forwards the supplied SHA to the PowerShell verifier, which refuses to run if local `HEAD` differs.

On the first successful workstation setup, the command can spend several minutes downloading/extracting private toolchains and Android emulator images. Subsequent runs reuse verified toolchains, archives and installed Android packages.

## Direct PowerShell gate

The equivalent direct invocation from the repository root is:

```powershell
git status --short
git pull --ff-only
$head = git rev-parse HEAD
powershell -NoProfile -ExecutionPolicy Bypass -File .\mobile\sentiq_chat\tool\phase6_local_release.ps1 -RunEmulators -ExpectedHeadSha $head
```

For PowerShell 7, `pwsh` can be used instead of `powershell`.

Do not edit tracked files between capturing the approved release-candidate SHA and running the verifier. If the branch changes after a successful run, the evidence is stale and the full verifier must be rerun on the new head.

## Evidence bundle

Each run writes an ignored local directory:

```text
phase6-evidence/<UTC timestamp>-<12-char commit>/
```

A successful full run contains at least:

```text
phase6-manifest.json
phase6-local-verification.log
apk-signature.txt
aab-signature.txt
android-licenses.txt
android-sdk-packages.txt
flutter-doctor.txt
gradle-wrapper.txt
lcov.info
release-artifacts/app-release.apk
release-artifacts/app-release.aab
release-artifacts/mapping.txt
emulator-api-28/install.txt
emulator-api-28/start.txt
emulator-api-28/restart.txt
emulator-api-28/logcat.txt
emulator-api-35/install.txt
emulator-api-35/start.txt
emulator-api-35/restart.txt
emulator-api-35/logcat.txt
```

`phase6-manifest.json` is the authoritative summary. Confirm all of the following before treating the branch as merge-eligible:

- `result` is `PASS`;
- `git.headSha` is the exact PR head intended for merge;
- `checks.flutterQuality` is `PASS`;
- `checks.sourceReleaseBoundaries` is `PASS`;
- `checks.backendCompatibility` is `PASS`;
- `checks.releasePackaging` is `PASS`;
- `checks.signatures` is `PASS`;
- `checks.emulatorMatrix` is `PASS`;
- `emulatorMatrix.api28.result` is `PASS`;
- `emulatorMatrix.api35.result` is `PASS`;
- APK, AAB and mapping SHA-256 values are present.

The disposable verification keystore and `android/key.properties` are deleted in `finally` even when the gate fails. The organization Play upload key is not required for this verification run and is never written into the repository.

## What remains manual after a PASS

The local automated gate replaces the blocked GitHub-hosted execution only. It does not replace operator-owned store and physical-device checks.

Before Play production rollout, manually complete the existing physical-device checklist for real microphone/Bluetooth/wired audio, Google OAuth handoff, Razorpay UI, camera intent, Android file picker, downloads/share flow, OEM background/foreground behavior, and the Play Console listing/Data Safety/content-rating/upload-key steps.

Those publishing checks remain outside the Phase 6 code gate and should be performed against the exact store-signed AAB that will be uploaded.
