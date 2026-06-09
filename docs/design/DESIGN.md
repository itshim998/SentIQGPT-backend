# SentIQ Chat Design System

## Gemini-checkpoint SentIQ Chat UI Foundation

Phase 1 establishes design language and semantic tokens for future Gemini-checkpoint UI passes. It does not redesign the app shell, composer, message stream, sidebar, settings, auth, memory, WebSurf, image generation, or file upload flows.

### Design Principles

- Open atmospheric canvas: future shell work should reduce hard containers and let spacing, typography, and subtle depth define regions.
- Floating adaptive composer foundation: future composer work should use a centered, responsive pill with integrated actions while preserving all existing input, upload, streaming, stop, and mode-selection behavior.
- Document-style response stream foundation: future message work should move toward readable prose width, transparent assistant responses, and compact right-aligned user messages without changing message persistence or streaming contracts.
- Low-contrast sidebar foundation: future navigation work should quiet borders and surfaces while preserving chat history, search, mobile drawer, collapse state, and storage compatibility.
- Contextual panel foundation: future settings, auth, memory, billing, trust, and source panels should feel lighter and more contextual while keeping focus management, ARIA semantics, and state boundaries intact.
- Matte SentIQ identity: use a dark, premium SentIQ Chat atmosphere inspired by Gemini's layout discipline, not exact Gemini cloning or Google-specific visual language.
- Safe rich response components: markdown, code, math, generated files, images, citations, file status, and loader components must stay readable and functional before visual simplification.
- Accessibility and reduced motion: keyboard focus, color contrast, readable text hierarchy, aria-live regions, modal focus behavior, and `prefers-reduced-motion` support remain production requirements.
- Mobile safe areas: future bottom composer and panel work must respect viewport-fit safe areas, virtual keyboard behavior, and comfortable touch targets.

### Foundation Token Contract

The token layer now exposes `--sentiq-*` semantic variables for later passes. These names should be used when implementing the Gemini-checkpoint shell, composer, stream, sidebar, and panel refinements.

Existing variables such as `--bg-primary`, `--text-primary`, `--border`, `--radius`, `--content-max-width`, and `--transition` remain legacy-compatible and must not be removed without a compatibility pass. The new semantic variables intentionally alias existing tokens where possible so current modernization and premium refinement layers can continue to control the resolved appearance.

### Phase 1 Non-goals

- Do not redesign the composer, messages, sidebar, modals, auth, memory, billing, WebSurf, image generation, or rich response surfaces in this phase.
- Do not rename DOM hooks, classes, IDs, storage keys, API fields, backend identifiers, or public JavaScript contracts.
- Do not introduce React, Tailwind, build tooling, dependencies, or a parallel design system.
- Do not hardcode new component colors outside the token layer.

### Future Pass Guidance

Use the Gemini checkpoint report as design direction, not as authoritative implementation structure. Inspect real files before each pass, because some report paths are guessed or stale. In this checkout, the DOM reference helper is `frontend/scripts/features/chat/dom-refs.js`.
