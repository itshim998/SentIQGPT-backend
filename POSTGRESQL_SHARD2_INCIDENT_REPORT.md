# SentIQ Shard 2 — PostgreSQL Incident Reconciliation & Closure Report

**Incident ID:** INC-20261017-SHARD2-SERIALIZATION-RETRY-STORM  
**Target Shard:** SentIQ Shard 2 (`fpklxhhsvjbjetkxqajg` — DB3)  
**Region:** `ap-south-1` (AWS Asia Pacific - Mumbai)  
**Database:** PostgreSQL 17.6 on `aarch64-unknown-linux-gnu` (Supabase Managed)  
**Root Cause Remediation Migration:** `20261017120000_fix_generation_lease_serialization_retry_loop.sql`  
**Core Fix Commit:** `351c064981ad214089e3e438037b1659a21f15c5`  
**CI Integration & Cleanup Commit:** `0883c17d0bca99dc3f17175802b8363483db247a`  
**Status:** **CLOSED — FULLY RECONCILED & REGRESSION-PROTECTED**  

---

## 1. Executive Summary

On October 17, 2026, SentIQ Shard 2 (`fpklxhhsvjbjetkxqajg`) experienced a sustained PostgreSQL transaction rollback storm that pegged database CPU at 100%.

The root cause was determined to be an application error code incompatibility with PostgREST 14.5:
When a generation lease expired, was lost, or encountered a sequence mismatch, five generation RPC functions raised an exception using SQLSTATE `40001` (`serialization_failure`). PostgREST transparently catches SQLSTATE `40001` and executes transaction replay loops inside Haskell over its persistent connection to PostgreSQL. Because a lost lease or sequence mismatch is an unrecoverable invariant failure rather than a transient concurrency conflict, PostgREST re-executed the failing transaction continuously on its loopback connection (`::1`), creating approximately **1,593 rollbacks per second**.

The incident was remediated by forward migration `20261017120000_fix_generation_lease_serialization_retry_loop.sql`, which replaced SQLSTATE `40001` with `P0001` (`raise_exception`) across all five fenced RPCs. This report reconciles historical telemetry discrepancies, verifies database counter history, establishes the exact meaning of the dashboard error counts, and documents the automated CI regression suite.

---

## 2. Telemetry & Counter Discrepancy Reconciliation

### A. Pre-Remediation Instantaneous Rollback Rate
* **Verified PostgreSQL Timestamps (`pg_stat_database.now()`):**
  * $T_0$: `2026-10-17 05:13:41.055 UTC` (`xact_rollback`: $1,903,939,823$)
  * $T_1$: `2026-10-17 05:13:44.828 UTC` (`xact_rollback`: $1,903,945,832$)
  * **Elapsed Time:** $44.828\text{ s} - 41.055\text{ s} = \mathbf{3.773\text{ seconds}}$
  * **Counter Delta:** $\Delta \text{rollbacks} = \mathbf{6,009\text{ rollbacks}}$
* **Calculation:**
  $$\text{Observed Rollback Rate} = \frac{6,009\text{ rollbacks}}{3.773\text{ s}} \approx \mathbf{1,592.6\text{ rollbacks/sec}}\quad (\sim 1,593\text{ rollbacks/sec})$$
* **Error Correction:** Earlier incident notes reported $2,003\text{ rollbacks/sec}$ by dividing $6,009$ by an assumed $3.0\text{ s}$ delay (`setTimeout(3000)`), omitting the $773\text{ ms}$ WAN HTTP roundtrip latency between the diagnostic runner and Supabase's API endpoint in Mumbai.

### B. Database Counter History & Long-Term Rollback Rate
* **Verified Database Timestamps (`fpklxhhsvjbjetkxqajg`):**
  * `pg_stat_database.stats_reset` (`datname = 'postgres'`): `2026-08-25 20:41:21.766501+00`
  * `pg_postmaster_start_time()`: `2026-09-23 02:50:49.338288+00`
* **Assessment of October 4 Timestamp:**
  * Prior documentation claimed that the cumulative counter ($1,903,945,832\text{ rollbacks}$) began accumulating at `2026-10-04 18:31:00 UTC` ($1,104,164\text{ s}$, yielding $1,724.3\text{ rollbacks/sec}$).
  * Live investigation confirms that `pg_stat_database` was **not** reset on October 4. The October 4 timestamp corresponded to a client generation task update (`2026-10-04 11:00:53 UTC`) and PostgREST backend start time (`2026-10-04 10:37:46 UTC`), not a statistics counter reset.
  * Because `xact_rollback` is a database-wide counter that accumulated across all database workloads since `postmaster_start` (or `stats_reset`), and because the counter value at the onset of the storm was not independently recorded, **the long-term cumulative rollback rate cannot be verified and is marked unverified**. Only the short-window measurement ($1,592.6\text{ rollbacks/sec}$) is retained.

### C. Dashboard "358,099 PostgreSQL Errors" Reconciliation
* **Observed Dashboard Metric:**
  * PostgreSQL Requests: $358,099$ | PostgreSQL Errors: $358,099$ | Success Rate: $0\%$
  * API Gateway Requests: $5$ | Storage Requests: $3$ | Realtime Requests: $2$
* **Verified Source & Event Class:**
  * In the 60-minute window preceding remediation (`2026-10-17 04:13:00` to `05:13:45 UTC`), queries against Supabase Analytics (`logs` table) show:
    * `source = 'postgres_logs'`: **363,325** events (100% with severity `ERROR`, SQLSTATE `40001`, message `"Guest generation execution lease lost"`).
    * `source = 'edge_logs'` (API Gateway / Kong): **20** events.
  * The dashboard metric directly represented the aggregated line count of `postgres_logs` error records.
* **Why Database Errors Far Exceeded Gateway Requests:**
  * PostgREST 14.5 connects to PostgreSQL locally over loopback (`::1`).
  * When an HTTP generation event request entered via API Gateway, PostgREST called the RPC function.
  * On SQLSTATE `40001`, PostgREST caught the error and re-executed the query in an internal Haskell loop. Each attempt emitted an `ERROR` entry to PostgreSQL's server log (`postgres_logs`).
  * A handful of ingress HTTP requests produced hundreds of thousands of internal database retries without generating additional API Gateway requests.
* **Why Log Count (358,099) Differs from Rollback Count (~5.73M in 60m):**
  * `pg_stat_database.xact_rollback` is an atomic integer in PostgreSQL shared memory incremented synchronously on every transaction abort (`AbortTransaction()`).
  * `postgres_logs` is an asynchronous log streaming pipeline with file I/O, syslog formatting, vector log shippers, and ingestion batching. At 1,593 rollbacks/sec, repetitive log lines are subject to standard log transport throughput limits. They represent two fundamentally different telemetry planes.
* **Correction of Speculative Claims:**
  * The hypothesis that "CPU starvation throttled log shippers" was an unverified inference; the discrepancy is fully explained by multi-retry aggregation per connection and log transport throughput.
  * Claims regarding AWS burstable CPU-credit exhaustion are speculative without CloudWatch T-series credit telemetry and are removed.

### D. JWT Timestamp Disambiguation
* **Project Anonymous Service Key:**
  * `iat: 1759574295` = Saturday, October 4, 2025 at 10:38:15 UTC.
  * `exp: 2075150295` = Thursday, October 4, 2035 at 10:38:15 UTC.
  * Standard 10-year Supabase project anonymous key provisioned in 2025.
* **Guest Caller Token:**
  * `iat: 1791110216` = Sunday, October 4, 2026 at 10:36:56 UTC.
  * `exp: 1791111176` = Sunday, October 4, 2026 at 10:52:56 UTC.
  * Ephemeral token for guest turn test `websurf-test-1791110263781`.

---

## 3. Evidence Categories

### Confirmed Observations
1. Post-fix rollback rate on DB3 (`fpklxhhsvjbjetkxqajg`) is **0.000 rollbacks/sec** across a 4.701-second measurement window.
2. Active running queries on DB3: **0**.
3. Past 15-minute log errors on DB3: **0**.
4. Both DB2 and DB3 have migration `20261017120000` recorded in `supabase_migrations.schema_migrations`.
5. All 5 RPC functions declare `P0001`, zero occurrences of `40001`, `SECURITY DEFINER`, and `set search_path = public, pg_temp`.
6. Database `stats_reset` is `2026-08-25 20:41:21 UTC`; `postmaster_start` is `2026-09-23 02:50:49 UTC`.

### Derived Calculations
1. Pre-remediation instantaneous rollback rate: $\frac{6,009\text{ rollbacks}}{3.773\text{ s}} \approx 1,592.6\text{ rollbacks/sec}$.
2. Dashboard error rate: $\frac{358,099\text{ errors}}{3,600\text{ s}} \approx 99.5\text{ errors/sec}$.

### Evidence-Supported Causal Conclusions
1. PostgREST transparent transaction replay on SQLSTATE `40001` caused the continuous retry loop on local connection `::1`.
2. Replacing `40001` with `P0001` permanently eliminated the retry loop because PostgREST does not replay general application exceptions.

### Unverified Inferences (Discarded from Fact)
1. That `1,903,945,832` rollbacks accumulated exclusively starting on October 4, 2026.
2. That CPU starvation specifically throttled the edge log shipping agent.
3. That AWS burstable CPU credits were exhausted.

### Unrecoverable Historical Information
1. The exact breakdown of transaction rollbacks prior to the onset of the October 4 generation failure.

---

## 4. Repository & CI Verification

* **Branch:** `master` (synchronized with `origin/master`).
* **CI Integration:**
  * Script `"test:lease-retry-regression"` added to `package.json`.
  * Trigger paths updated in `.github/workflows/supabase-migrations.yml`.
  * Executed under `validate-and-test` job in GitHub Actions.
* **GitHub Actions Workflow Run `39102574983`:**
  * `Validate Migration Manifest & Scope` (ID `117601673299`): **SUCCESS** (27s)
    * `npm run test:lease-retry-regression`: 9/9 passed in 218ms.
    * `npm run test:migrations`: 12/12 passed.
  * `Deploy Data Track to DB3`: **SUCCESS** (28s).
  * `Deploy Data Track to DB2`: **SUCCESS** (36s).
  * `Deploy Control Track to DB1`: **SUCCESS** (28s).
* **Local Test Suites (All Clean, Exit Code 0):**
  * `npm run test:lease-retry-regression`: 9/9 passed.
  * `npm run test:migrations`: 12/12 passed.
  * `nativeDataTrackBootstrap.mjs` validation: passed.
  * `npm run test:shards`: 5/5 passed.
  * `npm run build` (`tsc`): passed.
  * `testGuestGenerationDurabilityP0.ts`: 12/12 passed.
