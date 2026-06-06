# Phase 0 Browser Verification

Run this checklist before publishing frontend assets and after backend deployment.

## Automated gate

```powershell
npm.cmd run build
npm.cmd run test:phase0
npm.cmd run test:frontend-bootstrap
npm.cmd run test:conversation-sync
npm.cmd run test:passA
npm.cmd run test:priority4-contracts
```

## Browser startup

1. Load the deployed app with DevTools open and confirm the local `vendor/` scripts and KaTeX assets return `200` with JavaScript, CSS, and font MIME types.
2. Block IndexedDB and reload. Confirm the compatibility banner explains temporary in-memory storage and chat remains usable.
3. Block streaming support in a test harness or use a browser without `ReadableStream`. Confirm chat falls back to buffered responses.
4. Confirm no uncaught startup errors appear during normal load.

## Response recovery

1. Start a streaming answer, interrupt the network after visible text arrives, and restore the network.
2. Confirm the partial answer remains visible with an interrupted status and a `Continue generating` action.
3. Confirm one linked continuation attempt is made automatically and does not overwrite the original partial answer.
4. Start another answer and press Stop. Confirm the partial answer remains visible, is labeled as stopped by the user, and does not auto-resume.
5. Repeat as a guest, reload the same tab, and confirm the interrupted guest draft is restored.

## Data controls

1. Open `Privacy & data` from the sidebar as a guest and as a signed-in user.
2. Confirm Support opens an email to `support@sentiqlabs.com`.
3. Upload a source file, use `Clear local SentIQ Chat data`, and confirm the browser cache and temporary upload session are cleared without signing the user out.
4. Remove a generated image and generated file. Confirm the UI shows success only after backend deletion succeeds.
5. Delete a cloud conversation containing generated artifacts. Confirm storage objects and metadata are removed before the conversation disappears from the sidebar.

## Public response audit

Inspect `/api/health`, `/api/config`, `/api/search/status`, ordinary JSON responses, and stream frames. Confirm responses do not expose model names, provider names, private storage paths, storage bucket names, key status, or architecture details.
