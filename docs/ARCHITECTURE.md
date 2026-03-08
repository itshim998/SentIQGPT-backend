# SentIQGPT v1 — Architecture Document

## System Overview

SentIQGPT is a general-purpose AI assistant with persistent memory, file handling, and image generation capabilities. It operates on a **dual-model architecture** with stateless backend compute and client-side persistent storage.

| Aspect | Description |
|--------|-------------|
| **Primary Model** | Google Gemini (reasoning, conversation, knowledge) |
| **Secondary Model** | Groq (memory classification, summarization, routing) |
| **Backend** | Node.js + Express + TypeScript (stateless) |
| **LLM Gateway** | Python + FastAPI (dual-provider routing) |
| **Client Storage** | IndexedDB (chats, memories, files, config) |
| **Image Generation** | Multi-provider fallback (Pollinations, HuggingFace) |

---

## Architecture Diagram

```
┌─────────────── CLIENT (Browser) ──────────────────┐
│  IndexedDB: chats | memories | files | config      │
│  Modules: chat-ui | memory-panel | file-upload     │
│           image-gen-ui | settings-panel             │
│           storage-manager | api-client              │
└─────────────────────┬──────────────────────────────┘
                      │ HTTPS (JSON)
┌─────────────────────┴──────────────────────────────┐
│  EXPRESS SERVER (server.ts, port 3001)              │
│  Middleware: CORS, Helmet, Rate Limiter, Audit      │
│  Validation: Zod schemas, injection detection       │
│  Routes: /api/chat, /api/memory/*, /api/files/*,   │
│          /api/images/generate, /api/config           │
│  Handlers: ChatHandler, MemoryProcessor,            │
│            FileIngestionHandler, ImageGenerationHandler│
└─────────────────────┬──────────────────────────────┘
                      │ HTTP (JSON)
┌─────────────────────┴──────────────────────────────┐
│  LLM GATEWAY (llm_service.py, port 3002)           │
│  Router: task → provider mapping                    │
│  Gemini: 3-key rotation, reasoning tasks            │
│  Groq: 3-key rotation, cognitive tasks              │
│  Cache: shelve disk cache (SHA256 keyed)            │
│  Rate Limit: per-provider token buckets             │
└────────────────────────────────────────────────────┘
```

---

## Dual-Model Task Routing

| Task | Provider | Purpose |
|------|----------|---------|
| `chat` | Gemini | Conversational responses |
| `general` | Gemini | General queries |
| `file_extract` | Gemini | File content understanding |
| `image_generate` | Gemini | Image prompt enhancement |
| `memory_classify` | Groq | Decide if message should be remembered |
| `memory_summarize` | Groq | Extract memory from message |
| `memory_compress` | Groq | Merge old memories |
| `route_classify` | Groq | Intent classification |

---

## Memory Pipeline

```
User Message
    │
    ├─► Gemini: Generate response (chat task)
    │
    └─► Groq: Memory pipeline (parallel)
         │
         ├─ CLASSIFY → { should_store, type, reason }
         │
         └─ SUMMARIZE → { summary, importance }
              │
              └─ Store in client IndexedDB
```

### Memory Types

- **identity**: Name, age, location, occupation
- **preference**: Likes, dislikes, behavioral preferences
- **project**: Active work, goals, tasks
- **knowledge**: Technical facts, concepts shared by user

### Memory Compression

When memory count exceeds threshold:
1. Group oldest memories by type
2. Send to Groq for compression
3. Replace N originals with 1 condensed entry

---

## API Endpoints

| Method | Path | Description | Rate Limit |
|--------|------|-------------|------------|
| GET | `/api/health` | System health check | General |
| POST | `/api/chat` | Send message, get response + memory | AI (30/min) |
| POST | `/api/memory/classify` | Classify message for memory | AI |
| POST | `/api/memory/compress` | Compress old memories | AI |
| POST | `/api/files/upload` | Upload file for extraction | Upload (20/hr) |
| POST | `/api/images/generate` | Generate image from prompt | AI |
| GET | `/api/config` | Server capabilities | General |
| GET | `/api/audit` | Recent audit entries | General |

---

## Security

1. **Helmet.js** — HSTS, X-Frame-Options, X-Content-Type-Options
2. **CORS** — Allowlist-based origin validation
3. **Zod validation** — All inputs validated before processing
4. **Prompt injection detection** — Pattern-based scanning
5. **No-cache headers** — Prevent response caching
6. **File upload validation** — Type whitelist, size limits, path traversal prevention
7. **Rate limiting** — 3-tier (general/AI/upload)
8. **Key rotation** — Automatic failover on provider errors

---

## Directory Structure

```
SentIQGPT/
├── .env.template
├── llm_adapter.py              # Dual-model LLM gateway
├── package.json
├── tsconfig.json
├── requirements.txt
├── render.yaml
├── task_registry.json
├── backend/
│   ├── server.ts               # Express app + all routes
│   ├── llm_service.py          # FastAPI wrapper for llm_adapter
│   ├── ai/
│   │   ├── ChatHandler.ts      # Conversation orchestrator
│   │   ├── MemoryProcessor.ts  # Memory classify/summarize/compress
│   │   ├── FileIngestionHandler.ts
│   │   ├── ImageGenerationHandler.ts
│   │   └── PromptBuilders.ts   # Prompt construction + LLM bridge
│   ├── middleware/
│   │   ├── rateLimiter.ts
│   │   └── audit.ts
│   └── validation/
│       └── schemas.ts
├── frontend/
│   ├── index.html
│   ├── styles/sentiqgpt.css
│   └── scripts/
│       ├── storage-manager.js  # IndexedDB abstraction
│       ├── api-client.js       # Backend API client
│       ├── chat-ui.js          # Chat interface
│       ├── memory-panel.js     # Memory viewer
│       ├── file-upload.js      # File upload UI
│       ├── image-gen-ui.js     # Image generation UI
│       └── settings-panel.js   # Storage config
└── docs/
    └── ARCHITECTURE.md
```

---

## Relationship to HealthIQ

SentIQGPT is a **sibling project** to HealthIQ, sharing foundational patterns:

| Component | HealthIQ | SentIQGPT |
|-----------|----------|-----------|
| LLM Gateway | Gemini only | Gemini + Groq dual-model |
| Key Rotation | 3-key Gemini | 3-key per provider |
| Cache | Shelve | Shelve (provider-aware keys) |
| Rate Limiter | Token Bucket | Per-provider Token Buckets |
| Backend | Express + TypeScript | Express + TypeScript |
| Task Registry | Shared JSON | Separate JSON |
| Client Storage | LocalStorage | IndexedDB |
| Domain | Health intelligence | General AI assistant |
| Memory | None | Persistent + compressed |
| Image Gen | None | Multi-provider fallback |
| File Handling | None | PDF/TXT/Image upload |
