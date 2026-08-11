# SentIQ Chat Android — Phase 1 architecture

## Status

Phase 1 establishes the native Flutter foundation on `feature/flutter-android-app`. The web frontend and production behavior remain unchanged. The Android client lives under `mobile/sentiq_chat/` and is built independently.

## Toolchain and product boundary

| Item | Decision |
| --- | --- |
| Flutter | 3.44.8 stable, pinned in source and CI |
| Dart | 3.12.x from the pinned Flutter SDK |
| Android application ID | `com.sentiqlabs.sentiqchat` |
| Minimum Android API | 28 |
| Default theme | Follow the device setting |
| Architecture | Feature-first presentation/domain/data boundaries |
| State foundation | Riverpod provider graph |
| Networking | Typed service layer over `package:http` |
| Streaming | Version-aware, tolerant SSE parser |
| Anonymous quotas | Stable `X-SentIQ-Anonymous-Id` identity |
| Auth transport | Bearer-token provider abstraction |

## Layering

- `app/` owns bootstrap, root navigation, themes, and top-level dependency overrides.
- `core/config/` owns build environment selection and endpoint configuration.
- `core/contracts/` owns compatibility models returned by `/api/config`.
- `core/network/` owns request construction, identity headers, error normalization, JSON parsing, and SSE decoding.
- `core/design_system/` owns tokens and theme construction.
- `features/` owns product feature state and presentation. Features may depend on `core`, but not on one another's private implementation.
- `shared/widgets/` contains reusable, product-approved primitives only.

## Backend adaptability

`/api/config` is extended with a new `mobile_contract` object. Existing `version`, `features`, and `limits` fields are preserved exactly. The contract declares:

- contract and minimum-client versions;
- forward-compatible unknown-field and unknown-SSE-event behavior;
- the current SSE envelope version and event names;
- stable endpoint discovery for Android;
- recommended Flutter and minimum Android versions.

The Flutter decoder keeps unknown fields and events instead of rejecting the response. A newer SSE envelope is marked as unsupported for observability while retaining its payload, allowing the UI to degrade safely.

## Configuration

Three environments are present from the first commit:

- `development`: Android emulator points to `10.0.2.2:3001`;
- `staging`: currently uses the production-compatible endpoint until a dedicated staging service is assigned;
- `production`: current Azure Container Apps API.

Every endpoint can be overridden with `SENTIQ_API_BASE` without changing source.

## Design system

Dark mode retains SentIQ Chat's restrained purple identity. Light mode uses pearl surfaces, graphite text, muted indigo, and subdued semantic colors. Refractive glass is a reusable primitive intended for composers, sheets, dialogs, and floating controls—not long reading surfaces.

The foundation includes buttons, icon controls, fields, sheets, dialogs, loading states, snack-bar toasts, inline errors, and empty states. Touch targets are at least 48dp and components use user-facing language.

## Dependency inventory

| Dependency | Purpose | Boundary |
| --- | --- | --- |
| Flutter SDK | Native UI and Android runtime | Application |
| `flutter_riverpod` 2.6.1 | Explicit dependency graph and state ownership | App/features |
| `http` 1.5.0 | JSON and streaming HTTP transport | Core network only |
| `shared_preferences` 2.5.3 | Non-secret anonymous quota identity | Core identity only |
| `uuid` 4.5.1 | Stable anonymous and future request IDs | Core identity |
| `flutter_lints` 6.0.0 | Static quality rules | Development only |

Supabase, encrypted credential storage, SQLite/Drift, Razorpay, audio, file picking, image handling, and rich-text packages are intentionally deferred until their owning feature phase. This prevents speculative dependencies from becoming architectural commitments.

## Evaluation gates

The dedicated `Flutter Android` workflow performs pinned-toolchain verification, generated Android scaffolding, dependency resolution, formatting, static analysis, unit tests, widget tests, contract replay, golden testing, a debug APK build, backend compilation, and the mobile contract regression. APK, coverage, and golden-failure evidence are uploaded as workflow artifacts.
