# SentIQ Chat Android — Phase 2 native shell

## Delivered scope

Phase 2 replaces the foundation gallery with a fully navigable native shell. The app now supports launch initialization, guest entry, email login and signup, Google OAuth handoff, password recovery callbacks, required display-name completion, restored sessions, sign-out, conversation navigation, SQLite caching, cloud reconciliation, offline states, theme selection, and adaptive layouts.

The chat composer is deliberately non-interactive in this phase. Complete messaging and streaming remain owned by Phase 3.

## Authentication state machine

The UI is driven by explicit states:

1. `initializing`
2. `signedOut`
3. `guest`
4. `awaitingEmailConfirmation`
5. `requiresDisplayName`
6. `authenticated`
7. `passwordRecovery`
8. `failure`

Supabase-specific objects remain inside `SupabaseAuthGateway`. The controller consumes plain session snapshots and gateway events, allowing deterministic tests for cold start, restored sessions, OAuth completion, recovery links, token refresh, guest upgrades, and sign-out.

Supabase Flutter `2.16.0` is initialized with `AuthFlowType.pkce`, persisted sessions, automatic callback detection, and external-browser Google OAuth. Android registers separate custom-scheme hosts for sign-in and recovery.

## Workspace data path

SQLite schema version 2 stores conversation summaries by owner scope. Guest and authenticated data are separated. Records carry one of four synchronization states:

- `synced`
- `localOnly`
- `pendingRename`
- `pendingDelete`

The workspace reads SQLite first. When authenticated and connected, pending operations replay before the cloud list is fetched. Cloud results are upserted into the cache. Network-type detection is only a hint; API failures move the shell into degraded mode while preserving cached access.

## Navigation and adaptive layout

- Compact phones use a conversation drawer and app bar.
- Medium widths provide a wider drawer suitable for foldables and small tablets.
- Expanded widths keep a 340dp conversation sidebar visible.
- Back navigation closes nested auth pages first and clears a compact selected conversation before leaving the app.
- All primary surfaces respect safe areas, keyboard insets, rotation, and `adjustResize`.

The drawer includes new chat, search, conversation selection, rename, delete, account access, and settings. Appearance supports system, light, and dark modes with persistent device preference.

## User-facing language

Visible text avoids implementation terms, provider names, schema names, and synchronization internals. Offline and degraded messages explain what the user can still do and what will happen after reconnection.

## Dependencies added

| Dependency | Version | Purpose |
| --- | --- | --- |
| `supabase_flutter` | 2.16.0 | Persisted auth, PKCE, OAuth and deep-link callbacks |
| `sqflite` | 2.4.3 | Android SQLite conversation cache |
| `sqflite_common_ffi` | 2.4.2 | Real SQLite migration tests on CI |
| `connectivity_plus` | 7.3.1 | Network availability hints |
| `shared_preferences` | 2.5.5 | Persistent theme and anonymous preferences |
| `path` | 1.9.1 | Stable database path construction |

## Operational configuration

The mobile redirect patterns must be added to the Supabase project's redirect allowlist before physical OAuth or recovery testing:

- `com.sentiqlabs.sentiqchat://login-callback/**`
- `com.sentiqlabs.sentiqchat://reset-callback/**`

These are public routing settings, not application secrets. The app contains no service-role credentials.
