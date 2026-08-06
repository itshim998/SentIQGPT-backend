# SentIQ Chat Android — Phase 4 multimodal and artifacts

## Status

Phase 4 extends the native Flutter chat client with files, camera and gallery images, image generation, charts, generated artifacts, and WebSurf presentation. Deep Research and SentIQ Live remain outside this phase.

## Attachments and file analysis

The composer uses native Android file and image pickers. It supports multiple PDF, text, code, PNG, JPEG, and WebP attachments, plus single-shot camera capture and multi-image gallery selection. Files are validated before network work begins, with a 10 MiB per-file boundary and a ten-attachment limit.

Non-image attachments use authenticated multipart uploads with byte-level progress and an idempotent cancellation handle. The UI separates upload and analysis states, permits cancellation and retry, and connects to the authenticated `/api/files/updates` stream. The stream is re-established after a disconnect, application resume, or network recovery.

Long PDFs are described honestly: SentIQ Chat uses the most relevant sections and may need follow-up questions for complete coverage. Scanned or image-based PDFs retain the backend's explicit notice that no selectable text was found instead of implying successful text extraction.

## Generated images

Image mode uses the existing image-generation endpoint and a unique client request ID. It displays the current image allowance independently from text quotas and retains warnings when an image succeeds but conversation persistence does not.

Generated images render in a native card and full-screen viewer with zoom and pan. Copy, share, download, and open actions pass decoded bytes through a narrow Android method-channel boundary. Delete removes the persisted image where an image ID exists and immediately hides the local card.

## Charts

Chart.js and Plotly-shaped responses are normalized into a native chart model. Bar, line, pie, and doughnut presentations are rendered with Flutter canvas primitives. Unsupported or malformed payloads produce a contained error card rather than throwing during message rendering.

Persisted chart data is restored from the existing message preview metadata.

## Generated files

Generated-file responses support preview, download, share, opening in compatible Android applications, deletion, and HTML editing. HTML saves are sanitized before being sent to the existing versioned update endpoint. The updated preview is reflected immediately and remains recoverable from server-side message metadata.

Previews never execute remote HTML. Scripts, embedded frames, active event handlers, credential-bearing URLs, non-HTTPS navigation, and unsafe URI schemes are excluded at the native presentation boundary. Downloaded content is subject to explicit byte limits before it reaches Android storage or sharing APIs.

## WebSurf

WebSurf V2 events update the active response as sources arrive and complete the streamed answer when synthesis finishes. The native view provides source cards, citation destinations, secure external navigation, source thumbnails, optional image-result strips, and explicit partial-result or failure states.

WebSurf source and image URLs are limited to credential-free HTTPS destinations. Persisted WebSurf metadata is restored from existing message preview fields.

## Android boundary

The generated Android scaffold declares camera access and a private `FileProvider`. The native artifact channel supports:

- MediaStore downloads on Android 10 and later;
- an application-scoped download fallback on Android 9;
- content-URI sharing;
- copying generated image content rather than a remote URL;
- opening files with compatible Android applications.

No service-role or storage credential is embedded in the application.

## Evaluation coverage

Automated coverage includes supported and unsupported file fixtures, oversized-file rejection, active upload cancellation, file-analysis disconnect and reconnect, image and artifact downloads, malformed charts, secure HTML sanitization, navigation restrictions, WebSurf event replay, persisted preview shapes, and image-heavy long-report memory pressure.

## Verified implementation gate

The self-cleaning Phase 4 implementation gate passed in GitHub Actions run `31104687985`. It completed Flutter analysis, the expanded test suites, Android debug APK compilation, backend TypeScript compilation, mobile contract version 3 verification, and temporary-helper cleanup before creating permanent commit `9271405519b97084e81b9fb9b2788677291a34e9`.
