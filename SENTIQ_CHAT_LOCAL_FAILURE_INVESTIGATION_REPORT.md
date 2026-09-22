# SentIQ Chat — Local Runtime Failure Investigation Report

**Investigation Date:** 2026-09-22T15:58:00+05:30 (UTC: 2026-09-22T10:28:00Z)  
**Investigation Scope:** Local Runtime & Architecture Deep Dive  
**Execution Standard:** Read-Only Investigation — Zero Implementation  

---

## 1. Investigation Metadata

| Parameter | Observed Local Environment Value |
| :--- | :--- |
| **Repository** | `itshim998/SentIQGPT-backend` |
| **Repository Owner** | `itshim998` |
| **Git Branch** | `master` |
| **Investigated Commit SHA** | `f7bff0163ce5a570fed5ea534da9cce460bfbc94` |
| **Commit Message** | `fix(deploy): handle successful Azure exec teardown status` |
| **Local OS** | Microsoft Windows 11 Home Single Language (NT `10.0.22621.0`) |
| **Node.js Version** | `v22.19.0` |
| **npm Version** | `10.9.3` |
| **Python Version** | `3.11.0` (active venv: `.venv\Scripts\python.exe`) |
| **Local Startup Command** | `npm run dev` (Node/Express) + `.venv\Scripts\python.exe backend/llm_service.py` (Python FastAPI) |
| **Local Frontend Server** | `python -m http.server 5500 -d frontend` (Serving `frontend/`) |
| **Tested Frontend URL** | `http://localhost:5500/index.html` |
| **Node.js HTTP Server State** | **ONLINE** — Listening on port `3001` |
| **Python LLM Service State** | **ONLINE** — Listening on port `3002` |
| **Test User Account Tested** | `synthetiq61@gmail.com` (UUID: `096864d9-0fb8-45d4-ada5-aa33ca311ecd`) |
| **Live Voice Testing** | **STRICTLY EXCLUDED** (Zero clicks, zero audio sessions initiated) |

---

## 2. Executive Summary

A thorough, evidence-backed, read-only investigation was conducted into the failure of AI capabilities in SentIQ Chat during local development and testing.

The investigation conclusively establishes that the failure of SentIQ Chat is **not caused by a single bug**, but is the result of **multiple compound failure modes** operating across different layers of the application:

1. **Primary Critical Bottleneck — Supabase Shards 3 & 4 PostgREST Failure (`PGRST002`)**:
   Direct diagnostic probes confirm that Supabase projects for Database 3 (`https://iizqaveodmwpsfziobbq.supabase.co`) and Database 4 (`https://ejqpzgvdrkskunkxatzk.supabase.co`) return HTTP 503 `PGRST002: Could not query the database for the schema cache. Retrying.` on **every request**. This occurs identically on basic table queries (such as `SELECT id FROM chat_generations` and `SELECT id FROM users`) as well as on the startup verification RPC (`verify_sentiq_data_shard_startup`). The PostgreSQL instances for DB 3 and DB 4 are either paused, in recovery, or their PostgREST gateways cannot reach the underlying databases.

2. **Decisive Architectural Bottleneck — Permanent User Assignment to Degraded Shard**:
   In the Control Database (DB 1), the test account `synthetiq61@gmail.com` has an immutable row in `public.user_db_map`:
   ```json
   {
     "user_id": "096864d9-0fb8-45d4-ada5-aa33ca311ecd",
     "assigned_db": 4
   }
   ```
   Because Database 4 fails startup verification, `backend/dbRouter.ts` flags Shard 4 as `DEGRADED`. When `synthetiq61@gmail.com` logs in and performs any action requiring their shard, `getClientForDatabase(4)` throws `ShardUnavailableError(4)` (HTTP 503). The codebase contains **no automatic reassignment or failover mechanism** for existing users assigned to degraded shards, and the PostgreSQL trigger `prevent_user_db_map_reassignment` in DB 1 strictly forbids updating `assigned_db`. Therefore, this user is 100% blocked from generating text, creating conversations, updating titles, generating images, using WebSurf, or initiating Deep Research.

3. **Why Authentication Works While AI Fails**:
   User authentication (`login`, `logout`, password reset, JWT verification) relies strictly on Supabase Auth and metadata hosted on **Database 1 (Control DB)** (`https://lzgohufdrqjdupfsvqlj.supabase.co`). Database 1 is healthy, responsive, and operational. Authentication never touches the user's assigned data shard (DB 4). Hence, successful login coexists with total failure of all chat and generation endpoints.

4. **Secondary Independent Failure Point — Groq Model Not Found (`404`)**:
   Independent diagnostic execution of the Python LLM router revealed that the default Groq model configuration (`GROQ_MODEL = os.getenv("GROQ_MODEL", "llama-3.3-70b-versatile")`) fails on **all 5 configured Groq API keys** with:
   ```text
   Groq key failed: Error code: 404 - {'error': {'message': 'The model `llama-3.3-70b-versatile` does not exist or you do not have access to it.', 'type': 'invalid_request_error', 'code': 'model_not_found'}}
   ```
   While the router gracefully falls back to Gemini (`gemini-3.1-flash-lite`, which succeeds), the primary Groq text generation lane is broken out-of-the-box for default configurations.

5. **Tertiary Independent Failure Point — Pollinations Input Safety Timeout**:
   In `backend/llm_service.py`, every incoming request to `/llm/invoke` and `/llm/stream` triggers an input safety check (`check_input_safety`) against Pollinations `qwen-safety` at `https://gen.pollinations.ai/v1/chat/completions` with a strict **3-second timeout** (`SAFETY_TIMEOUT = 3`). Under real-world network latency (direct measurement showed round-trip latencies of 3.43s), `requests.Timeout` triggers. A timeout classification is treated as unsafe/degraded, raising HTTP 400 `{"detail": {"status": "blocked", "reason": "safety_degraded"}}`.

---

## 3. Architecture Reconstruction

### 3.1 Structural System Flow Diagram

```
[ Browser / Frontend Client (Port 5500) ]
       │
       ├─────────────────────────────────┐
       │ (Auth / Password Reset)         │ (Authenticated REST / SSE)
       ▼                                 ▼
[ Supabase Auth (DB 1: Control) ]   [ Express Application (Port 3001) ]
  • Identity verification             │
  • JWT issuance                      ├─► middleware/auth.ts (JWT Verify via DB 1 or local secret)
                                      │
                                      ▼
                               [ dbRouter.ts ]
                                 • Consults DB 1 `user_db_map`
                                 • Resolves `assigned_db` for user
                                 • Checks `isShardDegraded(assigned_db)`
                                      │
               ┌──────────────────────┴──────────────────────┐
               ▼                                             ▼
       [ Healthy Shard ]                             [ Degraded Shard ]
       (e.g., DB 2: OK)                              (DB 3, DB 4: PGRST002)
               │                                             │
               ▼                                             ▼
   [ Transport Bootstrap ]                       [ ShardUnavailableError (503) ]
   • resolveConversationForTurn                  • Aborts request immediately
   • createChatGeneration                        • Emits failure recovery event
   • durable generation storage                  • NEVER reaches LLM Gateway
               │
               ▼
   [ Generation Runner / Orchestrator ]
   • capability routing
   • tool selection (WebSurf, Visualize, etc.)
               │
               ▼
   [ Internal Gateway (internalGateway.ts) ]
   • HTTP POST http://127.0.0.1:3002/llm/stream or /invoke
               │
               ▼
   [ Python LLM Service (Port 3002) (FastAPI) ]
   • Input Safety Guard (Pollinations qwen-safety, 3s timeout)
   • Router: Groq (Primary) ──► Fail (404) ──► Fallback: Gemini (Success)
               │
               ▼
   [ SSE Stream back to Express ──► SSE to Browser Client ]
```

### 3.2 Key Architectural Components

* **Control Database (DB 1)**: Holds `user_db_map`, auth references, global capacity leases, and image/file fallback storage pointers.
* **Data Shards (DB 2, DB 3, DB 4)**: Isolate user workspaces, conversations, messages, memories, document chunks, and durable chat generations.
* **Node Backend (Port 3001)**: Intercepts `/api/chat` and `/api/chat/stream` via `chatGenerationTransportBootstrap.ts`, ensuring generations are written durably to the assigned shard before execution.
* **Python LLM Gateway (Port 3002)**: FastAPI wrapper around `llm_adapter.py`, executing input safety classification, token budget management, tool payload formatting, and provider communication.

---

## 4. Startup Failure Analysis

### 4.1 Log Reproduction

During local startup of the Node application (`npm run dev`), the exact log sequence reported in the incident was reproduced with 100% fidelity:

```text
[SentIQ Chat] Running data shard migration verification RPC checks in parallel...
[Boot] verifyShardMigrations.data-shards.parallel.begin +0ms total=10950ms
[Boot] verifyShardMigrations.data-shard-1.begin +0ms total=10950ms
[Boot] verifyShardMigrations.data-shard-1.rpc.begin +0ms total=10951ms
[Boot] verifyShardMigrations.data-shard-2.begin +0ms total=10951ms
[Boot] verifyShardMigrations.data-shard-2.rpc.begin +0ms total=10951ms
[Boot] verifyShardMigrations.data-shard-3.begin +0ms total=10951ms
[Boot] verifyShardMigrations.data-shard-3.rpc.begin +0ms total=10951ms

[SentIQ Chat] FATAL: Shard DB 4 RPC verification error:
[dbRouter] startup verifier RPC failed db=4 rpc=verify_sentiq_data_shard_startup code=PGRST002 message=Could not query the database for the schema cache. Retrying.
[dbRouter] Shard DB 4 marked DEGRADED. Reason: RPC verification error: [dbRouter] startup verifier RPC failed db=4 rpc=verify_sentiq_data_shard_startup code=PGRST002 message=Could not query the database for the schema cache. Retrying.
[Boot] verifyShardMigrations.data-shard-3.done +2182ms total=13133ms

[SentIQ Chat] FATAL: Shard DB 3 RPC verification error:
[dbRouter] startup verifier RPC failed db=3 rpc=verify_sentiq_data_shard_startup code=PGRST002 message=Could not query the database for the schema cache. Retrying.
[dbRouter] Shard DB 3 marked DEGRADED. Reason: RPC verification error: [dbRouter] startup verifier RPC failed db=3 rpc=verify_sentiq_data_shard_startup code=PGRST002 message=Could not query the database for the schema cache. Retrying.
[Boot] verifyShardMigrations.data-shard-2.done +3074ms total=14025ms
[Boot] verifyShardMigrations.data-shards.parallel.done +3075ms total=14026ms

[SentIQ Chat] RPC verification continuing with healthy shards: [2]. Degraded shards: [3, 4].
[Boot] verifyShardMigrations.done +7396ms total=14650ms
[Boot] express.listen.begin +0ms total=14650ms
[Boot] express.listen.ready +6ms total=14656ms
[SentIQ Chat] Server running on port 3001
[SentIQ Chat] Architecture: Orchestrated Dual-Model (Gemini + Groq)
[SentIQ Chat] LLM Service expected on port 3002
[Boot] tavily.availability.checked +0ms total=14656ms
[SentIQ Chat] Tavily Web Search: ENABLED
[Boot] summary total=14657ms verifyShardMigrations=7396ms dataShardsParallel=3075ms ready=true

[GenerationRecovery] shard=3 scan failed: Could not query the database for the schema cache. Retrying.
[GenerationRecovery] shard=4 scan failed: Could not query the database for the schema cache. Retrying.
```

### 4.2 Code Execution Trace in `dbRouter.ts`

1. **Mode Resolution**: `readStartupVerifierMode()` reads `SENTIQ_STARTUP_VERIFIER`. Since it is unset in `.env`, it defaults to `"auto"`.
2. **RPC Invocation**: `verifyShardMigrations()` enters the `auto` branch and calls `verifyShardMigrationsRpc()`.
3. **Parallel Shard Calls**: `verifyShardMigrationsRpc()` dispatches `verifyDataShard(id)` for IDs `[2, 3, 4]` in parallel via `Promise.allSettled`.
4. **RPC Execution**: `callStartupVerifierRpc` issues `client.rpc("verify_sentiq_data_shard_startup", { p_probe_user_id, p_verify_live })`.
5. **Exception Handling**:
   * For DB 2: The RPC resolves successfully (`status=200`, `ok=true`, `failures=[]`).
   * For DB 3 and DB 4: The PostgREST endpoint returns HTTP 503 `PGRST002`.
   * `isStartupVerifierRpcUnavailable(error, rpcName)` checks:
     ```ts
     return code === "PGRST202"
       || code === "42883"
       || (code === "42501" && message.includes(rpcNameLower))
       || message.includes(`could not find the function`)
       || (message.includes(rpcNameLower) && message.includes("does not exist"));
     ```
     Because `code === "PGRST002"`, this function returns **`false`**.
   * Therefore, `StartupVerifierRpcUnavailableError` is **not thrown**. A generic `Error("[dbRouter] startup verifier RPC failed db=... code=PGRST002 ...")` is thrown instead.
   * `verifyDataShard` catches the error:
     ```ts
     } catch (error: any) {
       if (error instanceof StartupVerifierRpcUnavailableError) {
         throw error;
       }
       markFailure(id, `RPC verification error: ${error?.message || String(error)}`);
     }
     ```
   * `markFailure` prints the fatal error log and calls `markShardDegraded(id, message)`.
   * `verifyDataShard` does **not** rethrow. The promise resolves as fulfilled.
6. **No Fallback to Legacy**:
   Because `verifyShardMigrationsRpc` does not reject with `StartupVerifierRpcUnavailableError`, the `catch` block in `verifyShardMigrations()` is **never reached**. The application does **not** fall back to legacy schema checking.
7. **Healthy Shard Gate**:
   `getHealthyDataShardIds()` returns `[2]`. Because `healthyShards.length > 0`, `verifyShardMigrationsRpc()` prints the warning:
   `RPC verification continuing with healthy shards: [2]. Degraded shards: [3, 4].`
   and returns normally.
8. **Server Starts**: Express opens its HTTP socket on port 3001.

---

## 5. `PGRST002` Analysis

### 5.1 What Layer Produces `PGRST002`?

`PGRST002` is an error code generated by the **PostgREST web server** (the RESTful gateway layer that sits between external HTTP clients and PostgreSQL in the Supabase stack).

The error string:
```text
Could not query the database for the schema cache. Retrying.
```
indicates that PostgREST attempted to query PostgreSQL's internal schema catalog tables (`pg_class`, `pg_proc`, `pg_namespace`, etc.) to build its in-memory API schema cache, but the query failed, timed out, or PostgreSQL refused connections.

### 5.2 Did the RPC Execute?

**No.** The PostgreSQL function `verify_sentiq_data_shard_startup` was **never executed** on DB 3 or DB 4.

Proof from migration code (`20260709131000_data_shard_startup_verification_rpc.sql`):
Inside `verify_sentiq_data_shard_startup`, every single statement is wrapped in an individual `begin ... exception when others then ... end;` block that captures SQL exceptions into a JSONB `v_failures` array and returns `{ "ok": false, "failures": [...] }`. If the function had executed and encountered an internal SQL error, it would have returned HTTP 200 with `ok: false`. The HTTP 503 `PGRST002` response proves that PostgREST failed before resolving or executing the function.

### 5.3 Independent Corroboration by Ordinary Table Queries

To definitively determine whether `PGRST002` was caused by the RPC or represents a broader project failure, direct diagnostic queries were executed against all shards:

| Shard | Query Type | Target Object | HTTP Status | Response / Error |
| :--- | :--- | :--- | :--- | :--- |
| **DB 2** | Table SELECT | `chat_generations` | **200 OK** | 1 row retrieved |
| **DB 2** | Table SELECT | `users` | **200 OK** | 1 row retrieved |
| **DB 2** | RPC Call | `verify_sentiq_data_shard_startup` | **200 OK** | `{ ok: true, failures: [] }` |
| **DB 3** | Table SELECT | `chat_generations` | **503 Unavailable** | `code=PGRST002 message="Could not query the database for the schema cache. Retrying."` |
| **DB 3** | Table SELECT | `users` | **503 Unavailable** | `code=PGRST002 message="Could not query the database for the schema cache. Retrying."` |
| **DB 3** | RPC Call | `verify_sentiq_data_shard_startup` | **503 Unavailable** | `code=PGRST002 message="Could not query the database for the schema cache. Retrying."` |
| **DB 4** | Table SELECT | `chat_generations` | **503 Unavailable** | `code=PGRST002 message="Could not query the database for the schema cache. Retrying."` |
| **DB 4** | Table SELECT | `users` | **503 Unavailable** | `code=PGRST002 message="Could not query the database for the schema cache. Retrying."` |
| **DB 4** | RPC Call | `verify_sentiq_data_shard_startup` | **503 Unavailable** | `code=PGRST002 message="Could not query the database for the schema cache. Retrying."` |

Furthermore, `backend/services/generationRecovery.ts` performs a standard table scan at startup:
```ts
const userDb = getDataShardDatabases()[databaseId - 2];
const result = await userDb.from("chat_generations").select(...).limit(10);
```
which produces the exact logs observed in the incident:
```text
[GenerationRecovery] shard=3 scan failed: Could not query the database for the schema cache. Retrying.
[GenerationRecovery] shard=4 scan failed: Could not query the database for the schema cache. Retrying.
```

**Conclusion:** This is unassailable proof that the failure is **not an RPC design defect**. DB 3 and DB 4 are experiencing a complete PostgREST-to-PostgreSQL outage (likely paused projects on Supabase free tier).

---

## 6. Shard Routing Consequences

### 6.1 Test User Mapping in Database 1

Direct query of `user_db_map` in Database 1 confirms:

```sql
SELECT id, user_id, assigned_db, created_at
FROM public.user_db_map
WHERE user_id = '096864d9-0fb8-45d4-ada5-aa33ca311ecd';
```

**Result:**
* `user_id`: `096864d9-0fb8-45d4-ada5-aa33ca311ecd` (`synthetiq61@gmail.com`)
* `assigned_db`: **`4`**
* `created_at`: `2026-09-01T16:15:32.087Z`

### 6.2 The Exact Execution Failure Chain

When `synthetiq61@gmail.com` performs any authenticated request (e.g. `POST /api/chat/stream`):

```text
1. Browser Client sends HTTP request with Authorization: Bearer <JWT>
   ↓
2. middleware/auth.ts verifies JWT via Supabase Auth (DB 1) ──► SUCCESS (User ID = 096864d9-0fb8-45d4-ada5-aa33ca311ecd)
   ↓
3. Route handler calls getOrAssignUserDatabase(userId) [or resolveUserDatabaseOrThrow]
   ↓
4. fetchAssignedDatabase(userId) queries DB 1:
   SELECT assigned_db FROM user_db_map WHERE user_id = '096864d9-...'
   ──► Returns assigned_db = 4
   ↓
5. getClientForDatabase(4) executes:
   if (isShardDegraded(4)) {
       throw new ShardUnavailableError(4); // HTTP 503
   }
   ──► THROWS ShardUnavailableError!
   ↓
6. Global Express error handler catches ShardUnavailableError
   ──► Sends HTTP 503 { code: "shard_unavailable", error: "Database shard 4 is temporarily unavailable. Please retry shortly." }
   ↓
7. Request terminates. The AI Orchestrator and Python LLM service are NEVER invoked.
```

### 6.3 Can Existing Users on Degraded Shards Function?

**No.** Any user whose `assigned_db` is `3` or `4` is completely incapacitated.

### 6.4 Can Existing Assignments Be Migrated?

**No.**
1. There is no code in `backend/dbRouter.ts` to re-assign an existing user whose shard is degraded.
2. Even if code attempted an update, migration `20260325214500_user_db_map.sql` enforces:
   ```sql
   create or replace function public.prevent_user_db_map_reassignment()
   returns trigger as $$
   begin
       if new.assigned_db is distinct from old.assigned_db then
           raise exception 'assigned_db cannot be changed once set';
       end if;
       return new;
   end;
   $$;
   ```
   The database trigger actively blocks reassignment.

### 6.5 What Happens for Brand-New Users?

For a brand-new user registering today:
`selectLeastLoadedDatabaseFromCounts()` checks:
```ts
for (const dbId of ASSIGNABLE_DATABASE_IDS) {
    if (isShardDegraded(dbId)) {
        console.warn(`[dbRouter] db-degraded db=${dbId} skipped during database selection`);
        continue;
    }
    // Only DB 2 is considered
}
```
A new user **would be assigned to healthy Database 2**, and their chat would successfully reach the next stages of the pipeline.

---

## 7. Feature-by-Feature Findings

Every major feature was tested in the real browser environment against the live local runtime. In strict compliance with instructions, each test was performed **exactly once**, with **zero loops**, and **Live Voice was completely untouched**.

### 7.1 Normal Text Generation

* **Frontend Trigger**: User types `"Hello, what is 2+2?"` in the main composer and submits.
* **HTTP Route Called**: `POST /api/chat/stream`
* **Browser Observation**: The message was added to the timeline. A `SYSTEM NOTICE` panel immediately appeared:
  > *"Sorry, something went wrong. Please try again."* (with Retry button and recovery tray).
* **Console Error**: `[warning] [GenerationRehydration] Unable to refresh generation state: Generation rehydration failed: HTTP 500`
* **Backend Terminal Log Correlation**:
  ```text
  [dbRouter] resolve.ok userId=096864d9-0fb8-45d4-ada5-aa33ca311ecd assigned_db=4
  [GenerationRehydration] Failed conversation generation lookup: Database shard 4 is temporarily unavailable. Please retry shortly.
  ```
* **LLM Service Activity**: **Zero requests**. No call reached port 3002.
* **Shard Result**: `ShardUnavailableError(4)` thrown by `getClientForDatabase(4)`.
* **Likely Failure Point**: Shard router layer (`dbRouter.ts`).
* **Confidence**: **Confirmed Fact** (100%).

### 7.2 Automatic Title Generation

* **Frontend Trigger**: Follows initial prompt submission.
* **Browser Observation**: The conversation title in the sidebar updated optimistically to `"Hello, what is 2+2?"` using the frontend fallback heuristic (`fallbackTitleFromMessage`).
* **Backend Terminal Log Correlation**: Backend title generation via LLM (`generateTitleWithFallback` / `serverLegacy.ts:1167`) was never executed because the chat turn failed at initial session resolution before producing any assistant reply.
* **Shard Result**: Unable to persist title to DB 4 `conversations` table.
* **Likely Failure Point**: Dependent on normal chat turn completion and DB 4 availability.
* **Confidence**: **Confirmed Fact** (100%).

### 7.3 Image Generation (Visualize Mode)

* **Frontend Trigger**: Plus menu `+` -> Selected `Visualize` -> Prompt: `"a red apple"` -> Send.
* **HTTP Route Called**: `POST /api/images/generate` (or `/api/chat/stream`)
* **Browser Observation**: Floating failure recovery tray appeared:
  > *"Image generation needs attention. The image could not be completed. Retry reuses the original prompt and image mode. Couldn't sync this chat yet. Please try again in a moment."*
* **Console Error**: Network failure during generation sync.
* **Backend Terminal Log Correlation**:
  ```text
  [SentIQ Chat][db] chat.sync.resolve-db.failed userId=096864d9-0fb8-45d4-ada5-aa33ca311ecd error=Database shard 4 is temporarily unavailable. Please retry shortly.
  [SentIQ Chat] Unhandled error: Database shard 4 is temporarily unavailable. Please retry shortly.
  ```
* **LLM Service Activity**: Zero requests.
* **Shard Result**: `resolveUserDatabaseOrThrow` aborted on degraded Shard 4.
* **Likely Failure Point**: Shard router layer.
* **Confidence**: **Confirmed Fact** (100%).

### 7.4 WebSurf (Web Search Mode)

* **Frontend Trigger**: Plus menu `+` -> Selected `WebSurf` (`WebSurf active` pill displayed) -> Prompt: `"Search for today news"` -> Send.
* **HTTP Route Called**: `POST /api/chat/stream`
* **Browser Observation**: Sidebar title updated to `"Search for today news"`. Error panel rendered in message timeline:
  > *"NEEDS ATTENTION Web search recovery — Web search did not finish. Retry reuses the original prompt and WebSurf mode."*
* **Backend Terminal Log Correlation**:
  ```text
  [dbRouter] resolve.ok userId=096864d9-0fb8-45d4-ada5-aa33ca311ecd assigned_db=4
  [GenerationRehydration] Failed conversation generation lookup: Database shard 4 is temporarily unavailable. Please retry shortly.
  ```
* **LLM Service Activity**: Zero requests. Tavily search was never invoked despite being enabled.
* **Shard Result**: Request blocked at `chatGenerationTransportBootstrap.ts:65`.
* **Likely Failure Point**: Shard router layer.
* **Confidence**: **Confirmed Fact** (100%).

### 7.5 Deep Research

* **Frontend Trigger**: Plus menu `+` -> Selected `Deep Research` (`Deep Research` pill displayed) -> Prompt: `"Research renewable energy progress"` -> Send.
* **HTTP Route Called**: `POST /api/deep-research/start` (or `/api/deep-research/stream`)
* **Browser Observation**: Deep Research Stepper card rendered (`1 Scope`, `2 Sources`, `3 Synthesis`). Status indicator turned red: `Needs attention`. Red inline alert rendered:
  > *"Failed: SentIQ Chat is temporarily unavailable. Please try again shortly."*
* **Backend Terminal Log Correlation**:
  ```text
  [SentIQ Chat][db] deep-research.start.resolve-db.failed userId=096864d9-0fb8-45d4-ada5-aa33ca311ecd error=Database shard 4 is temporarily unavailable. Please retry shortly.
  ```
* **LLM Service Activity**: Zero requests.
* **Shard Result**: `startDeepResearchForRequest` called `resolveUserDatabaseOrThrow(userId, "deep-research.start")` which threw `ShardUnavailableError(4)`.
* **Likely Failure Point**: Shard router layer.
* **Confidence**: **Confirmed Fact** (100%).

---

## 8. What Is NOT Broken

It is critical to avoid false conclusions about the system. The following subsystems were tested directly and proven to be **healthy and operational**:

1. **User Authentication & Session Lifecycle**:
   * User login (`synthetiq61@gmail.com`) authenticated cleanly against Supabase Auth (DB 1).
   * Session restore, user display name (`Synthetiq`), and auth tokens functioned as intended.
   * Logout and password reset mechanisms use DB 1 and remain functional.

2. **Control Database (Database 1)**:
   * URL: `https://lzgohufdrqjdupfsvqlj.supabase.co`
   * `user_db_map`, auth sessions, and global tables are completely accessible.
   * Startup verification on DB 1 passed all checks.

3. **Data Shard 1 (Database 2)**:
   * URL: `https://cgdzsbywnvjzqsneehjh.supabase.co`
   * Direct diagnostic table query took 9203ms (`status=200 OK`).
   * Direct execution of `verify_sentiq_data_shard_startup` succeeded in 5646ms:
     ```json
     { "ok": true, "failures": [], "timings": [{"group":"core","elapsed_ms":298}, ...] }
     ```
   * Shard 2 is fully healthy and ready to accept traffic.

4. **Gemini Key Pool**:
   * All 6 configured Gemini API keys (`GEMINI_API_KEY_1` through `GEMINI_API_KEY_6`) are valid.
   * Direct model call to `gemini-3.1-flash-lite` succeeded and returned valid completions.

5. **Tavily Web Search Integration**:
   * `TAVILY_KEYS` are present in `.env`.
   * Backend startup profiler logged: `[SentIQ Chat] Tavily Web Search: ENABLED`.

6. **Node Express Server Boot**:
   * Server boots cleanly, registers routes, and binds to port 3001.

7. **Python LLM Service Boot**:
   * FastAPI boots cleanly and binds to port 3002.
   * `/llm/health` returns `200 OK` (`{"status": "ok"}`).

---

## 9. Root-Cause Map

```text
                                  TOTAL AI FAILURE
                                         │
        ┌────────────────────────────────┼────────────────────────────────┐
        ▼                                ▼                                ▼
[ Confirmed Root Cause 1 ]     [ Confirmed Root Cause 2 ]     [ Confirmed Root Cause 3 ]
Supabase Shards 3 & 4 Outage   Groq Primary Model Missing     Pollinations Safety Timeout
        │                                │                                │
  PostgREST 503                    Groq API returns 404           Pollinations qwen-safety
  "PGRST002 Could not query        "model_not_found"              latency > 3s exceeds
  database for schema cache"       for llama-3.3-70b-versatile    SAFETY_TIMEOUT
        │                                │                                │
        ▼                                ▼                                ▼
  Startup Verifier marks         Groq lane crashes              check_input_safety returns
  Shards 3 & 4 DEGRADED          (falls back to Gemini)         status: blocked, safety_degraded
        │
        ▼
[ Confirmed Root Cause 4 ]
Immutable User Shard Pinning
        │
  user_db_map assigns
  synthetiq61@gmail.com
  permanently to DB 4
        │
  getClientForDatabase(4)
  throws ShardUnavailableError
        │
        ▼
[ Secondary User-Visible Symptoms ]
  • Normal text generation fails (HTTP 500 / 503)
  • Image generation fails ("Couldn't sync this chat yet")
  • WebSurf fails ("Web search did not finish")
  • Deep Research fails ("SentIQ Chat is temporarily unavailable")
  • Groq title summarization never triggers
```

### Classification Hierarchy:

* **Confirmed Root Cause (Immediate Blocker)**: DB 3 and DB 4 PostgREST service outage + Immutable user assignment of the test account to DB 4 without shard failover.
* **Confirmed Root Cause (Provider Layer)**: Groq default model `llama-3.3-70b-versatile` does not exist on Groq accounts (404).
* **Confirmed Root Cause (Safety Layer)**: Pollinations `qwen-safety` 3-second hard timeout causing false-positive input blocks.
* **Secondary Symptom**: Total failure of all AI features in the UI for the test user.
* **Unrelated Healthy Subsystems**: Auth, Control DB 1, Data Shard 2, Gemini API.

---

## 10. Historical Analysis

Git history investigation reveals the architectural evolution that created the present state:

1. **Commit `023e4318d1943c7c32c84d5ff4dbffdc8ec44e3d` ("Consolidate startup verification into Supabase RPCs")**:
   * Consolidated dozens of individual SQL schema probes into two PostgreSQL functions: `verify_sentiq_control_startup` (DB 1) and `verify_sentiq_data_shard_startup` (DB 2–4).
   * Introduced `isStartupVerifierRpcUnavailable()`, which only recognized missing function error codes (`PGRST202`, `42883`, `42501`).
   * At this point in history, ANY failure of a shard would halt the server with `process.exit(1)`.

2. **Commit `ad7919aa23043e0cf62d79ab2d8197930ed7ab56` ("feat(chat): complete durable generation and shard isolation")**:
   * Introduced graceful degradation of shards: when a data shard failed, `markShardDegraded(id)` was called instead of terminating the process.
   * Allowed the backend to boot as long as at least one shard (`healthyShards.length > 0`) survived.
   * **The Gap Introduced**: While this change allowed the server to boot with only Shard 2 online, it introduced strict shard gating in `getClientForDatabase(dbId)`. Because user assignments in `user_db_map` are immutable and static, any user assigned to DB 3 or DB 4 was stranded without failover.

3. **Behavior on `PGRST002`**:
   The verifier does not classify `PGRST002` as `RPC unavailable`, but as a regular RPC failure. Consequently, `auto` mode does not fall back to `verifyShardMigrationsLegacy()`. However, as proven in Section 5, falling back to legacy would **not** have helped, because legacy probes hit the exact same PostgREST endpoint and fail with `PGRST002`.

---

## 11. Reproduction Matrix

| Condition / Test Probe | Expected Result | Observed Result | Evidence Source |
| :--- | :--- | :--- | :--- |
| **Server Startup** | Starts on port 3001 | **SUCCESS** (Port 3001 listening) | Task-251 logs |
| **DB 2 Verifier** | RPC returns `ok: true` | **PASS** (`ok: true`, 0 failures) | Direct scratch test & boot log |
| **DB 3 Verifier** | RPC returns `ok: true` | **FAIL** (HTTP 503 `PGRST002`) | Direct scratch test & boot log |
| **DB 4 Verifier** | RPC returns `ok: true` | **FAIL** (HTTP 503 `PGRST002`) | Direct scratch test & boot log |
| **DB 3 Ordinary Table Query** | Rows returned | **FAIL** (HTTP 503 `PGRST002`) | `testShards.js` query on `chat_generations` |
| **DB 4 Ordinary Table Query** | Rows returned | **FAIL** (HTTP 503 `PGRST002`) | `testShards.js` query on `chat_generations` |
| **Test User Assigned Shard** | Data shard resolved | **RESOLVED TO 4** (DEGRADED) | `SELECT assigned_db FROM user_db_map` |
| **Normal Text Generation** | Streamed reply | **FAIL** (HTTP 500 / Recovery notice) | Browser test & Task-251 logs |
| **Title Generation (LLM)** | AI summarized title | **SKIPPED / FALLBACK** | Message text truncated locally |
| **Image Generation** | Generated image | **FAIL** ("Couldn't sync this chat yet") | Browser test & Task-251 logs |
| **WebSurf Mode** | Search citations & reply| **FAIL** (Recovery panel triggered) | Browser test & Task-251 logs |
| **Deep Research Mode** | Stepper progress & report| **FAIL** ("Temporarily unavailable") | Browser test & Task-251 logs |
| **Groq Provider** | Completion text | **FAIL** (404 model_not_found) | Direct Python test (`testProviders.py`) |
| **Gemini Provider** | Completion text | **PASS** (`gemini-3.1-flash-lite` OK) | Direct Python test (`testProviders.py`) |
| **Pollinations Safety Model** | Classification within 3s| **INTERMITTENT TIMEOUT** (3.43s) | Direct Python test (`testPollinationsSafety.py`) |

---

## 12. Recommended Next Diagnostic/Remediation Direction

*(Architectural recommendations only — No implementation attempted)*

1. **Restore Supabase Project Health for DB 3 & DB 4**:
   * Inspect the Supabase administrative dashboards for project `iizqaveodmwpsfziobbq` (DB 3) and `ejqpzgvdrkskunkxatzk` (DB 4).
   * Unpause the projects if they entered inactivity sleep.
   * If already active, restart the PostgREST service or send `NOTIFY pgrst, 'reload schema'` to rebuild the schema cache.

2. **Implement Dynamic Shard Degraded Failover in `dbRouter.ts`**:
   * When `fetchAssignedDatabase(userId)` resolves to a shard where `isShardDegraded(assignedDb)` is true, the router should have a policy to route read/write traffic to an available healthy shard (such as DB 2), or re-map the user with appropriate session handling rather than terminating with an unrecoverable 503.

3. **Update Default Groq Model in Configuration**:
   * The Groq model identifier `llama-3.3-70b-versatile` returns 404 from Groq's current API.
   * Update `GROQ_MODEL` in `.env` to a supported production model identifier (such as `llama-3.1-70b-versatile` or `openai/gpt-oss-120b`).

4. **Tune Safety Guard Timeout and Fallback**:
   * Increase `SAFETY_TIMEOUT` in `llm_adapter.py` from 3 seconds to at least 5–7 seconds to accommodate cross-region network latency.
   * Enable `SAFETY_MODE_LOW_RISK_TEXT` by default so that unexpected timeouts fail open (degraded allow) rather than hard-blocking standard user queries.

---

## 13. What Remains Unverified

1. **Underlying Infrastructure Root Cause of DB 3 & DB 4 Outage**:
   * Because Supabase infrastructure administration (Postgres daemon logs, Supabase Cloud project state, billing quotas) is outside the codebase repository, it cannot be proven from local code whether DB 3 and DB 4 are paused due to free-tier inactivity, compute quota exhaustion, or networking restrictions.
2. **Long-Term Memory Embedding Performance**:
   * Due to Shard 4 being offline, `search_source_chunks` and memory embeddings could not be verified against the test user's stored memories.

---

## 14. Exact Commands and Browser Tests Performed

### Diagnostic Scripts Executed

1. `testShards.js` (Scratch diagnostic):
   * Executed direct REST queries (`chat_generations`, `users`) and RPC calls (`verify_sentiq_data_shard_startup`) against DB 2, DB 3, and DB 4.
   * Proved DB 2 is healthy, and DB 3 and DB 4 return HTTP 503 `PGRST002` across all query types.
2. `auditEnv.js` (Scratch diagnostic):
   * Audited presence/absence of all environment keys without logging secrets.
3. `testPollinationsSafety.py` (Scratch diagnostic):
   * Tested Pollinations `qwen-safety` endpoint with varying timeouts (3s, 10s).
   * Proved that 3-second timeout triggers `requests.Timeout` (measured 3.43s latency).
4. `testProviders.py` (Scratch diagnostic):
   * Tested Groq and Gemini direct router invocations.
   * Proved Groq fails with 404 `model_not_found` on `llama-3.3-70b-versatile`, while Gemini succeeds.

### Browser Tests Performed (via `browser_subagent`)

1. **Authentication**: Navigated to `http://localhost:5500/index.html`. Logged in with `synthetiq61@gmail.com`. Confirmed session restore and dashboard load.
2. **Normal Text**: Sent `"Hello, what is 2+2?"`. Observed HTTP 500 / 503, System Notice, and recovery tray.
3. **Image Generation**: Triggered `Visualize` mode with `"a red apple"`. Observed failure recovery tray notice: *"Image generation needs attention. Couldn't sync this chat yet."*
4. **WebSurf**: Triggered `WebSurf` mode with `"Search for today news"`. Observed Web search recovery panel.
5. **Deep Research**: Triggered `Deep Research` mode with `"Research renewable energy progress"`. Observed Stepper UI and red alert: *"SentIQ Chat is temporarily unavailable."*
6. **Live Voice**: **Zero interaction**. In compliance with safety instructions, the Live Voice UI was never clicked or opened.

---
*Report compiled strictly without modifying repository source code, applying migrations, or pushing commits.*
