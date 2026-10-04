
The important result is this: 

**The main failure is an internal Live-session lifecycle bug, not Gemini quota exhaustion** The third-open → **“Live voice busy”** → later **“Audio connection failed”** behavior can be explained from the repository’s own code and database lifecycle. 

The current implementation has **several separate correctness problems that reinforce each other** . 

Current branch inspected: master, HEAD 877c1c90e09e7cd564cf98c9219e7a7862a75061. 

**1. The most important bug: closing the Live UI does not necessarily end the Live session** 

This is the root of your microphone-leak problem, and it is also the strongest explanation for the later busy state. 

The adaptive panel framework closes the panel by eventually causing the panel root to become hidden and dispatching: 

sentiq-panel-closed 

But the Live surface's handler for that event only does presentation cleanup: 

closeTranscript(); 

document.body.classList.remove("live-beta-open"); 

window.SentIQPanels?.sync?.(); 

It does **not** call the Live controller's finishSession(). 

Meanwhile, the actual hardware/socket cleanup is located inside finishSession() → releaseLocalResources(), which stops: 

mediaStream.getTracks().stop() 

AudioContext.close() 

WebSocket.close() 

inputCapture.stop() 

So there are two distinct concepts in the current system: 

**“The panel is hidden”** 

and 

**“The Live session is terminated.”** 

They are not guaranteed to happen together. Relevant code: <u>Live controller — live-controller.js Adaptve panel framework i</u> — adaptvei -panel-framework.js <u>Live surface — live-surface.js</u> 

**2. That directly creates your “third attempt = busy” scenario** This is the important chain. Your free-tier policy is: dailySeconds       = 120 maxSessionSeconds  = 120 maxActiveSessions  = 1 And the database explicitly considers both: provisioning active as active Live sessions. The reservation function checks: active_count from public.live_sessions where owner_user_id = ... and status in ('provisioning', 'active') and expires_at > now(); if active_count >= p_max_active ... denial_reason = 'active_limit' So suppose: **Session 1** 

You open Live. 

A real Live session is created in the DB: 

provisioning → active 

You then close the modal through a dismissal route that hides the UI but does not execute the canonical Live shutdown. 

Result: 

Browser: 

panel = hidden 

microphone = still alive 

socket = potentially still alive 

currentSession = potentially still alive 

Database: 

live_sessions = ACTIVE 

# **Session 2** 

Depending on exactly which client path is triggered, the frontend can already have: if (currentSession || ending) return; 

So the client itself contains a second lock. 

If the request gets as far as the server, the DB sees: 

active_sessions = 1 

max_active_sessions = 1 

and returns: 

live_active_limit 

or the generic UI-facing busy path. 

# **Session 3** 

Same underlying orphaning continues until the stale-session cleanup runs and the reservation expires. 

That is why your observation that: 

“after some time it works again” 

is extremely significant. 

The repository has a **stale cleanup mechanism specifically because these reservations can survive** . 

Migration 20260704120000_harden_live_session_lifecycle.sql even explicitly contains logic to clean up unstarted/stale Live sessions. 

<u>Live session service — liveSessionService.ts</u> 

<u>Live usage schema — 20260703120000_add_live_usage_policy.sql Lifecycle hardening migraton i</u> — 20260704120000_harden_live_session_lifecycle.sql 

So **this is not an assumption about Gemini** . The repository itself provides the exact mechanism needed for the symptom. 

**3. There is a second independent lock: the frontend blocks re-entry while currentSession exists** 

The client has: 

if (currentSession || ending) return; 

at the beginning of startSession(). 

That means an orphaned client-side session is enough to prevent another startup even before server-side quota/capacity is considered. 

So you effectively have **two session-lifecycle authorities** : 

Frontend in-memory currentSession 

+ 

Supabase live_sessions 

Neither is guaranteed to be cleared by merely dismissing the panel. 

That is exactly the kind of split-brain lifecycle that we need to eliminate. 

**4. Your “Connecting...” delay is also real and very specifically identifiable** 

You don't merely have a vague startup delay. 

The frontend currently performs a **serial startup pipeline** . 

The rough order is: 

click Live 

↓ 

refreshAvailability() 

↓ showPanel() ↓ 

unlock AudioContext ↓ prepareLiveConversation() ↓ 

prepareLiveConversation() 

POST /api/live/session-token ↓ 

getUserMedia() 

↓ 

create WebSocket 

↓ 

wait setupComplete 

↓ 

WAIT 750 ms 

↓ 

start PCM capture 

↓ 

POST /started 

↓ 

Listening 

There is an explicit: 

const LIVE_HANDSHAKE_STABILITY_MS = 750; 

and: 

await waitForHandshakeStability(); 

So the “it says Connecting and takes time before Listening” behavior is not imagined. There is literally a fixed 750 ms artificial wait in the critical path. 

More importantly, **even before that 750 ms** , the UI is waiting on several operations. 

The largest conceptual mistake is: 

the UI presentation is coupled to backend readiness. 

Your desired behavior is the inverse: 

USER CLICKS 

↓ UI OPENS IMMEDIATELY ↓ 

bootstrap happens in parallel/background ↓ 

actual audio becomes ready as soon as technically possible 

Current behavior is: 

USER CLICKS 

↓ 

bootstrap 

↓ 

bootstrap ↓ 

bootstrap 

↓ 

UI becomes fully useful That needs to change. 

# **5. Backend startup is also serial and expensive** 

LiveSessionService.createSession() does a substantial chain before returning the ephemeral token. 

It does, among other things: 

availability check 

→ stale cleanup → plan resolution → DB reservation → persistence.prepareContext() 

→ choose Gemini key 

→ durable capacity reservation → HTTPS ephemeral-token request to Gemini 

→ DB activation 

→ return token/history 

And the Gemini token request has an **8-second timeout** . 

So the frontend cannot even open its WebSocket until all of that has succeeded. 

This is the actual reason your request: 

“Synchronizations, everything causing delay MUST happen in background without impacting frontend responsiveness.” 

requires an architectural change rather than simply changing a spinner. 

<u>Gemini Live token service — geminiLiveTokenService.ts</u> 

**6. There is a very concrete 6-key bug: Live currently uses only 5 keys** 

This one is especially important. 

Your environment/template contains: 

GEMINI_API_KEY_1 

GEMINI_API_KEY_6 

But the Live key pool actually declares: 

const LIVE_KEY_ENV_NAMES = [ 

"GEMINI_API_KEY_1", 

"GEMINI_API_KEY_2", "GEMINI_API_KEY_3", "GEMINI_API_KEY_4", "GEMINI_API_KEY_5", ] 

There is **no _6** . 

Even worse, the database schema independently hardcodes: 

key_slot smallint check (key_slot between 1 and 5) 

So the repository currently has a **5-key Live implementation despite the six-key deployment model you intended** . 

That absolutely needs fixing. 

It is not, by itself, the root cause of your third-open bug. But it is a genuine production defect and means your intended failover capacity is currently not what you think it is. <u>Gemini Live key pool — geminiLiveKeyPool.ts Live usage migraton i</u> — 20260703120000_add_live_usage_policy.sql 

# **7. The API rate limiter is NOT the reason for the third attempt** 

I specifically checked this. 

Live token creation is attached to: 

aiRateLimiter 

which allows at least: 60 requests/minute 

and /live/status is explicitly exempted from the general limiter. 

Opening Live three times is nowhere near that threshold. 

So I would **not** waste time trying to “fix” Express rate limiting for this problem. 

<u>Rate limiter — rateLimiter.ts</u> 

# **8. There is another problem: “busy” is being used for infrastructure failures** 

getStatus() catches errors from the capacity/status path and does: 

return unavailable("busy"); 

So the word **busy** currently means more than “there is genuinely an active-capacity problem.” 

It can effectively mean: 

actual capacity problem OR database problem OR status calculation problem OR capacity lookup failure That is bad production semantics. 

The frontend needs to be able to distinguish: 

ACTIVE_SESSION NO_DAILY_TIME PROVIDER_CAPACITY INTERNAL_STATUS_ERROR AUTH_ERROR CONFIG_ERROR 

rather than turning several unrelated cases into “Busy.” 

**9. Provider session resumption is configured, but the client isn't actually making use of it** This is another serious production-readiness gap. 

The token setup already includes: sessionResumption: {} contextWindowCompression: { slidingWindow: {} } So the current design clearly intends to support Gemini session resumption. But in the frontend I found no complete reconnect flow that: 

receives SessionResumptionUpdate 

→ stores latest resumption handle 

→ detects GoAway 

→ reconnects 

→ resumes the existing session 

Instead, the current behavior on an unexpected socket close is essentially: 

WebSocket closes 

→ websocket_failed 

→ failSession() 

→ end Live 

Google's current Live API guidance explicitly recommends retaining the latest resumption token and using it to seamlessly reconnect, and recommends handling GoAway before termination. Google AI for Developers 

So this is something I would absolutely fix before calling Live production-ready. 

**10. Provider socket failures aren't updating Gemini key health** 

The current key pool does have a cooldown/failure mechanism. 

But markFailure() is tied to the **token provisioning** failure path. 

A post-token WebSocket failure is handled on the frontend and turned into: 

websocket_failed 

but the selected Gemini key is not correspondingly marked unhealthy. 

That means you can have: 

Key 2 

↓ 

token succeeds 

↓ 

WebSocket setup repeatedly fails 

↓ 

Key 2 remains considered healthy 

↓ 

next attempt chooses Key 2 again 

That is not a robust key-failover loop. 

The fix needs to distinguish: 

browser/network failure 

from 

Gemini/provider-attributable failure 

because you obviously don't want a user's Wi-Fi hiccup to quarantine a Gemini key. 

**11. The current “new chat after every Live session” requirement is NOT actually enforced** This is another important finding. 

The frontend currently calls: prepareLiveConversation() before creating the Live session. 

And that function uses the **current conversation** when one already exists. 

So conceptually the current system is: 

Current chat 

↓ 

Live uses current chat 

whereas your desired contract is: 

Current chat 

↓ 

used only as CONTEXT SOURCE 

↓ 

Live session gets NEW destination chat 

Your backend persistence layer also accepts the passed conversation ID: if (conversationId) { 

await getOwnedConversation(...) 

} else { 

conversationId = randomUUID() 

createConversation(...) 

} 

So the current behavior does not guarantee a fresh destination conversation on every session. 

That means the requirement: 

second Live session launched from the same chat must write to another new chat needs to become a **hard backend invariant** , not merely a frontend convention. <u>Live persistence — sentqLivePersistence.tsi</u> 

<u>Chat controller — chat-controller.js</u> 

# **12. Closing is currently too synchronous** 

The current close sequence is essentially: 

click End 

↓ 

stop local resources 

↓ 

POST commit transcript ↓ 

POST end session 

↓ refresh chat ↓ 

refresh Live status 

And commitSession() itself does: 

persist transcript 

↓ 

generate title 

↓ 

finalize session 

So the UI is coupled to: 

database writes 

+ 

title generation 

+ 

session finalization 

+ 

conversation refresh 

This is precisely the opposite of the “instant” behavior you're trying to build. 

There is an interesting clue in the repository: serverLegacy.ts already contains a helper called: 

scheduleAutoTitleConversation(...) 

which performs title generation asynchronously. 

But the Live title path isn't using that separation; it awaits title generation inside the Live commit flow. 

That should be corrected. 

<u>Live ttle/commit orchestrati on i</u> — serverLegacy.ts 

**13. There is a production-scale problem with the in-memory session/key state** 

LiveSessionService contains: 

private readonly sessions = new Map<string, LiveSessionRecord>(); 

and GeminiLiveKeyPool keeps things such as: 

activeSessions 

cooldownUntil lastSelectedAt 

consecutiveFailures 

in process memory. 

That's okay as an optimization, but it is **not a safe source of truth once Azure runs multiple replicas** . 

Your durable Supabase tables already exist for exactly this reason. 

A production implementation should make: Supabase = authoritative state 

Node memory = cache/optimization only 

not the other way around. 

This becomes especially important when one Live session is created on replica A and a subsequent request is routed to replica B. 

# **What I would NOT do** 

I would **not** solve this by simply: 

increase rate limits 

increase Gemini keys add retries 

add a longer timeout 

change the spinner 

Those would mask symptoms. 

The architecture needs to be corrected first. 

**Target architecture for production Live** 

**A. One canonical Live shutdown path** 

There should be exactly one lifecycle function, conceptually: 

terminateLiveSession(reason) 

Every termination route funnels into it: 

X 

outside click Escape 

max duration Gemini GoAway WebSocket terminal failure mic failure pagehide auth loss And it must be **idempotent** . Meaning: close() close() close() still produces: one logical termination one commit one finalization one resource teardown No duplicate DB writes. 

# **B. UI closes immediately; cleanup happens independently** 

The close path should be: 

USER CLOSES LIVE 

- │ `├` ── stop microphone NOW `├` ── stop AudioContext NOW `├` ── stop capture NOW `├` ── close socket NOW `├` ── hide modal NOW 

- │ 

- `├` ── stop microphone NOW 

- `├` ── stop AudioContext NOW 

└── background: 

commit transcript 

finalize DB session 

generate title 

refresh conversations 

The user should not sit inside a modal waiting for Supabase. 

**C. Make a new conversation per Live session** 

I recommend changing the contract to: 

sourceConversationId 

liveConversationId 

where: 

sourceConversationId 

= chat the user was in when they clicked Live. 

liveConversationId 

= newly-created chat owned exclusively by that Live session. 

The Live session should always get: 

ONE session 

→ ONE new conversation 

That guarantees: 

Session 1 → Chat A 

Session 2 → Chat B 

Session 3 → Chat C 

even when all three were launched from the same original chat. 

This should be enforced server-side. 

# **D. Do not make prepareLiveConversation() a startup dependency** 

The frontend shouldn't have to synchronously ask: 

“Which conversation am I supposed to use?” 

before Live can begin. Instead: 

current chat ID ↓ sent as source context ↓ backend creates new Live destination conversation ↓ 

returned with session token 

or, even better, the backend performs conversation creation/context preparation as part of the Live bootstrap and the frontend simply receives: 

{ "sessionId": "...", "liveConversationId": "...", "sourceConversationId": "..." } 

**E. Remove the artificial 750 ms readiness wait** 

The 750 ms delay should disappear. 

Instead, readiness should be based on actual states: 

WebSocket open 

+ 

setupComplete received 

+ 

capture successfully started 

No arbitrary sleep. 

Gemini's current guidance is to keep real-time audio chunks small; your current PCM chunking is already around 100 ms, so I **would not identify audio chunk size as your current** 

**root cause** . Google recommends small 20–100 ms chunks and 16 kHz resampling; your implementation is already within that general range. Google AI for Developers 

**F. Six-key Live pool, properly** 

The final model should be: 

GEMINI_API_KEY_1 GEMINI_API_KEY_2 GEMINI_API_KEY_3 GEMINI_API_KEY_4 GEMINI_API_KEY_5 GEMINI_API_KEY_6 with: 

durable capacity 

+ 

key health 

+ cooldown 

+ 

failover 

+ 

replica-safe selection 

I would also stop hardcoding the database schema to 1–5. 

Prefer a configuration-driven slot model so this doesn't happen again when a seventh key is added. 

# **G. Durable finalization** 

For “production ready”, I would not depend on: 

void somePromise() alone. 

A container can restart. A replica can disappear. A browser can terminate. So Live finalization should have a durable state such as: 

session 

↓ finalization_requested ↓ transcript_pending ↓ transcript_committed ↓ session_finalized ↓ 

title_pending ↓ title_completed 

This can be implemented using a small Live-specific durable outbox/job mechanism. The key property is: 

losing the HTTP request must not lose the transcript. 

# **H. Gemini reconnect/resumption** 

The final WebSocket state machine should support: 

CONNECTED 

↓ RUNNING 

↓ GO_AWAY 

↓ 

# RECONNECTING 

↓ 

RESUMING 

↓ RUNNING rather than: GO_AWAY ↓ 

FAIL ↓ 

LOSE SESSION 

Google explicitly documents session resumption and GoAway handling for Live reliability. <u>Google AI for Developers</u> 

# **I. Fix status semantics** 

/api/live/status should become advisory. 

It shouldn't be a mandatory gate to showing the UI. 

And: 

busy 

should mean: 

actual Live capacity is currently unavailable. 

It should not mean: 

something somewhere in status calculation threw an exception. 

**The implementation phases I recommend** 

# **Phase 0 — Freeze behavior with regression tests** 

Before changing implementation, add tests for the exact failures you reported: 

open → close by X → open open → close outside → open open → Escape → open open → close → open → close → open open → close → open from same chat Also assert: microphone track stopped WebSocket closed no orphaned active DB session exactly one transcript exactly one new conversation per session 

This is extremely important because otherwise Gemini/Antigravity can “fix” the UX while accidentally breaking persistence. 

**Phase 1 — Database contract** 

Likely migration work: 

**Required** 

**6-key compatibility** 

Change: 

key_slot between 1 and 5 

to the new contract. 

# **Recommended** 

Add durable Live finalization metadata, e.g.: 

source_conversation_id transcript_status finalization_status transcript_committed_at finalization_requested_at 

title_status 

plus whatever durable queue/outbox structure we settle on. 

# **Important** 

The existing migration comments still mention: 

DB1, DB2, DB3, DB4 

while your current deployment architecture is DB1/DB2/DB3. 

That needs to be cleaned up as part of the migration work so we don't leave the old fourdatabase contract misleading future tooling. 

Your current migration workflow already deploys: 

DB1 control DB2 data shard DB3 data shard through .github/workflows/supabase-migrations.yml. <u>Supabase migraton workfi</u> low 

# **Phase 2 — Backend Live lifecycle rewrite** 

Core changes: createSession() markStarted() commit() end() 

cleanup() 

need one coherent lifecycle. 

Especially: 

create → active → running → finalizing 

# → finalized 

instead of allowing UI state, local map state and durable state to drift independently. 

I also want idempotency based on sessionId throughout. 

# **Phase 3 — Frontend Live rewrite** 

# **Remove** 

End 

Transcript button 

in-modal transcript UI 

# **Keep** 

X 

Mute 

and the panel should be dismissible through: 

X 

outside 

Escape 

with **all three calling the same termination function** . 

Mute remains the central interaction. 

The visual transcript can remain an internal data structure for persistence; it does not need to be a visible control. 

# **Phase 4 — Instant startup** 

The click handler should roughly become: 

click 

↓ 

show Live surface immediately 

↓ 

start async bootstrap 

`├` ── auth 

`├` ── microphone 

`├` ── session provisioning └── websocket ↓ 

Listening as soon as actual capture is ready No: refreshAvailability() → await → show modal and no arbitrary: await sleep(750) 

# **Phase 5 — Key management + reconnect** 

Implement: 6-key pool + durable key health + proper failover + session resumption + GoAway reconnect 

with careful classification of failures. 

# **Phase 6 — Production observability** 

I would add explicit timing telemetry for: live_click_to_panel live_click_to_token 

live_token_to_ws_open live_ws_open_to_setup live_setup_to_first_input live_setup_to_first_output live_close_to_local_cleanup live_close_to_transcript_commit live_close_to_finalization And: session_id key_slot failure_class reconnect_count replica conversation_id That lets us stop guessing. After deployment, you'd be able to answer: Why did this Live session take 1.8 seconds? with an actual breakdown. 

**Phase 7 — Automated validation** 

The production gate should include: 

**Lifecycle** 10 consecutive open/close cycles with remaining quota. 

**Same chat** Chat A → Live 1 → Chat B → Live 2 → Chat C 

→ Live 3 → Chat D 

# **Failure recovery** 

key 1 fails 

→ key 2 succeeds 

**Provider reconnect** 

GoAway 

→ resumption 

→ conversation continues 

# **Dismissal** 

outside click 

→ mic stops immediately 

→ socket closes 

→ transcript persists 

# **Double-close** 

X + Escape race 

must still create only one finalization. 

# **Azure deployment plan** 

Your existing Azure deployment mechanism is actually in a good place for this work. The current workflow already uses: 

immutable SHA image 

→ revision copy 

→ candidate /ready validation 

→ image verification 

→ traffic switch 

→ rollback 

and Azure documents revision copy and multiple-revision traffic controls for exactly this kind of controlled deployment. Microsof Learnt 

So I would **preserve that deployment architecture** , not replace it. 

**Release sequence** 

1. Merge DB migration 

2. Migration workflow validates 

3. DB1 migration 

4. DB2 migration 

5. DB3 migration 

6. Backend tests 

7. Build immutable Azure image 

8. Deploy candidate revision 

9. /ready 

10. Live-specific smoke tests 

11. switch traffic 

12. production browser test 

# **Gemini API keys in Azure** 

This is especially important. 

The six Gemini keys need to exist in Azure as production secrets and be mapped to the runtime environment as: 

GEMINI_API_KEY_1 

# GEMINI_API_KEY_6 

The current repository does not contain those secret values, so I can verify the code's expected names, but **I cannot honestly claim the current production Container App actually has all six correctly mapped without inspecting the Azure environment** . 

Also, Azure Container Apps treats secrets at the application level, and changes to secrets do not automatically propagate into an already-running revision; a new revision or restart is required. Microsof Learnt 

So key rotation should be part of the deployment procedure. 

# **One more deployment detail: frontend and backend are separate** 

The repo's Azure tests explicitly treat frontend/** as hosted outside the Azure backend deployment path. 

So the eventual release is really: 

Backend: 

GitHub → Azure Container Apps 

Frontend: 

GitHub/frontend → Cloudflare-hosted frontend 

That means the Live fix must be versioned/deployed on both sides. 

The backend can be perfectly fixed while an old Cloudflare frontend still behaves like the old implementation. 

# **What I would tell Gemini in Antigravity later** 

I would **not** give Gemini a vague prompt like: 

“Fix Live Voice performance.” 

That is too dangerous for this repository. 

The eventual Antigravity prompt should force Gemini to work in this order: 

**1. Repository-grounded diagnosis** 

Tell it to inspect master first and explicitly verify: 

live-controller.js 

live-surface.js 

adaptive-panel-framework.js adaptive-panel-state.js 

liveSessionService.ts 

geminiLiveKeyPool.ts 

geminiLiveTokenService.ts 

sentiqLivePersistence.ts 

liveRoutes.ts 

chat-controller.js 

rateLimiter.ts live migrations Azure workflow migration workflow Live tests 

Then require it to state the exact failure chain before changing code. 

# **2. Explicit invariants** 

The prompt should impose hard contracts: 

UI dismissal == session termination every Live session == one new conversation 

same source chat == never reused as transcript destination 

mic never survives modal close 

double termination == idempotent 6 Gemini keys == available to Live status "busy" != infrastructure error provider reconnect != session loss 

closing UI != waiting for DB/title work 

# **3. Migration discipline** 

Gemini should: create migration run migration generator 

verify DB1/DB2/DB3 tracks 

update migration contracts 

run migration tests 

before touching deployment. 

# **4. Test-first implementation** 

The prompt should explicitly require regression tests for the **exact failure sequences you observed** , not only unit tests. 

# **5. Deployment discipline** 

Gemini should not “just change YAML.” 

It should: 

validate image validate env/secret references 

build SHA-tagged image 

deploy candidate revision 

wait for healthy 

test /ready 

test Live endpoints 

verify exact image 

switch traffic 

run post-deploy smoke tests 

# **6. No unrelated refactors** 

This is particularly important for SentIQ Chat because the repo already contains a lot of infrastructure. 

The eventual prompt should tell Gemini: 

Fix Live Voice without destabilizing the existing chat, model routing, billing, Supabase sharding, generation, memory, image, or deployment paths. 

**My diagnosis, distilled** 

I would classify the current problems like this: 

**Problem Evidence UI closes without guaranteed Live teardown Confirmed root cause Orphaned active/provisioning session causes later busy Confirmed causal chain Frontend currentSession can independently block re-entry Confirmed** 

|**Problem**|**Evidence**|
|---|---|
|**Startup waits on backend work before useful UI state**|**Confirmed**|
|**Artificial 750 ms startup delay**|**Confirmed**|
|**Current chat is reused instead of guaranteed fresh Live chat**|**Confirmed**|
|**Only 5 Live Gemini keys are loaded**|**Confirmed bug**|
|**Status infrastructure errors can become busy**|**Confirmed bug**|
|**Provider reconnect/resumption incomplete**|**Confirmed production gap**|
|**Socket failures don't feed provider health back to key pool**|**Confirmed production gap**|
|**In-memory session/key state isn't authoritative across replicas**|**i** **Confirmed scalability risk**|
|**Gemini rate limiting is the primary third-attempt cause**|**Not supported by code**|



So I would **not** start by tuning Gemini. 

The first thing to repair is the **Live lifecycle contract** . Once that is fixed, the startup path, fresh-chat semantics, six-key routing, and provider-resumption layer can be rebuilt around it cleanly. 

# **Proposed next step** 

Before we write the Antigravity/Gemini prompt, the next useful step is to turn this into a **formal implementation specification** : exact files to change, exact API contract changes, exact migration objects, state machine, regression tests, and the precise order in which Gemini should implement and validate them. That specification should be the source document from which the final Antigravity prompt is generated. 

**SentIQ Live — Formal Production-Readiness Implementation Specification** 

**Version: Draft 1.0** 

**Status: Design/specification only — do not prompt Gemini/Antigravity yet** 

This is the implementation blueprint that should sit **between the repository diagnosis and the eventual Gemini/Antigravity prompt** . 

The intent is to turn the findings into explicit engineering contracts so Gemini cannot “solve the symptom” while leaving the underlying lifecycle broken. 

# **1. Product contract** 

The final Live Voice behavior must be: 

User clicks Live 

↓ 

Live UI appears immediately 

↓ Mic/WebSocket/session initialization proceeds asynchronously ↓ Live becomes usable as soon as technically ready ↓ 

User speaks 

↓ 

User closes via X / outside click / Escape ↓ 

Mic stops immediately 

WebSocket stops immediately 

UI closes immediately 

↓ 

Transcript persistence + session finalization + title generation continue independently 

↓ 

A NEW chat containing the Live transcript is available 

For every distinct Live session: 

1 Live session 

= 

1 unique Live transcript 

= 

1 unique destination conversation = 

# 1 finalization 

A source chat is only a **context source** . It is never the destination for the Live transcript. 

# **2. Hard invariants** 

These are the rules the implementation must make impossible to violate. 

**INV-01 — UI dismissal is session termination** 

Any of these: 

X outside click Escape max duration pagehide/navigation authentication loss terminal provider failure microphone failure must eventually invoke the **same idempotent termination path** . There must not be a code path where: panel.hidden = true while the Live session remains active. 

**INV-02 — Microphone lifetime is bounded by session lifetime** 

After logical termination: mediaStream.getTracks().forEach(track => track.stop()) must happen immediately. No hidden modal may retain an active microphone. Acceptance condition: Live closed → every MediaStreamTrack.readyState === "ended" 

# **INV-03 — No duplicate termination** 

These racing together: 

X Escape outside click WebSocket close must produce only: one logical end one transcript commit one usage finalization one capacity release one conversation destination 

# **INV-04 — Every Live session gets a fresh destination chat** 

Example: Existing Chat A 

Live #1 → Chat B Live #2 → Chat C Live #3 → Chat D Even when: Chat A → Live #1 Chat A → Live #2 

is done immediately one after another. 

**INV-05 — Source and destination conversations are separate concepts** Use: 

sourceConversationId 

liveConversationId 

Never overload one conversationId to mean both. 

The browser may send: sourceConversationId but it must **not** choose the destination conversation ID. The backend creates/owns that relationship. 

**INV-06 — Time quota, not session-count quota** 

Current repository already deliberately passes an enormous legacy value: p_daily_sessions = 2_147_483_647 

so completed calls do not exhaust an independent session-count quota. This behavior should be preserved. 

For Free: 

daily allowance = 120 seconds maximum single session = 120 seconds Therefore: 

60-second session 

+ 

60-second session 

= 

valid 

but: 

120-second session + 

another session 

= 

daily time exhausted 

The UI must never tell the user that they are limited to “one session”. 

# **INV-07 — UI readiness is not the same thing as backend readiness** 

The visible Live surface must appear immediately. 

No user-visible: 

Connecting... 

Getting Live voice ready... 

blocking experience. 

There can be an **internal** bootstrap state, but visible state transitions must not make backend setup latency feel like modal latency. 

A browser permission prompt is an unavoidable browser-controlled exception. 

# **INV-08 — No arbitrary startup sleeps** 

The current: 

LIVE_HANDSHAKE_STABILITY_MS = 750 

and: 

await waitForHandshakeStability() 

must be removed from the critical path. 

Readiness must be event/state based. 

# **INV-09 — Durable state is authoritative** 

Node process memory may cache state. 

It must not be the final authority for: 

whether a session is active 

whether capacity is reserved 

whether a session is finalized whether transcript is committed 

This is essential because Azure Container Apps can run multiple replicas. 

# **INV-10 — Gemini failures must not masquerade as arbitrary “busy”** 

The system must distinguish at minimum: 

daily_time_exhausted 

user_active_session 

global_capacity 

per_key_capacity 

provider_auth provider_configuration provider_capacity 

network 

timeout 

internal_database_failure 

A database outage must never be presented as: 

Live voice is busy 

unless actual capacity is known to be unavailable. 

**3. Target Live state machine** 

**Backend state machine** 

┌────────────────────┐ │     PROVISIONING   │ └───────── `┬` ──────────┘ │ token + activation 

│ ▼ 

┌────────────────────┐ │       ACTIVE      │ 

└───────── `┬` ──────────┘ │ audio started │ ▼ ┌────────────────────┐ │      RUNNING      │ └───────── `┬` ──────────┘ │ 

close / timeout / 

error / navigation 

│ ▼ ┌────────────────────┐ │    FINALIZING     │ └───────── `┬` ──────────┘ │ transcript + usage │ ▼ ┌────────────────────┐ │       ENDED       │ └────────────────────┘ 

Startup failure before usable audio: 

PROVISIONING 

↓ 

CANCELLED 

Stale startup: 

# PROVISIONING 

↓ 

CANCELLED + reservation refunded Stale running session: 

RUNNING 

↓ 

TIMEOUT 

The exact database representation can retain compatibility with the existing statuses, but the code should explicitly model the conceptual states above. 

# **4. Target frontend state machine** 

Internally: 

IDLE ↓ 

BOOTSTRAPPING 

↓ 

SOCKET_CONNECTING ↓ SOCKET_READY ↓ MIC_READY ↓ LISTENING ↔ SPEAKING ↔ MUTED ↓ TERMINATING 

↓ 

# CLOSED 

Error branches: BOOTSTRAPPING → FAILED 

SOCKET_CONNECTING → FAILED MIC_READY → FAILED RUNNING → RECONNECTING 

**Important UI rule** 

BOOTSTRAPPING, SOCKET_CONNECTING, etc. are **internal states** . The modal itself appears immediately. 

# **5. Frontend lifecycle architecture** 

# **Current problem** 

Today the architecture effectively has: 

adaptive panel lifecycle 

+ 

Live controller lifecycle 

+ 

browser audio lifecycle 

+ 

WebSocket lifecycle 

with insufficient coordination. **Required architecture** 

Create one owner: 

LiveRuntime / LiveController 

that owns: 

current session 

socket 

media stream 

# AudioContext 

input capture 

playback 

termination state 

transcript 

reconnect state 

The adaptive panel framework becomes a **presentation/dismissal mechanism** , not the owner of Live lifetime. 

# **6. Canonical termination API** 

The implementation should conceptually expose one function: 

terminateLiveSession({ 

reason, 

source, 

preserveTranscript }) 

Possible reasons: 

user_close 

outside_dismiss 

escape 

max_duration 

navigation auth_loss mic_failure socket_failure provider_goaway provider_terminal_error The first invocation sets: 

ending = true 

All later invocations simply await/return the same finalization promise. 

This eliminates the current: 

if (ending) return; 

style of protection from becoming an incomplete lifecycle mechanism. 

# **7. Local resource shutdown order** 

The close sequence should be deterministic: 

1. Mark session terminating 

2. Stop new input 

3. Stop mic capture 

4. Stop every MediaStream track 

5. Stop/clear playback 

6. Close AudioContext 

7. Close WebSocket 

8. Hide Live panel 

9. Start background persistence/finalization 

The user should see the panel disappear without waiting for steps 9+. 

# **8. Outside-click behavior** 

The repository's adaptive panel framework currently does not provide a clean, explicit Livespecific outside-click termination path. 

Therefore this must be made explicit. 

The Live root should behave like: 

pointerdown/click on root backdrop 

AND 

event target === Live root → canonical termination. 

Clicking inside: 

.live-beta-surface 

must not terminate. 

This needs its own regression test. 

Do **not** rely on accidental behavior from another global UI subsystem. 

# **9. Escape behavior** 

There are currently overlapping Escape handlers: 

live-surface 

live-controller 

adaptive-panel-framework 

This is exactly the sort of arrangement that can generate race/order bugs. Target: 

Escape while Live is active ↓ 

Live termination consumes event 

↓ 

adaptive panel does not perform an unrelated second dismissal Only the canonical Live lifecycle should execute. 

# **10. Remove obsolete controls** 

# **Remove from HTML** 

#live-beta-end #live-beta-transcript-toggle 

**Keep** 

#live-beta-mute 

The dynamically generated adaptive-panel X remains. 

The X becomes the primary explicit close mechanism. 

The transcript remains an internal object used for persistence. 

No transcript drawer is required. 

**11. Fresh Live conversation architecture** 

This should be a **backend invariant** . **New conceptual request** 

Instead of: { "conversationId": "..." } use: { "sourceConversationId": "..." } Response: { "sessionId": "...", "sourceConversationId": "...", "liveConversationId": "...", ... } 

The exact field names can be finalized later, but the separation is required. 

**12. How fresh-chat creation should work** 

The cleanest architecture is: POST /api/live/session-token ↓ reserve Live session 

↓ 

read source chat context 

↓ 

DO NOT use source chat as destination 

↓ create durable Live destination identity ↓ 

return Live session 

For maximum reliability, the destination conversation can either: 

**Option A — create during bootstrap** 

and mark it as: 

live_pending 

until transcript persistence completes, 

or: 

**Option B — create atomically during transcript commit** 

with: 

conversation + transcript message 

inside one database transaction. 

# **Preferred** 

**Option B** is cleaner for matching the product semantics: 

a new chat appears as a consequence of a successfully completed Live session. 

The Live session stores the source conversation ID and creates its destination conversation during durable commit. 

**13. Atomic Live transcript commit** 

A new DB RPC should be considered: 

commit_live_transcript(...) 

Conceptually: 

BEGIN 

lock live_session 

verify ownership 

if already committed: 

return existing destination conversation create destination conversation 

insert transcript message mark session transcript committed 

COMMIT This guarantees: one session → one destination chat even if the frontend retries. 

# **14. Idempotency requirement** 

The Live session ID must be the idempotency key. Example: session UUID = abc Repeated: commit abc commit abc 

commit abc 

must result in: 

one transcript 

one destination conversation 

The response from subsequent commits should return the original destination conversation. 

# **15. Title generation** 

Current code awaits title generation inside the session commit. 

That is not acceptable for the close UX. 

Required: 

transcript commit 

↓ 

return success 

↓ 

title generation asynchronously 

The title generator must never hold the browser's Live modal open. 

The existing repository already contains a general background-style helper: 

scheduleAutoTitleConversation(...) 

in serverLegacy.ts. 

Live should use the same architectural idea, adapted to the new durable Live destination. 

# **16. Transcript reliability** 

There is a major production concern beyond the user's immediate bug. 

At present, transcript exists primarily in browser memory until termination. 

That means: 

tab crash 

browser crash 

OS kill 

network loss can destroy an otherwise valid transcript. For actual production readiness, add a durable checkpoint mechanism. Possible model: live_session_transcript_segments with: session_id segment_id sequence role text created_at and a unique constraint on: (session_id, sequence) Then: speech turn completes ↓ checkpoint transcript segment At finalization: assemble segments → create one destination conversation → create transcript message This can be introduced as the **production durability phase** if the first release needs to remain smaller, but it should be treated as required for full production-grade crash recovery. 

**17. Gemini key pool — six-key correction** 

The current Live pool only loads: GEMINI_API_KEY_1 

GEMINI_API_KEY_5 

The implementation specification must change the contract to: GEMINI_API_KEY_1 GEMINI_API_KEY_2 GEMINI_API_KEY_3 GEMINI_API_KEY_4 GEMINI_API_KEY_5 GEMINI_API_KEY_6 And database constraints must support slot 6. This should have an explicit regression test: six configured keys → pool.size === 6 → slot 6 can be selected 

# **18. Key selection policy** 

Use least-loaded / least-recently-used behavior, but make the meanings explicit: available 

+ not cooling down + below per-key active capacity Selection should be deterministic. Provider failures must mark the affected key appropriately. 

# **19. Separate project capacity from per-key capacity** 

The current code uses: 

projectMaxActive 

while the database capacity check actually counts by: 

key_slot Those semantics are ambiguous. The target configuration should distinguish: globalMaxActive perKeyMaxActive Example: globalMaxActive = 100 perKeyMaxActive = 20 

meaning: 

maximum 100 Live sessions across deployment maximum 20 active sessions using any one Gemini key That better represents the six-key pool. 

Backward-compatible environment variable aliases may be retained temporarily. 

# **20. Key health** 

Current key cooldown/health exists only in Node memory. 

Target: 

local cache 

+ 

durable provider-health record 

A small control-DB table can track: 

slot 

failure_class 

cooldown_until consecutive_failures last_failure_at last_success_at 

The implementation does not necessarily need a database write for every transient network failure. 

It should write provider-attributable failures and rely on local heuristics for ephemeral network issues. 

# **21. Do not quarantine a Gemini key for browser/network failures** 

This distinction is mandatory. 

# **Browser-side/network failure** 

user Wi-Fi 

browser WebSocket problem device issue 

should **not** permanently poison a Gemini key. 

# **Provider-attributable** 

401 / 403 

429 

provider policy 

provider resource exhaustion provider invalid configuration may update key health. 

# **22. Gemini session resumption** 

The current token setup already enables: 

sessionResumption 

contextWindowCompression 

but the client does not currently have a complete resumption lifecycle. 

The implementation should support: 

SessionResumptionUpdate 

↓ 

store latest handle 

↓ 

GoAway 

↓ 

read timeLeft 

↓ 

reconnect using latest handle 

↓ 

resume existing session 

Google's current Live API guidance explicitly recommends retaining the latest resumption token, using it on reconnect, handling GoAway, and using generationComplete for response lifecycle. Google AI for Developers 

The exact wire fields must be verified against the current API reference at implementation time rather than copied from stale examples. 

# **23. Important Gemini endpoint/version verification** 

The current repository is using: 

v1alpha 

for its Live token and WebSocket endpoints. 

Current Google documentation describes ephemeral-token Live usage with the v1beta endpoint. Google AI for Developers 

Therefore the future implementation prompt **must require Gemini to verify the currently supported endpoint/model/version combination before changing anything** . 

This is specifically a “verify current provider contract” task, not something the agent should blindly preserve or blindly replace. 

# **24. Ephemeral token design should remain** 

The overall pattern is correct: 

SentIQ backend 

↓ 

Gemini ephemeral token 

↓ 

# browser 

↓ 

direct WebSocket → Gemini 

That avoids putting the long-lived Gemini keys in the browser and avoids proxying the highvolume audio stream through the backend. 

Google currently recommends ephemeral tokens for client-to-server Live implementations. <u>Google AI for Developers</u> 

# **25. Startup pipeline target** 

Current: 

status 

→ audio unlock → prepare conversation → token → microphone → playback → WebSocket → setup → sleep → capture → started RPC → Listening 

Target: 

CLICK 

│ `├` ── open UI immediately │ 

`├` ── auth/session context │ `├` ── microphone initialization │ `├` ── Live session provisioning │ `├` ── WebSocket connection │ └── provider setup │ └── first usable capture ↓ 

LISTENING 

Do not unnecessarily serialize operations that can safely happen in parallel. 

# **26. First-speech protection** 

An immediate UI creates a new issue to solve: 

What if the user speaks immediately while WebSocket setup is still completing? Target behavior: 

Mic ready 

↓ 

small bounded pre-ready PCM buffer 

↓ 

socket ready 

↓ 

flush buffer 

↓ 

normal streaming 

The buffer must have a strict cap to prevent unbounded memory usage. 

Something like: 

~250–500 ms 

is sufficient as an engineering starting point, to be benchmarked rather than treated as a magic constant. 

Google's current best-practice guidance recommends small audio chunks in the 20–100 ms range; the repository's existing 100 ms chunk size is already within that guidance. <u>Google AI</u> 

<u>for Developers</u> 

# **27. Audio pipeline** 

The existing: 

48 kHz microphone 

→ resample 

→ 16 kHz PCM 

→ 100 ms chunks 

→ Gemini 

does not need a wholesale rewrite merely because the current Live experience is slow. Focus performance work on: 

startup sequencing 

WebSocket lifecycle 

resource management 

provider setup 

buffering 

reconnect 

rather than unnecessarily replacing the PCM pipeline. 

# **28. /api/live/status redesign** 

Status should remain useful but no longer block opening Live. 

Recommended response shape: 

{ "enabled": true, "available": true, "reason": "available", "remainingSecondsToday": 114, "maxSessionSeconds": 114, "activeSession": null } Possible reasons: available sign_in_required not_available_on_plan daily_limit_reached active_session_limit global_capacity per_key_capacity provider_unavailable internal_error A database exception must become something like: internal_error not busy. 

**29. Status polling** 

/api/live/status may continue to be polled/refreshed for composer availability. But: Live button click must not wait on status refresh before opening the UI. Status becomes: 

advisory 

rather than: hard frontend gate 

except for obvious local conditions such as: user not authenticated 

feature disabled 

daily quota already exhausted 

# **30. Session creation responsibilities** 

createSession() should be simplified around one purpose: 

admit + provision a Live session 

It should not perform unnecessary work whose only purpose is UI hydration. 

Context preparation should be optimized so it returns only what Gemini actually needs: display name 

workspace capsule 

conversation capsule 

recent turns 

and not perform unrelated synchronization. 

# **31. Cleanup semantics** 

Every termination path must attempt: 

local resource cleanup 

↓ 

capacity release 

↓ 

durable finalization 

And stale cleanup remains the safety net. 

But stale cleanup must be a **last-resort recovery mechanism** , not the normal way successful user closes are released. 

That's the distinction the current failure demonstrates. 

# **32. Durable stale cleanup** 

Keep the existing periodic cleanup. 

Improve it to recognize: 

provisioning stale 

active stale finalizing stale and ensure: capacity lease 

+ 

user reservation 

+ 

session state 

are reconciled together. 

# **33. Browser pagehide behavior** 

pagehide should remain as a best-effort emergency path. 

But it must not be the only mechanism. 

Target: 

pagehide 

- `├` ── stop mic locally 

- `├` ── close socket 

- `├` ── keepalive finalization request 

- └── durable server cleanup remains the fallback 

A server-side stale session must eventually release the reservation even if the browser disappears completely. 

# **34. Background finalization architecture** 

There are two levels. 

**Level 1 — immediate asynchronous HTTP** 

Suitable for: normal X / Escape / outside close Browser: close UI → fire commit/end → don't wait **Level 2 — durable retry** Needed when: HTTP request fails replica restarts container crashes browser disappears 

Therefore the backend should retain a durable session record capable of recovery. 

# **35. Recommended database additions** 

I would add the following conceptually. 

**live_sessions** Existing: session_id owner_user_id plan status 

started_at ended_at expires_at reserved_seconds used_seconds key_slot metadata audio_started_at 

Add dedicated fields where they are operationally important: source_conversation_id destination_conversation_id transcript_status finalization_status finalization_requested_at transcript_committed_at 

Keep metadata for low-value diagnostic details; don't bury core relational lifecycle state in JSONB. 

**live_session_transcript_segments** 

Recommended for crash recovery: 

session_id sequence role text created_at Primary/unique: (session_id, sequence) No raw audio storage. 

**live_provider_key_health** 

Recommended: 

slot 

cooldown_until failure_count 

last_failure_at last_success_at last_failure_class 

This belongs on the control DB. 

# **36. Migration strategy** 

Do **not** edit old migrations in place. 

Create new versioned migrations. 

Likely migration sequence: 

1. live key slot expansion 

2. live session lifecycle fields 

3. live transcript durability 

4. live commit/finalization RPCs 

5. key health/capacity RPCs 

6. schema/version probes 

Every migration must be generated into the repository's existing data-track structure. 

# **37. Three-database deployment contract** 

The current repository confirms: 

DB1 = control 

DB2 = assignable data shard 

DB3 = assignable data shard 

and: 

ASSIGNABLE_DATABASE_IDS = [2, 3] 

The Live implementation should explicitly preserve that topology. DB4 must not appear as a Live runtime dependency. 

# **38. Migration rollout order** 

Because Live writes durable state: 

DB migration first 

↓ backend rollout ↓ frontend rollout not: frontend first unless the new frontend has backward-compatible feature detection. Preferred migration strategy: 

expand schema 

↓ deploy code capable of old+new ↓ verify ↓ switch behavior ↓ cleanup legacy fields later 

# **39. Tests to add before implementation changes** 

The current backend/testSentIQLive.ts is already substantial. 

It already covers things such as: 

quota active limits stale cleanup startup cancellation token failure durable session recovery start/end race Free remaining allowance Those tests should remain green. But the current suite needs major new contracts. 

**40. Mandatory backend tests** 

# **Test A — repeated start/end** 

create start end create start end create start end 10+ iterations. Assert: zero active sessions zero leaked capacity leases usage equals actual audio time 

# **Test B — end-before-start** 

create end Assert: cancelled 0 used seconds 0 active sessions reservation refunded 

**Test C — duplicate end** end(session) end(session) end(session) Assert: one finalization 

**Test D — duplicate commit** commit(session) commit(session) commit(session) Assert: one destination conversation one transcript message 

**Test E — same source chat** source = ChatA 

session1(source) session2(source) session3(source) Assert: destination1 != destination2 destination2 != destination3 

**Test F — six keys** Assert: pool.size === 6 

and that key 6 can actually participate. 

# **41. Mandatory frontend tests** 

The existing live-workspace.test.mjs needs a second set of behavioral tests. 

**Dismissal** 

X outside Escape all must trigger termination. 

**No transcript control** Assert: 

#live-beta-transcript-toggle does not exist 

**No End button** 

Assert: 

#live-beta-end does not exist 

**Single mute** 

Assert mute remains centered. 

# **42. Browser integration tests** 

These are more important than static source assertions. Using Playwright or equivalent: 

open Live → assert panel visible immediately → wait for listening → close via X → assert microphone stopped → assert panel hidden → assert transcript chat appears Repeat with: outside Escape 

# **43. Critical integration test** 

Exactly reproduce the user's failure: 

open 

close outside 

open 

close Escape 

open close X 

open 

Expected: the fourth open succeeds 

No: busy audio connection failed unless an actual provider/quota failure occurs. 

# **44. Rapid-cycle test** 

for 10 cycles: open wait listening close wait finalized Expected: 10 sessions 10 destination chats 10 transcripts no active session no leaked capacity no mic 

# **45. Immediate reopen test** 

This is particularly important: close session 1 immediately open session 2 The second attempt must not depend on stale cleanup. That proves the normal termination path is actually releasing resources. 

# **46. Provider-failure tests** 

Mock: 

key 1 → 429 key 2 → success 

Expected: 

key 1 cooled key 2 selected 

Then: 

WebSocket failure after successful token 

must update the correct provider-health path only when the failure is demonstrably provider attributable. 

# **47. Reconnect tests** 

Simulate: 

SessionResumptionUpdate GoAway 

WebSocket close Expected: 

new socket 

same logical Live session same transcript continuity same usage reservation 

No new user session. 

# **48. Crash/restart tests** 

Backend: 

create session mark started simulate process loss new process 

end/reconcile session 

Expected: 

durable session recovered 

correct usage capacity released 

The existing durable-session-recovery test gives us a foundation for this. 

**49. Error semantic tests** Verify that: database failure returns: internal_error and not: busy Also verify real capacity returns: global_capacity per_key_capacity active_session_limit with distinct codes. 

# **50. Observability specification** 

Every Live session should generate structured events. Minimum: live_click session_reservation_started session_reserved token_request_started token_request_succeeded 

token_request_failed websocket_open setup_complete audio_started first_input_audio first_output_audio resume_update goaway_received reconnect_started reconnect_succeeded termination_requested local_resources_released transcript_commit_started transcript_commit_succeeded finalization_started finalization_succeeded title_started title_succeeded 

**51. Timing metrics** Record: click_to_panel_ms click_to_token_ms token_to_ws_open_ms ws_open_to_setup_ms setup_to_mic_ready_ms setup_to_first_input_ms setup_to_first_output_ms 

close_to_local_cleanup_ms close_to_transcript_commit_ms close_to_finalization_ms The first one should be the critical UX metric: click_to_panel_ms Target: effectively immediate meaning the panel should not wait on network/database work. 

# **52. Key telemetry** 

Never log actual API keys. Log only: key_slot = 1..6 failure_class cooldown duration provider status code Never: raw key token ephemeral token audio full transcript 

# **53. Transcript privacy** 

The database design must continue to avoid: raw_audio audio_data microphone binary 

Only transcript text is persisted. 

The current Live migrations already explicitly avoid raw audio storage; preserve that property. 

# **54. Azure runtime validation** 

The existing Azure deployment architecture should be preserved: 

immutable SHA image → revision copy → health validation → public /ready → exact image verification → traffic switch 

Do not replace this with a simpler unverified az containerapp update. 

# **55. Azure secret contract** 

The production Container App must expose: GEMINI_API_KEY_1 GEMINI_API_KEY_2 GEMINI_API_KEY_3 GEMINI_API_KEY_4 GEMINI_API_KEY_5 GEMINI_API_KEY_6 plus existing Live configuration: SENTIQ_LIVE_ENABLED SENTIQ_LIVE_MODEL SENTIQ_LIVE_DEFAULT_VOICE SENTIQ_LIVE_SESSION_MAX_SECONDS SENTIQ_LIVE_AUDIO_ONLY 

No secret value should ever enter Git. 

The future deployment procedure must verify that all six variables are populated without printing them. 

# **56. Azure revision validation** 

The candidate revision should be tested for: 

/health 

/ready 

/api/live/status 

and then actual authenticated Live startup/teardown. 

A revision passing /ready alone is insufficient for this release. 

# **57. Production smoke test** 

After traffic switch: 

1. authenticated user 

2. open Live 

3. microphone permission 

4. speak one sentence 

5. close via X 

6. verify new chat 

7. verify transcript 

8. verify title 

9. verify no active Live session 

10. reopen immediately 

11. repeat 

Then: 

outside close 

Escape close 

# **58. Rollback criteria** 

Automatic rollback should occur if any of these are detected: Live startup failure rate spikes 

new session fails after successful previous revision 

transcript commit failures increase 

active sessions remain leaked 

capacity leases remain after normal termination 

microphone remains active after close 

new Live conversation not created 

production /ready fails 

# **59. Implementation order for Gemini/Antigravity** 

This is the sequence the eventual prompt should enforce. 

PHASE 1 

Repository verification 

↓ 

PHASE 2 

Add/strengthen regression tests 

↓ 

PHASE 3 

Database migrations + RPCs 

↓ 

PHASE 4 

Backend Live lifecycle rewrite 

↓ PHASE 5 

Six-key/provider reliability 

↓ PHASE 6 

Frontend lifecycle rewrite 

↓ PHASE 7 Fresh-chat persistence ↓ PHASE 8 

Reconnect/resumption ↓ PHASE 9 Observability 

↓ PHASE 10 

Full local test suite 

↓ PHASE 11 

Migration validation DB1/DB2/DB3 

↓ PHASE 12 

Azure candidate deployment 

↓ PHASE 13 

Production Live smoke tests 

↓ PHASE 14 Traffic promotion 

# **60. Rules for the future Gemini prompt** 

The eventual prompt should explicitly prohibit Gemini from doing the following: 

Do not start changing code before inspecting the relevant files. 

Do not assume the third-open bug is Gemini quota. 

Do not increase rate limits as a workaround. 

Do not remove durable usage controls. 

Do not store API keys in frontend code. 

Do not store raw audio. 

Do not make transcript persistence depend solely on browser pagehide. 

Do not introduce a second independent Live lifecycle. 

Do not create a second conversation-management mechanism unrelated to the existing DB architecture. 

Do not alter unrelated chat/model/billing functionality. 

Do not edit existing historical migrations in place. 

Do not deploy before migration validation. 

Do not switch Azure traffic before candidate health checks. 

Do not claim a fix without reproducing the previously failing lifecycle sequence. 

# **61. Definition of Done** 

SentIQ Live is considered production-ready only when all of these are true: 

# **UX** 

Live UI opens immediately 

No visible Connecting gate 

No End button 

No Transcript button 

Mute remains central X closes 

outside closes 

Escape closes 

# **Browser resources** 

mic always stops 

AudioContext always closes capture always stops socket always closes 

# **Session lifecycle** 

normal close releases active session immediately repeated opens succeed 

double close is idempotent 

stale cleanup is only fallback 

# **Persistence** 

every completed Live session gets its own new chat 

same source chat can launch unlimited additional sessions each session has one transcript 

each transcript has one destination 

title generation does not block close 

# **Quota** 

time-based 

remaining seconds preserved 

failed startup refunded 

actual audio time charged 

# **Provider** 

6 keys available 

key failover works 

key health works 

real capacity distinguished from internal errors 

session resumption works GoAway handled 

# **Azure** 

DB1 migrated DB2 migrated DB3 migrated candidate revision healthy exact image verified Live smoke tests pass traffic switched 

# **62. The critical architectural takeaway** 

The redesign should revolve around one principle: 



<!-- Start of picture text -->
              ┌───────────────────────┐<br>              │      Live Session     │<br>              │   = single source of  │<br>              │       lifecycle       │<br>              └─────────── ┬ ───────────┘<br>                          │<br>          ┌─────────────── ┼ ────────────────┐<br>          │               │                │<br>▼ ▼ ▼<br>       Browser         Database         Gemini<br>       resources       truth/usage       connection<br>          │               │                │<br>          └─────────────── ┼ ────────────────┘<br>                          │<br>                    One termination<br><!-- End of picture text -->

state machine 

Right now those responsibilities are spread across several partially independent mechanisms. **That is the fundamental architectural weakness behind the behavior you observed.** 

The next prompt should therefore be an **execution prompt built directly from this specification** , rather than a generic “improve Live Voice” request. 

Google's current Live API documentation also reinforces the need for short audio chunks, session resumption, GoAway handling, and ephemeral authentication in browser-based Live implementations. Google AI for Developers 

**No Gemini/Antigravity prompting has been started yet.** 

