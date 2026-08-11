# SentIQ Chat Android — Phase 5 product completeness

## Status

Phase 5 completes the native Android integration for Deep Research, SentIQ Live, billing, personalization, memory, privacy, data controls, and support. It builds on the existing authenticated backend contracts and does not introduce a parallel account, quota, payment, or research system.

## Deep Research

The native Deep Research workspace can start a report against the active conversation, display the user’s remaining report allowance, stream durable progress and source events, and render incremental report content. A report ID is retained immediately so the application can resume after a stream disconnect, process interruption, or application lifecycle transition.

Foreground recovery uses both durable event replay and status polling. Closing the mobile SSE connection does not cancel server-side research. Cancellation is explicit and report-scoped. Completed reports restore from the server, retain their source list, and can be exported as Markdown, DOCX, or PDF through authenticated byte downloads before being saved or shared through the Android artifact boundary.

Deep Research remains associated with its originating conversation. Completed report persistence is therefore visible through the same conversation continuity model used by the web product.

## SentIQ Live

SentIQ Live uses the existing authenticated server lifecycle:

1. Read availability, plan entitlement, remaining daily time, and active-session state.
2. Request Android microphone permission.
3. Create a constrained ephemeral Live session token for the selected conversation.
4. Establish the provider WebSocket and send setup before audio.
5. Wait for setup acknowledgement, acknowledge the server session start, and begin PCM capture.
6. Stream mono PCM input, play PCM output, update the restrained orb and waveform from measured input amplitude, and maintain user/assistant transcripts.
7. Commit a finalized transcript exactly once, end the server session, and release all audio and socket resources.

The controller handles provider interruptions, app backgrounding, token expiry, bounded reconnect attempts, fresh-token rotation, and remaining-session time. A session is always associated with a conversation. Android audio routing exposes speaker, earpiece, wired, USB, and Bluetooth communication devices where the operating system permits route selection. Audio focus changes suspend capture and drive explicit interruption/recovery events.

No provider API key is stored in the application. Only the short-lived constrained token returned for that authenticated session is sent to the provider WebSocket.

## Billing and plans

The billing surface reads the backend plan catalog rather than embedding prices or allowances in Flutter. It displays the current plan, subscription state, text/image/research/Live usage meters, and a plan comparison.

Paid-plan selection creates a server-owned Razorpay subscription checkout. The Android Razorpay SDK returns success, failure, dismissal, or external-wallet events. Successful payment details are sent to the backend verification route before any plan change is shown. Billing and usage are refreshed after verification, cancellation, usage changes, or an explicit pull-to-refresh.

Subscription cancellation uses the existing backend cancellation policy and refreshes the current-plan state after the server confirms the request.

## Account completeness

The native account workspace provides:

- display-name personalization;
- current plan and usage access;
- cloud memory listing and deletion;
- the same user-facing privacy and terms framing as the current web product;
- temporary uploaded-file clearing;
- scoped local conversation-cache and application-preference clearing;
- support email handoff;
- sign-out followed by local-data clearing.

Local clearing is intentionally honest: it removes this device’s cache and temporary file session, not cloud conversations or memories. Cloud conversations remain deletable from the conversation list and cloud memories from the Memory tab.

## Android boundary

The checked-in Android integration is preserved when CI regenerates the Flutter scaffold. It declares microphone and audio-routing permissions, provides PCM capture and playback through narrow method/event channels, reports input amplitude, handles audio focus, and enumerates/selects communication routes. Existing secure file save/share/open/copy behavior remains unchanged.

## Mobile contract

The additive mobile contract is version 4. It declares the durable Deep Research event vocabulary and all Deep Research, billing, and Live lifecycle endpoints. Unknown fields and unknown SSE events remain forward-compatible.

## Evaluation coverage

Automated tests cover:

- Deep Research progress/source/content/snapshot replay;
- cancellation and durable resume by report ID;
- background/foreground polling and stream reconnection;
- denied microphone permission;
- Live setup acknowledgement, audio interruption, lifecycle suspension, reconnect, token rotation, and remaining time;
- transcript commit idempotency;
- Razorpay success, failure, dismissal, and backend verification failure;
- billing refresh after verification, cancellation, and usage changes;
- memory loading/deletion, temporary-file clearing, scoped local cache clearing, and account-data clearing;
- mobile contract version 4 fixture replay;
- complete Android debug APK compilation with the native audio bridge.

Physical-device verification is still required for real microphone characteristics, OEM audio routes, Bluetooth behavior, provider WebSocket operation, Razorpay UI, Google OAuth callbacks, and release signing.
