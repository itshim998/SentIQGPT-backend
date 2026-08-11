# SentIQ Chat Android — Phase 6 feature-parity checklist

This checklist compares the production Android client with the SentIQ Chat product contracts implemented through Phases 1–5. It intentionally checks product capability, not pixel-for-pixel web duplication.

| Capability | Android status | Evidence |
| --- | --- | --- |
| Guest entry and authenticated session restoration | Complete | native auth state machine, secure session storage |
| Email auth, Google OAuth, password recovery, display name | Complete | PKCE/deep-link flows and auth tests |
| Conversation list/search/new/rename/delete | Complete | workspace shell, SQLite/cloud reconciliation tests |
| Offline/degraded cache and pending replay | Complete | workspace persistence/reconciliation suite |
| Fast and Intuitive chat | Complete | shared backend contract and mode-aware composer |
| Streaming, stop, retry, continue, lifecycle recovery | Complete | SSE/request-ID lifecycle tests and 32 ms token batching |
| Markdown, code, math, tables, citations, selection | Complete | native rich-text renderer and golden/widget coverage |
| Files and multiple attachments | Complete | native picker, validation, multipart progress/cancel/retry |
| Long/scanned document states | Complete | file-analysis status and reconnect handling |
| Image generation and image allowance | Complete | generated-image payload/actions/quota flows |
| Image zoom/copy/share/save/open/delete | Complete | native Android artifact boundary |
| Charts | Complete | native bar/line/pie/doughnut rendering and malformed-data containment |
| Generated files and sanitized HTML editing | Complete | preview/download/share/open/edit/delete with non-executing HTML |
| WebSurf V2 | Complete | streamed answer, sources, citations, images, partial/error states |
| Deep Research | Complete | durable report events, recovery, cancellation, export |
| SentIQ Live | Complete | ephemeral token, PCM audio, routes, transcripts, lifecycle recovery |
| Billing/plans/Razorpay verification | Complete | backend-owned catalog/checkout/verification/cancel flows |
| Memory and account data controls | Complete | memory CRUD, temporary/local clearing, sign-out cleanup |
| Privacy, terms and support | Complete | native account surfaces and explicit support handoff |
| Dark and light themes | Complete | golden coverage plus Phase 6 contrast checks |
| Accessibility/reduced motion/dynamic text | Complete | Phase 6 accessibility regression and platform preference handling |
| Release security/packaging | Complete | encrypted auth storage, HTTPS boundary, R8, external signing, APK/AAB gate |

## Parity conclusion

No known application feature implemented by the current SentIQ Chat mobile contract is intentionally omitted from Android. Web-only browser mechanics are replaced with native Android equivalents where appropriate (system picker, FileProvider/MediaStore, external HTTPS handoff, native audio routing, and Android payment UI).
