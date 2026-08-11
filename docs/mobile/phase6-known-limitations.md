# SentIQ Chat Android — Phase 6 known limitations

## Application limitations

No known code-level blocker remains for the Phase 6 production candidate.

## Release-operation prerequisites

The following are operational validation/publishing requirements rather than missing application features:

- Supabase Authentication must continue to allow `com.sentiqlabs.sentiqchat://login-callback/**` and `com.sentiqlabs.sentiqchat://reset-callback/**`.
- The Play upload key and its passwords must be supplied through protected CI/environment secrets for a store-signed build; verification CI uses a disposable signing key by design.
- Final physical-device checks must exercise microphone quality, Bluetooth/wired Live routes, Google OAuth handoff, Razorpay UI, camera-intent capture, file pickers, downloads/sharing, and OEM lifecycle behavior.
- Play Console listing metadata, Data Safety answers, content rating, screenshots, privacy-policy URL, and staged rollout are completed by the publishing account owner.

These prerequisites do not require a different mobile/backend architecture and should not be bypassed by committing secrets or weakening Android security policy.
