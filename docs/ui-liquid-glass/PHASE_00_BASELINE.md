# SentIQ Chat Liquid Glass V4 — Phase 0 Baseline

Status: Active baseline
Created: 2026-07-19
Scope: `frontend/**` and UI documentation only
Base branch: `master`
Baseline commit: `bb9ebc7e879ef0a46228811197c1bde35a9a9260`
Checkpoint branch: `checkpoint/pre-liquid-glass-ui-2026-07-19`
Working branch: `ui/sentiq-liquid-glass-v4`

## 1. Purpose

This document establishes the immutable UI baseline, regression matrix, viewport matrix, implementation boundaries, and acceptance gates for the SentIQ Chat Liquid Glass V4 upgrade.

The redesign must improve visual coherence, intelligence, responsiveness, accessibility, and perceived performance without changing backend behaviour or destabilising existing chat, tool, billing, authentication, memory, file, research, or Live voice workflows.

## 2. Repository safety contract

- `master` remains untouched while the redesign is under development.
- `checkpoint/pre-liquid-glass-ui-2026-07-19` remains fixed at the baseline commit.
- All implementation passes land on `ui/sentiq-liquid-glass-v4`.
- Each pass must be committed independently with a descriptive commit message.
- A pass must be reversible without requiring unrelated passes to be discarded.
- Frontend changes must not silently alter backend contracts.
- Backend, deployment, secrets, environment, infrastructure, database, and workflow files are read-only for this programme.
- The final merge into `master` requires explicit approval after regression review.

## 3. Allowed implementation area

Primary edit scope:

- `frontend/index.html`
- `frontend/styles/**`
- `frontend/scripts/**`
- `frontend/assets/**` when required
- `frontend/tests/**`
- `docs/ui-liquid-glass/**`

Read-only inspection is permitted elsewhere when needed to understand API response shapes, feature availability, authentication restrictions, streaming behaviour, file states, billing states, or tool lifecycle states.

## 4. Current frontend architecture inventory

### Application shell

- Sidebar and desktop collapse control
- Mobile sidebar trigger
- Main conversation canvas
- Welcome and empty-chat state
- Chat scroll region
- Persistent composer
- Global toast region

### Composer capabilities

- Multi-file attachment
- Drag and drop
- Selected-text context
- Visualize mode
- WebSurf mode
- Deep Research mode
- Fast and Intuitive execution modes
- Send, stop, and Live voice actions
- Attachment progress, retry, and removal states

### Conversation capabilities

- User and assistant messages
- Streaming response state
- Thinking and tool lifecycle state
- Rich Markdown
- Code blocks
- KaTeX mathematics
- WebSurf presentation
- Deep Research presentation
- Generated images
- Generated charts
- Generated files
- Message actions
- Smart scroll-to-latest control
- Long-conversation rendering optimisation

### Account and system surfaces

- Guest authentication actions
- Signed-in account controls
- Authentication modal
- Name collection modal
- Settings
- Billing and token usage
- Memory Manager
- Trust and support
- Live voice panel

### Existing stylesheet layers

The current visual result is produced by a layered CSS cascade:

1. Base tokens
2. Layout and sidebar
3. Chat messages
4. Markdown and code
5. Rich responses
6. Loaders
7. Composer
8. Modals and settings
9. Authentication actions
10. Responsive rules
11. Modernization overrides
12. Premium refinement overrides
13. Billing
14. Deep Research
15. Live voice
16. Reduced-motion overrides

Phase 1 must consolidate competing token and override layers before substantial new visual effects are introduced.

## 5. Non-negotiable behavioural invariants

The redesign must preserve:

- Starting a new conversation
- Switching between conversations without state leakage
- Renaming and deleting conversations
- Searching conversation history
- Sidebar collapse and expansion
- Guest and authenticated flows
- Google and email authentication paths
- Profile name collection
- Sending a plain-text message
- Stopping an active response
- Streaming response updates
- Retrying recoverable errors
- Uploading one or multiple supported files
- Removing and retrying attachments
- Selected-text context
- Visualize, WebSurf, and Deep Research mode activation and cancellation
- Fast and Intuitive execution mode selection
- Generated image, chart, and file presentation
- WebSurf citations and source exploration
- Deep Research progress and result rendering
- Billing and token usage visibility
- Memory Manager operations
- Live voice start, mute, transcript, retry, and end controls
- Capacitor/mobile integration behaviour
- Keyboard and screen-reader operability
- Reduced-motion support

## 6. UI state matrix

Every pass that affects a listed surface must be reviewed against all relevant states.

### A. Session and identity

| ID | State | Required visible behaviour |
|---|---|---|
| A01 | Guest, initial load | Clear guest identity, temporary-chat notice, usable authentication actions |
| A02 | Guest, active chat | Chat remains usable within guest restrictions; restricted actions explain their requirement |
| A03 | Signed in, profile complete | Personalised greeting and consolidated account access |
| A04 | Signed in, missing display name | Name collection remains blocking only where required and restores focus correctly |
| A05 | Authentication modal open | Background is inert; keyboard focus is trapped; Escape and close work |
| A06 | Authentication error | Specific error text, preserved entered email, clear recovery path |
| A07 | Authentication loading | Duplicate submission prevented without visual instability |
| A08 | Signed out after active session | Sensitive account controls disappear and guest state is coherent |

### B. Conversation lifecycle

| ID | State | Required visible behaviour |
|---|---|---|
| B01 | Empty conversation | Welcome composition and central entry affordance are balanced |
| B02 | Existing short conversation | Correct message hierarchy and stable composer position |
| B03 | Existing long conversation | Reading position is preserved; content remains performant |
| B04 | New user message submitted | Message appears once; composer clears only after accepted submission |
| B05 | Assistant streaming | Stable scroll anchoring; visible stop control; no layout thrashing |
| B06 | User reading older content during streaming | No forced jump to latest; completion is signalled quietly |
| B07 | Response stopped | Partial content remains understandable; composer returns to ready state |
| B08 | Recoverable response failure | Prompt and context remain; retry path is explicit |
| B09 | Conversation switch during streaming | Per-chat state does not leak; inactive activity remains identifiable |
| B10 | Empty history search result | Helpful empty result without destructive state changes |
| B11 | Conversation rename | Inline edit is stable and accessible |
| B12 | Conversation deletion | Correct focus restoration and active-chat fallback |

### C. Composer and context

| ID | State | Required visible behaviour |
|---|---|---|
| C01 | Empty composer | Live voice or neutral action state is clear |
| C02 | Text entered | Send becomes the unambiguous primary action |
| C03 | Multi-line draft | Textarea grows within a bounded height; controls remain aligned |
| C04 | Composer focused | Focus lens is visible without neon or excessive motion |
| C05 | Tool menu open | Menu remains within viewport and supports keyboard navigation |
| C06 | Fast mode selected | Selection is clear and concise |
| C07 | Intuitive mode selected | Selection is clear and concise |
| C08 | Visualize active | One clear active-mode indicator and cancellation action |
| C09 | WebSurf active | One clear active-mode indicator and cancellation action |
| C10 | Deep Research active | One clear active-mode indicator and cancellation action |
| C11 | Selected text attached | Context preview is legible, removable, and does not crowd input |
| C12 | Drag ready | Drop target is clear without obscuring unrelated UI |
| C13 | Drag over | Stronger drop confirmation without expensive full-screen effects |
| C14 | Response locked | Disabled controls remain understandable; Stop remains active |
| C15 | Draft preserved across chat switch | Draft and active mode restore to the correct conversation when supported |

### D. Attachments and files

| ID | State | Required visible behaviour |
|---|---|---|
| D01 | Single file uploading | Filename, type, progress, and removal affordance |
| D02 | Multiple files uploading | Stable wrapping or mobile shelf without composer collapse |
| D03 | File ready | Clear ready state and retained file identity |
| D04 | File failed | Specific failure with retry and remove actions |
| D05 | Image attachment | Correct thumbnail crop and accessible filename |
| D06 | Long filename | Ellipsis without hiding file type or removal action |
| D07 | Unsupported file | Immediate, specific feedback |
| D08 | Oversized file | Immediate, specific feedback |
| D09 | Generated file result | File type, title, metadata, and download action |

### E. Tool and rich-response lifecycle

| ID | State | Required visible behaviour |
|---|---|---|
| E01 | Generic thinking | Restrained semantic activity indication |
| E02 | Reading attached files | Clear contextual progress |
| E03 | WebSurf searching | Search activity without blocking the conversation |
| E04 | WebSurf completed | Citations and sources are readable and expandable |
| E05 | WebSurf partial or failed | Existing answer/context retained with recovery path |
| E06 | Deep Research running | Stage-based progress; background operation remains legible |
| E07 | Deep Research completed | Report hierarchy and source exploration remain usable |
| E08 | Image generation running | Calm progress and preserved conversation control |
| E09 | Image generation completed | Media-first result with contextual controls |
| E10 | Chart generation running | Clear status without fake chart placeholders |
| E11 | Chart generation completed | Responsive chart frame and export affordance |
| E12 | File generation running | Specific document-preparation state |
| E13 | File generation completed | Download-ready asset card |
| E14 | Tool cancelled | Clean state restoration and retained conversation context |
| E15 | Tool failed | Specific failure, preserved prompt, and retry route |

### F. Panels and overlays

| ID | State | Required visible behaviour |
|---|---|---|
| F01 | Account menu open | Correct trigger anchoring and focus behaviour |
| F02 | Settings open on desktop | Contextual elevated panel or sheet with clear hierarchy |
| F03 | Settings open on mobile | Keyboard-safe full-height or bottom sheet |
| F04 | Billing loading | Stable skeleton or status without content jump |
| F05 | Billing loaded | Plan and token usage are scannable |
| F06 | Memory Manager empty | Directed empty state |
| F07 | Memory Manager populated | Readable list and accessible actions |
| F08 | Trust or support open | Clear informational hierarchy and external-action safety |
| F09 | Toast present | Non-blocking, readable, and dismissible where required |
| F10 | Multiple feedback events | No overlapping or endless notification stack |

### G. Live voice

| ID | State | Required visible behaviour |
|---|---|---|
| G01 | Live unavailable | Hidden or explanatory disabled state |
| G02 | Connecting | Calm connecting state and available End action |
| G03 | Listening | Clear active microphone state |
| G04 | Responding | Distinct assistant-speaking state |
| G05 | Muted | Persistent, unmistakable muted state |
| G06 | Transcript expanded | Readable, scrollable, and focus-safe transcript |
| G07 | Recoverable failure | Retry and End remain available |
| G08 | Session ended | Focus returns to composer or invoking control |
| G09 | Reduced motion | Static visual equivalent communicates every state |

## 7. Viewport and device matrix

### Required reference widths

| ID | Viewport | Purpose |
|---|---|---|
| V01 | 1440 × 900 | Primary desktop reference |
| V02 | 1280 × 720 | Compact desktop and common laptop reference |
| V03 | 1024 × 768 | Tablet landscape and narrow desktop transition |
| V04 | 768 × 1024 | Tablet portrait boundary |
| V05 | 412 × 915 | Tall Android-class mobile reference |
| V06 | 390 × 844 | Modern iPhone-class reference |
| V07 | 360 × 800 | Narrow Android reference |
| V08 | 844 × 390 | Mobile landscape reference |

### Required environmental variants

- Pointer and keyboard desktop
- Touch-only mobile
- Mobile keyboard closed
- Mobile keyboard open
- Safe-area inset present
- Reduced-motion preference
- 200% browser zoom
- Slow image loading
- Long unbroken text and filenames
- Long code blocks and wide tables

## 8. Baseline screenshot catalogue

Screenshots should be captured using the naming pattern:

`P00_<state-id>_<viewport-id>_<description>.<extension>`

Minimum baseline catalogue:

1. `P00_A01_V01_guest-home`
2. `P00_A03_V01_signed-in-home`
3. `P00_B02_V01_short-chat`
4. `P00_B03_V01_long-markdown-chat`
5. `P00_B05_V01_streaming-response`
6. `P00_C05_V01_tool-menu-open`
7. `P00_D02_V01_multiple-attachments`
8. `P00_E04_V01_websurf-completed`
9. `P00_E07_V01_deep-research-completed`
10. `P00_E09_V01_generated-image`
11. `P00_E11_V01_generated-chart`
12. `P00_E13_V01_generated-file`
13. `P00_F02_V01_settings-desktop`
14. `P00_F05_V01_billing-loaded`
15. `P00_G03_V01_live-listening`
16. `P00_A01_V06_guest-home-mobile`
17. `P00_A03_V06_signed-in-home-mobile`
18. `P00_B03_V06_long-chat-mobile`
19. `P00_C03_V06_multiline-composer-mobile`
20. `P00_C05_V06_tool-menu-mobile`
21. `P00_D02_V06_multiple-attachments-mobile`
22. `P00_F03_V06_settings-mobile`
23. `P00_G06_V06_live-transcript-mobile`
24. `P00_C03_V08_keyboard-landscape-mobile`

Baseline screenshots are evidence, not implementation assets. They should not be committed if they contain personal data, private chat content, authentication tokens, or account information.

## 9. Existing automated checks

The following checks must remain green when their affected areas are changed:

```bash
npm run check:frontend-syntax
npm run test:frontend-bootstrap
npm run test:frontend-file-generation
npm run test:frontend-tool-lifecycle
npm run billing:test-token-allowances
```

Additional focused frontend tests should be added as new state logic is introduced.

## 10. Per-pass acceptance checklist

A pass is not complete until all applicable items are true:

- The intended visual or behavioural outcome is documented.
- The diff stays within the approved scope.
- No unrelated formatting churn is introduced.
- Existing IDs and data hooks are preserved unless intentionally migrated.
- Keyboard access works.
- Focus state is visible.
- Touch targets remain at least 44 × 44 CSS pixels where applicable.
- Mobile safe-area spacing remains correct.
- Reduced-motion behaviour remains understandable.
- Text contrast remains sufficient.
- No important action depends only on hover.
- No new horizontal page overflow appears.
- Composer height and chat scroll position remain stable.
- Relevant automated checks pass.
- The commit can be reverted independently.

## 11. Phase 0 completion gate

Phase 0 is complete when:

- The checkpoint branch exists at the verified baseline commit.
- The working branch exists at the verified baseline commit plus Phase 0 documentation.
- A draft pull request targets `master`.
- The full state matrix has been recorded.
- The viewport and environment matrix has been recorded.
- Baseline screenshots for the minimum catalogue have been captured or explicitly marked unavailable with a reason.
- The first implementation pass can begin without ambiguity about scope, rollback, or regression requirements.

## 12. Next implementation pass

Phase 1 begins with the design-system foundation:

1. Inventory every token redefinition across the imported stylesheets.
2. Establish a canonical semantic token vocabulary.
3. Preserve compatibility aliases for selectors that still consume legacy token names.
4. Consolidate or retire contradictory override layers.
5. Introduce reusable quiet, active, and elevated glass primitives.
6. Keep visible behaviour as close to baseline as possible until the cascade is stable.
