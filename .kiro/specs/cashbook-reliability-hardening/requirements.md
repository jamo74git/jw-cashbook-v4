# Requirements Document — Cashbook Reliability Hardening

> **Spec type:** New feature (hardening / modification of the EXISTING OAC Cashbook app — NOT a rebuild).
> **Phase:** Requirements (review-gated). This document contains the Current-State Inventory, the
> Findings Matrix, and the formal EARS requirements. No design or tasks are produced in this phase,
> and no code is changed.
>
> **How to read this document:** Non-functional *targets* that the brief flagged as proposals are
> explicitly labelled **(PROPOSAL — needs review)**. Items that cannot be confirmed without live
> Supabase access are labelled **UNVERIFIED — NEEDS LIVE INSPECTION** and carry the exact read-only
> command to confirm them. Prefer the CURRENT code model (`cashbook_period` / `periodLocalId`) over
> the obsolete `cashbook_service` / `captureQueue` model wherever historical docs conflict.

---

## Introduction

The OAC Cashbook is a national, multi-congregation, offline-first PWA for capturing weekly service
tithing/offering records, attaching photographic proof of banking, and routing each record through a
governance chain (capture → audit → overseer → head office). This feature hardens the **reliability,
security, and evidence integrity** of that pipeline so it can be trusted at national scale.

**Scope of this feature:**

1. **Reliable progressive submission** — completed transactions transfer through a controlled,
   recoverable sync pipeline that never loses captured data or evidence, never duplicates logical
   work after retries/lost acknowledgements, and does not hold all work until a capture activity ends.
2. **Secure review** — auditor approval/rejection and authorised reopen are server-validated
   transitions with revision checks and atomic mandatory audit records; access is enforced server-side
   (RLS + RPCs), not only by UI gates.
3. **Evidence preservation** — proof bytes are preserved locally until a verified upload + verified
   object + confirmed attachment for the exact captured revision; proofs stay private with scoped
   access; deletion/replacement preserves auditable history. Historical months and proofs remain
   retrievable.
4. **Measured capacity** — proof sizes, latency, retention growth and cost are *measured* against a
   planning model (capturer/auditor mix; ~6,000 simultaneously active users; ~30,000 proofs/month)
   rather than asserted, with staged load tests gated by explicit authorisation.

**Retained architecture (non-negotiable):** Vite + React + TypeScript PWA (vite-plugin-pwa /
Workbox), Dexie.js (IndexedDB) offline Local_Store, and Supabase (Auth + Postgres + RLS + Storage).
See `.kiro/steering/tech_old.md` and `.kiro/steering/steering_old.md`.

**Out of scope (summarised; see §6):** no Azure storage/SSO, no ZIP exports, no sponsored-data
integrations, no new backend platform; Phase B–D (census / new members / attendance) stays a dormant
feature set — but any **exposed data access** from those dormant stubs is fixed/disabled (Finding 27).

---

## Agreed Principles (this phase)

- **Principle P1 — Reconfirm, don't silently change.** Reported defects and business descriptions are
  inspection INPUTS; each is reconfirmed against current source and any discrepancy is REPORTED (as a
  Finding / open decision), never silently changed. Financial gates, role responsibilities, and month
  sequencing are not altered without an explicit agreed decision (e.g. Findings 16/28, R21, OBD-b/c/d).
- **Principle P2 — Existing security controls stay demo-critical.** Existing server-side role/hierarchy
  enforcement, private proof access, actor attribution, and server-side locking are DEMO-CRITICAL and
  must be preserved/hardened, not deferred (cross-ref CON-SEC2, R14, R18, R28, R29, R30).

---

## Current-State Inventory (as found in the repository)

This inventory records the **actual** lifecycle wiring observed in source, with paths. Historical
design docs describe intentions; the following is what the code does today.

### 2.1 App shell, routing, and the environmental split
- Entry: `index.html` → `src/main.tsx` → `src/App.tsx`. `src/main.tsx` renders `<App/>` inside
  `React.StrictMode` with no connectivity/sync bootstrap.
- `src/App.tsx` defines routing via `react-router-dom`. `Protected({area})` calls
  `resolveAccess()` once on mount (`src/lib/routeGuard.ts`) and gates on `canEnterCapture` /
  `canEnterAdmin` from the permission matrix. `/capture/*` is code-split (`CaptureLayout`),
  `/admin/*` is code-split (`AdminLayout`). The `<ReloadPrompt/>` PWA update prompt is rendered.
- `src/capture/CapturePage.tsx` resolves role + congregation. **Congregation resolution falls back to
  `existing[0]?.congregationId`** (the first local period) when `access.congregation_id` is absent,
  and when routed as `/capture/:periodLocalId` it opens that local period directly with no displayed
  ownership/scope check (Finding 18).

### 2.2 Offline Local_Store (Dexie)
- `src/db/schema.ts` — database `oac_cashbook_local`, Dexie versions **1→4**.
  - v1 (legacy `captureQueue`/`cashbook_service` shape) is **dropped** at v2; the v2 `.upgrade()`
    **clears `lineItems`** on the assumption that *"No production offline data exists."* (Finding on
    destructive upgrade — see §3 constraint CON-STORAGE.)
  - v2 realigns to the real model: `periods` (mirrors `cashbook_period`), `lineItems`
    (mirrors `cashbook_line_item`), proof held as `Blob` on items/period, `congregationSettings`.
  - v3/v4 are additive (Phase B–D stub stores; `offlineUsers`; `monthAggregates`); new `LocalPeriod`
    fields + `SyncMeta.value` are non-indexed object fields.
  - `PeriodStatus` local vocabulary = `Draft | Rejected | Submitted | AuditApproved` and is explicitly
    noted to **differ** from the `ServiceStatus` enum in `src/lib/types.ts`.
- `src/db/captureRepo.ts` — local data layer: `getOrCreateLocalPeriod` (keyed by
  `naturalKey = congregationId|weekKey|service`), `addLineItem`, `updateLineItem`, `setIncomeType`,
  `deleteLineItem`, `attachProof`, `markCashBanked` (bulk cash → one deposit slip),
  `submitPeriod`, `confirmR0NoTithing`, `setClosed`, month machine (`recomputeMonthStatus`,
  `bulkSubmitMonthToOverseer`), `listOutstandingWeeks`. `touchPeriod` updates only `updatedAt`.
  `queueOverrideAudit` is an **intentional no-op placeholder**.

### 2.3 Sync engine
- `src/utils/syncEngine.ts` — `syncPending()` selects `db.periods` where
  `localStatus ∈ {pending, failed}`, ordered by `createdAt`, marks each `syncing`, and calls
  `reconcilePeriod`: resolves the server period via `supabase.rpc("get_or_create_period", …)`,
  conflict-checks via a 4-value `STATUS_RANK`, upserts each line item, uploads proof Blobs to the
  `cashbook-proofs` bucket (`getPublicUrl`), inserts `cashbook_attachment` rows, applies the Submitted
  transition, and flushes an `ACTING_AS_TREASURER` audit row. Failures → `recordFailure` (increments
  `syncAttempts`, sets `localStatus:"failed"`, writes `updatedAt`). Backoff via `backoffDelayMs` /
  `isDueForRetry` (no jitter).
- **`syncPending` is invoked from exactly one place:** `src/components/CashbookForm.tsx` `submit()`
  as `void syncPending().catch(() => {})` (fire-and-forget). **There is no `online`-event, startup,
  focus, `visibilitychange`, interval, or service-worker trigger that calls `syncPending`.** (Verified
  by workspace-wide grep: only `CashbookForm.tsx` and the definition in `syncEngine.ts` reference it.)
- `src/utils/statusFlow.ts` — a *separate* directional validator over the 7-value `ServiceStatus`
  vocabulary, explicitly **not imported by the Sync_Engine**. The engine keeps its own 4-value rank.

### 2.4 Auth and session lifecycle
- `src/services/authService.ts` — offline PIN lifecycle: `activateOffline` (online, Turnstile-gated),
  `unlockOffline` (HMAC-integrity-first, then PIN; lockout at 5), `enforceTTL`/`isTtlExpired`
  (12h TTL), `revalidateOnReconnect`, `signOut`, plus offline-profile helpers.
- **`revalidateOnReconnect` is defined but never called** anywhere in `src/` (verified by grep —
  only the definition appears). There is no reconnect handler that re-validates the offline session.
- `src/lib/routeGuard.ts` `resolveAccess()` — online delegates to `getUserAccess()`; offline derives a
  provisional access record from the in-memory `getSession()` + cached `offlineUsers` profile
  (fail-closed when no session).
- `src/lib/useOnlineStatus.ts` — the *only* `online`/`offline` listeners in the app; they drive React
  state for UI gating only. They do **not** trigger sync or revalidation.
- `getUserAccess()` (`src/lib/permissions.ts`) selects `user_hierarchy_access` with
  `.eq("status","active").limit(1).maybeSingle()` and an explicit `// no order` comment —
  non-deterministic "primary" among multiple active rows (pre-existing known issue, confirmed).

### 2.5 Reference cache + server→local hydration
- `src/utils/cacheLoader.ts` — `refreshReferenceCache()` clears+rebuilds `officers`, `congregations`,
  `hierarchyLevels`, `congregationSettings`. `autoRefreshReferenceCache()` is fire-and-forget.
- **The only caller is `src/features/auth/LoginPage.tsx` `handleAuthenticated()`** (online login).
  There is no periodic/reconnect refresh, and **no server→local hydration of `periods`/`lineItems`**:
  the Dexie `periods`/`lineItems` stores are populated only by local capture, never seeded from
  Supabase. Offline capture therefore requires at least one prior online login for congregation
  context, and a different device/browser cannot see server-side history offline.

### 2.6 Capture + proof UI
- `src/components/CashbookForm.tsx` — tabbed capture (Members/Officers/Burial/Expenses/Banking),
  totals, R500 Elder-comment gate (`const R500 = 500` hardcoded), "Submit for Audit" button gated by
  `canSubmit && balanced && income>0 && proofs && over500 comment`. `hasProofLocally` treats
  `proof_status === "Pending"` as having proof **even with no blob** (Finding 16). `needsProof`
  excludes `Cash`/`CashBanked` (cash-proof exemption via the deposit slip). Override logging via
  `logSelfReviewException` is wrapped in `try/catch {}` that **swallows errors** (Finding 17).
- `src/capture/ProofModal.tsx` — compresses the chosen image via `compressImage` and returns a Blob.
- `src/lib/imageCompress.ts` — canvas resize to `maxWidth=1920`, **JPEG `quality=0.8`**; returns the
  original unchanged if not an image or `< 500_000` bytes. Output size is **unmeasured** (no WebP).

### 2.7 Audit UI (online-only)
- `src/audit/AuditDashboard.tsx` — loads once on mount; pending queue = `cashbook_period` where
  `status="Submitted"` for the user's single `congregation_id`; history = last 10 Approved/Rejected.
  No bounded refresh, no reconnect refresh, **no WIP view**, offline shows an unavailable message.
- `src/audit/AuditReviewPage.tsx` — loads the period + line items + **all RLS-visible
  `cashbook_attachment` rows** then filters in memory by line-item id (Finding 20). Failed child reads
  default to empty arrays (`?? []`) (Finding 21). Four verification checkboxes gate Approve. The
  approve/reject write is a conditional `UPDATE … .eq("status","Submitted")` (optimistic row-lock),
  followed by a **separate** `logAuditAction` call (not atomic — Finding 22). Realtime subscription
  only flags `externallyChanged` when status moves away from `Submitted` (Finding 23). `getAtt` picks
  the **first** attachment per line item (Finding 24).
- `src/audit/ProofLink.tsx` — renders a link to `attachment.file_url` opened in a new tab (relies on
  a usable URL; today the engine stores a `getPublicUrl` result).

### 2.8 Supabase backend evidence (files in repo; deployment UNVERIFIED)
- Edge Functions exist in `supabase/functions/` (`admin-write`, `verify-turnstile`, `deno.json`,
  `README.md`). Steering states they are **written but NOT deployed / NOT runtime-tested**.
- Two conflicting schema sources exist in the repo:
  - `src/lib/supabase/schema.sql` defines the **obsolete** `cashbook_service` (with `service_id`,
    the 9-value status vocabulary, and a `banking` table). This does **not** match the running code.
  - `supabase/rpc_get_or_create_period.sql`, `supabase/migration_proof_bucket.sql`,
    `supabase/migration_tabs.sql`, `supabase/migration_elder_features.sql` operate on
    **`cashbook_period` / `cashbook_line_item` (period_id) / `cashbook_attachment`** — the model the
    code uses. These `ALTER … ADD COLUMN IF NOT EXISTS` scripts assume a base `cashbook_period`
    schema that is **not fully defined in any repo file** (dashboard-created). → base schema
    **UNVERIFIED**.
- `get_or_create_period(UUID, TEXT, TEXT, UUID)` is `SECURITY DEFINER` with **no role/scope/lock
  check** inside it (grants `EXECUTE … TO authenticated`).
- RLS as scripted in `supabase/rpc_get_or_create_period.sql`: `cashbook_period`,
  `cashbook_line_item`, `cashbook_attachment` get `FOR ALL TO authenticated USING (true) WITH CHECK
  (true)` ("Auth all …"). `supabase/migration_proof_bucket.sql` later replaces the attachment policy
  with congregation-scoped SELECT/INSERT **plus a broad `scope_level != 'Congregation'` see-all
  clause**, and defines **no scoped UPDATE/DELETE** policy and **no parent-lock / actor-role** check.
- `audit_log` (`docs/migrations/006_audit_log_table.sql`): `SELECT`/`INSERT` `TO authenticated USING
  (true)` — unrestricted authenticated reads/inserts, no actor binding.
- `congregation_settings` (`supabase/migration_settings_rls.sql`): `SELECT USING (true)` (broad read),
  writes restricted to Elder/Chair/HO.
- Proof bucket: migration comments name **`cashbook_proofs`** (underscore) and say the bucket was
  "already created by you in Supabase Dashboard"; the engine code uses **`cashbook-proofs`** (hyphen)
  and `getPublicUrl` (Finding 14). Actual bucket id + privacy flag + object policies **UNVERIFIED**.
- Phase B–D (`docs/migrations/009_phase_bcd_foundation.sql`): stub tables + `member-docs` **private**
  bucket, but table RLS and object policies are `authenticated USING (true)` / broad (Finding 27).

### 2.9 Service worker / PWA
- `vite-plugin-pwa` with `registerType: 'prompt'` (per steering); `src/pwa/ReloadPrompt.tsx` surfaces
  updates. No Background Sync / Periodic Background Sync is wired to the sync engine. (SW config file
  not re-read in this phase; precache/runtime behaviour to be confirmed in design.)

### 2.10 Tests
- One offline-auth test file exists (`src/features/auth/offlinePinMultiuser.test.ts`). No automated
  tests cover the sync engine, capture repo mutations, audit transitions, or storage/RLS behaviour.

---

## Findings Matrix

**Status legend:** `VERIFIED-IN-SOURCE` (cite path+symbol) · `VERIFIED-DEPLOYED` ·
`UNVERIFIED-NEEDS-LIVE-INSPECTION` (with command) · `RESOLVED-BY-OTHER-CODE` (cite) ·
`SUPERSEDED-DESIGN` (cite obsolete doc). Each finding links to the requirement(s) it drives.

| # | Finding (brief) | Status | Evidence / Inspection command | Drives |
|---|---|---|---|---|
| 1 | `touchPeriod` + several edit/proof/banking ops may not reset parent sync state; engine selects `pending|failed` parents → lost dirty changes | **VERIFIED-IN-SOURCE** | `captureRepo.ts` `touchPeriod` sets only `updatedAt`; `updateLineItem`/`attachProof`/`deleteLineItem` call `touchPeriod` (no `localStatus:"pending"`); `markCashBanked` sets `updatedAt` only. `setPeriodStatus`/`submitPeriod`/`setClosed` DO set `localStatus:"pending"`. Engine filter in `syncEngine.ts syncPending` = `pending|failed`. A synced period edited post-sync stays `"synced"` and is not re-selected. | R2, R3 |
| 2 | `deleteLineItem` removes local data with no tombstone; previously-uploaded deletions need an idempotent op + evidence history | **VERIFIED-IN-SOURCE** | `captureRepo.ts deleteLineItem` → `db.lineItems.delete`; no server-side delete/tombstone; engine never deletes `cashbook_line_item`/`cashbook_attachment`. | R4, R12 |
| 3 | Repo mutations don't enforce editable status internally (UI gates insufficient) | **VERIFIED-IN-SOURCE** | `isPeriodEditable` exists but `addLineItem`/`updateLineItem`/`deleteLineItem`/`attachProof`/`markCashBanked` never call it; only `CashbookForm` checks `canEdit`. | R3 |
| 4 | Engine interleaves line write + proof upload + attachment insert + status update per line before next | **VERIFIED-IN-SOURCE** | `syncEngine.ts syncLineItem` upserts item, uploads proof, inserts attachment, updates proof_status sequentially inside the per-item loop in `reconcilePeriod`. | R5, R6 |
| 5 | Attachment inserts, proof-status updates, audit inserts IGNORE returned errors; local blobs cleared + period marked synced despite incomplete server work (PRIORITY) | **VERIFIED-IN-SOURCE** | `syncEngine.ts`: `cashbook_attachment` insert, `cashbook_line_item` proof_status update, `audit_log` insert, and conflict/acting-as inserts have no error check; `db.lineItems.update(..., {proofBlob:null})` and `localStatus:"synced"` run regardless. | R7, R8, R9 |
| 6 | Proof paths use second-precision timestamps, no per-proof identity; same-second collisions; retries orphan files | **VERIFIED-IN-SOURCE** | `syncEngine.ts uploadProof` path = `…/${capturedByUserId}/${ts}-${suffix}.${ext}` with `ts` sliced to 14 chars (second precision); no unique id; no overwrite guard. | R10, R11 |
| 7 | Line upserts without server id lack a visible idempotency key → lost response duplicates; attachments/audit need retry-safe ids | **VERIFIED-IN-SOURCE** | `syncEngine.ts syncLineItem` upsert omits `id` when `!item.serverId`; a lost response after insert re-inserts on retry. Attachment/audit inserts carry no client op id. | R11 |
| 8 | Records left `syncing` after termination aren't reselected next run; need worker leases + startup recovery | **VERIFIED-IN-SOURCE** | `syncEngine.ts syncPending` sets `localStatus:"syncing"` then only `pending|failed` are selected; a crash between leaves the row stuck at `syncing` forever. | R8, R13 |
| 9 | Backoff without jitter / no demonstrated scheduler; retry timing stored in mutable `updatedAt` | **VERIFIED-IN-SOURCE** | `backoffDelayMs` = `BASE·2^attempts` (no jitter); `isDueForRetry` reads `period.updatedAt`, which capture mutations also write → an edit resets the retry clock. No scheduler calls `syncPending` on a timer. | R9, R2 |
| 10 | No single-worker / version acknowledgement vs overlapping runs/edits during upload | **VERIFIED-IN-SOURCE** | No lease/lock/version field consulted in `syncEngine.ts`; `syncPending` is re-entrant and `CashbookForm.submit` can call it while another run is active. An old snapshot can clear a blob written by a newer edit. | R8, R10 |
| 11 | `STATUS_RANK` covers only Draft/Rejected/Submitted/AuditApproved; not content conflict detection nor a complete transition validator | **VERIFIED-IN-SOURCE** | `syncEngine.ts STATUS_RANK` has 4 keys; `isServerDownstream` is rank-only. `statusFlow.ts isValidTransition` exists but is "not imported by the Sync_Engine". | R11, R19 |
| 12 | `setClosed` records local `AuditApproved`, but the engine only applies `Submitted`; it does not transmit an offline auditor decision with actor/version | **VERIFIED-IN-SOURCE** | `captureRepo.ts setClosed` sets `status:"AuditApproved"`; `reconcilePeriod` only acts when `period.status === "Submitted"`; `AuditApproved` periods are marked synced with no server approve/audit write. No UI caller of `setClosed` found (grep). | R16, R17, R26, R28, R38 |
| 13 | `isAuditApprovable` accepts synced OR matching device id; neither establishes evidence completeness, auditor permission, or reviewed version | **VERIFIED-IN-SOURCE** | `syncEngine.ts isAuditApprovable` = `localStatus==="synced" || captureDeviceId===currentDeviceId`. No UI caller found (grep) — the same-device gate is modelled but unwired. | R16, R17, R28, R38 |
| 14 | Engine uses `getPublicUrl` while bucket privacy unknown; migration says `cashbook_proofs` vs code `cashbook-proofs` | **VERIFIED-IN-SOURCE** (mismatch) + **UNVERIFIED-NEEDS-LIVE-INSPECTION** (actual bucket/privacy/policies) | `syncEngine.ts PROOF_BUCKET = "cashbook-proofs"` + `getPublicUrl`; `supabase/migration_proof_bucket.sql` header says bucket `cashbook_proofs`. Confirm: `select id, name, public from storage.buckets;` and `select policyname, cmd, qual, with_check from pg_policies where tablename='objects' and schemaname='storage';` | R10, R14, R15, R29 |
| 15 | `CashbookForm` already exposes Submit + locks Submitted/approved; fire-and-forget sync can't distinguish local completion from server readiness — extend, don't duplicate | **VERIFIED-IN-SOURCE** | `CashbookForm.tsx submit()` calls `capture.submitPeriod` then `void syncPending().catch()`; `editable = isPeriodEditable` disables the form once `Submitted`. No "server review-ready" signal exists. | R15, R16 |
| 16 | `hasProofLocally` accepts `Pending` without a blob/verified attachment; verify R500 hardcoded vs configurable and whether the monthly expense check aggregates the month | **VERIFIED-IN-SOURCE** | `CashbookForm.tsx hasProofLocally` returns true for `proof_status==="Pending"`. `const R500 = 500` is hardcoded though `congregation_settings.expense_approval_threshold` exists (`supabase/migration_elder_features.sql`). `monthlyExpensesExceedThreshold` is imported from `@/lib/captureTotals` — aggregation scope NOT yet confirmed (needs reading `captureTotals.ts` in design). | R20, R21 |
| 17 | Offline override logging swallows errors + no-op repo hook; submit doesn't pass `actingAsRole` | **VERIFIED-IN-SOURCE** | `CashbookForm.tsx` `logSelfReviewException` wrapped in `try/catch {}`; `captureRepo.queueOverrideAudit` is a documented no-op; `submit()` calls `submitPeriod` without `actingAsRole`. | R18 |
| 18 | `CapturePage` falls back to first local period's congregation; opens a targeted local id with no ownership/scope check | **VERIFIED-IN-SOURCE** | `CapturePage.tsx`: `const congregationId = access?.congregation_id ?? existing[0]?.congregationId`; `/capture/:periodLocalId` opens `capture.getPeriod(periodLocalId)` directly. | R22 |
| 19 | `AuditDashboard` loads only Submitted, fetches once on mount; add bounded refresh/reconnect + a labelled WIP view (not making Draft approvable) | **VERIFIED-IN-SOURCE** | `AuditDashboard.tsx` single `useEffect([])`; pending query `.eq("status","Submitted")`; no refresh/subscription; no WIP/provisional view. | R23, R16 |
| 20 | `AuditReviewPage` fetches all RLS-visible attachments and filters in memory | **VERIFIED-IN-SOURCE** | `AuditReviewPage.tsx load()`: `supabase.from("cashbook_attachment").select(...)` with **no** `.eq("period…")`/line filter, then `.filter(a => ids.has(a.line_item_id))` client-side; no pagination. | R24 |
| 21 | `AuditReviewPage` treats failed child reads as empty arrays; four checkboxes alone can approve an incompletely loaded record | **VERIFIED-IN-SOURCE** | `AuditReviewPage.tsx`: `(li.data ?? [])`, `(att.data ?? [])`, `(off.data ?? [])`; no error inspection; approve enabled on `allChecked` regardless of load failure. | R25 |
| 22 | Conditional Submitted update is concurrency protection, not proof-unchanged; approval + audit logging are separate calls — make them atomic server-side with revision/actor | **VERIFIED-IN-SOURCE** (client) + **UNVERIFIED-NEEDS-LIVE-INSPECTION** (server) | `AuditReviewPage.tsx decide()`: `UPDATE … .eq("status","Submitted")` then a separate `logAuditAction`. No server RPC/transaction. Confirm no server-side trigger/RPC enforces it: `select proname from pg_proc where proname ilike '%audit%' or proname ilike '%approve%';` and `select tgname, tgrelid::regclass from pg_trigger where not tgisinternal;` | R26, R16, R29 |
| 23 | Realtime only signals status-away-from-Submitted; doesn't refresh changed items/attachments; reset verification boxes on version/route/reload | **VERIFIED-IN-SOURCE** | `AuditReviewPage.tsx` channel sets `externallyChanged` only when `newStatus !== "Submitted"`; checkbox state is not reset on item/attachment change or reload. | R25, R26 |
| 24 | `getAtt` selects the first attachment (ambiguous after duplicates/replacements) — resolve current version + expose history | **VERIFIED-IN-SOURCE** | `AuditReviewPage.tsx getAtt = (id) => attachments.find(a => a.line_item_id === id)` (first match). No `created_at`/version ordering. | R10, R12, R24 |
| 25 | Local month completion evaluates only locally-existing periods; validate expected weeks/services + required R0 confirmations server-side; preserve OAC calendar; inspect UTC vs SA dates | **VERIFIED-IN-SOURCE** (local-only) + **UNVERIFIED-NEEDS-LIVE-INSPECTION** (server rule) | `captureRepo.ts recomputeMonthStatus`/`bulkSubmitMonthToOverseer` read only `db.periods` for the month; no server validation. OAC week logic in `@/lib/oacWeeks` (to confirm in design). Date handling: `addLineItem` uses `new Date().toISOString().slice(0,10)` (UTC) — SA is UTC+2. Confirm server expected-period rule: `select proname from pg_proc where proname ilike '%period%' or proname ilike '%month%';` | R27 |
| 26 | Attachment policies have a broad non-Congregation clause + no actor-role/parent-lock; audit-log policies allow unrestricted authenticated read/insert; settings policies broad reads + role-only writes | **VERIFIED-IN-SOURCE** (scripts) + **UNVERIFIED-NEEDS-LIVE-INSPECTION** (effective policies) | `migration_proof_bucket.sql` (scope_level != 'Congregation' see-all; no UPDATE/DELETE/lock/role), `docs/migrations/006_audit_log_table.sql` (`USING (true)` read+insert), `migration_settings_rls.sql` (`SELECT USING (true)`), and `rpc_get_or_create_period.sql` ("Auth all periods/line items" `USING(true) WITH CHECK(true)`). Confirm effective: `select schemaname, tablename, policyname, cmd, roles, qual, with_check from pg_policies where tablename in ('cashbook_period','cashbook_line_item','cashbook_attachment','audit_log','congregation_settings');` and `select relname, relrowsecurity, relforcerowsecurity from pg_class where relname in (...);` | R26, R28, R29, R30 |
| 27 | Phase B–D stub + member-docs policies allow broad authenticated access — keep features out of scope BUT fix/disable exposed access | **VERIFIED-IN-SOURCE** (scripts) + **UNVERIFIED-NEEDS-LIVE-INSPECTION** (deployed) | `docs/migrations/009_phase_bcd_foundation.sql`: census/attendance/new_members tables `authenticated USING (true)` read/insert/update; `member-docs` object policies `bucket_id='member-docs'` with no owner/scope. Confirm deployed: `select tablename, policyname, cmd, qual from pg_policies where tablename in ('census_congregation','census_priestship','attendance_monthly','new_members_register');` + storage.objects policies. | R31 |
| 28 | R500 governance is an ACKNOWLEDGEMENT gate at PER-PERIOD Submit-for-Audit, not an approval and not at month submit-to-Overseer; field mislabelled "approval"; threshold hardcoded; aggregation per-period | **VERIFIED-IN-SOURCE** | `CashbookForm.tsx submit()`: `if (over500 && !elderComment.trim()) …` then `capture.submitPeriod`; amber banner "Expenses exceed R500 — Elder approval comment required before submission"; field `elderApprovalComment` / placeholder "Elder approval comment *". `ChairpersonDashboard.handleSubmitAll` sets `SubmittedToOverseer` + logs MONTH_SUBMIT/SELF_REVIEW_EXCEPTION with NO comment. `captureTotals.monthlyExpensesExceedThreshold` = `expensesTotal(items) > threshold` (current period only); `const R500 = 500` hardcoded; `congregation_settings.expense_approval_threshold` unused. | R21 (OBD-c, OBD-d) |
| 29 | Overseer surface uses `OverseerApproved` / `OverseerRejected` states absent from `ServiceStatus` and `statusFlow.ts` (status-vocabulary discrepancy) | **VERIFIED-IN-SOURCE** | `OverseerReview.tsx decide()` writes `status: "OverseerApproved"`/`"OverseerRejected"` and buckets filter on them; `src/lib/types.ts SERVICE_STATUSES` has no such values; `statusFlow.ts SUCCESSORS` maps `SubmittedToOverseer -> ["SubmittedToHO","Rejected"]` only. | R19, R33 |

### 3.1 Conflicts flagged (historical specs vs current code vs this brief)

- **C-1 (schema model):** `src/lib/supabase/schema.sql` (`cashbook_service` / `service_id` / 9-value
  status / `banking` table) is **SUPERSEDED-DESIGN** by the deployed `cashbook_period` /
  `cashbook_line_item(period_id)` / `cashbook_attachment` model that the code and
  `supabase/rpc_get_or_create_period.sql` use. Steering (`tech_old.md` Known Issues #1) already records
  `cashbook_period` vs `cashbook_service` ambiguity. **Prefer the current `cashbook_period` model.** The
  obsolete file should not be used as the source of truth; do not revert to `cashbook_service`.
- **C-2 (status vocabulary):** `src/db/schema.ts PeriodStatus` (4 values) vs `src/lib/types.ts`
  `ServiceStatus` (7 values) vs `src/utils/statusFlow.ts` (7-value validator unused by sync). The
  local period lifecycle is genuinely 4-value; the fuller chain lives server-side. Requirements must
  specify **which** vocabulary a transition is validated against to avoid silently adopting either.
- **C-3 (offline model terminology):** Historical specs (`hybrid-offline-architecture`,
  `restore-to-vite`) describe `captureQueue` / `cashbook_service`. These are **SUPERSEDED-DESIGN**;
  v2 Dexie dropped `captureQueue`. All new requirements use `periods` / `periodLocalId`.
- **C-4 (reconnect sync claim):** `tech_old.md` describes a Sync_Engine that reconciles "on reconnect".
  **Not wired** (§2.3): sync only fires on submit. This brief's requirement to run on
  reconnect/startup/focus is treated as NEW work, not a regression fix of existing wiring.
- **C-5 (bucket name):** code `cashbook-proofs` vs migration `cashbook_proofs`. The deployed name
  (and privacy) is authoritative and UNVERIFIED; requirements mandate reconciling code to the real
  bucket and migrating existing object references safely (R14).
- **C-6 (destructive Dexie upgrade):** `schema.ts` v2 `.upgrade()` clears `lineItems` on a "no
  production offline data" assumption. The brief forbids reusing that assumption; future upgrades must
  be additive and preserve pending records (CON-STORAGE, R32).

---

## Glossary

- **System**: The OAC Cashbook application as a whole (PWA client + Supabase backend), unless a more
  specific component is named.
- **Capture_App**: The offline-first `/capture` client surface (`CapturePage`, `CashbookForm`,
  `ProofModal`) writing to the Local_Store.
- **Local_Store**: The Dexie/IndexedDB database `oac_cashbook_local` (`src/db/schema.ts`).
- **Sync_Engine**: The reconciliation module `src/utils/syncEngine.ts` and its successor.
- **Business_Period** (or **Period**): A `(congregation, week_key, service AM/PM)` unit of capture;
  mirrored locally as `LocalPeriod` and server-side as `cashbook_period`. Distinct from a login session.
- **Transaction** (or **Line_Item**): A single captured record (`LocalLineItem` / `cashbook_line_item`).
- **Proof**: A photographic evidence image/Blob and its server object + `cashbook_attachment` row.
- **Deposit_Slip**: A single shared proof object referenced by multiple banked cash items.
- **Business_State**: The governance status of a period — `Draft`, `Submitted`, `AuditApproved`,
  `Rejected` (local 4-value vocabulary; the fuller 7-value overseer/HO chain is server-side).
- **Transfer_State**: The reliability/sync status of a period or operation, independent of
  Business_State — e.g. metadata-pending, proof-uploading, verified, auth-required.
- **Complete_Capture**: The business completion boundary action (evolution of "Submit for Audit"),
  described in R15/R16.
- **Outbox_Op** (or **Operation**): A durable, retry-safe unit of work queued in the Local_Store to be
  applied to the backend, carrying a stable Operation_ID.
- **Operation_ID**: A client-generated identifier stable across retries and lost responses, used for
  server-side idempotency.
- **Entity_Revision**: A monotonically increasing version marker on a captured entity used to detect
  stale writes and bind decisions to the exact reviewed version.
- **Worker_Lease**: A recoverable ownership marker ensuring a single active Sync_Engine worker and
  enabling recovery of interrupted operations.
- **Actor**: The authenticated user whose authority an operation is performed under. **Device_ID** is a
  correlation identifier, never an authority.
- **Offline_Review**: Same-device provisional audit by a second saved authorised user (R17).
- **Review_Ready**: A server-confirmed condition that is true ONLY when the submitted frozen snapshot
  AND every required evidence dependency in the Required_Manifest are verified against the latest
  acknowledged revision; formal approval requires Review_Ready.
- **Required_Manifest** (the **immutable manifest**): The frozen, immutable set of required dependencies
  a submitted period must have present/verified before it is Review_Ready, honouring legitimate proof
  exemptions. It enumerates the transaction identities and their revisions, the expected proof
  identities and versions, shared Deposit_Slip coverage, legitimate exemptions, the submission identity
  (Submission_Operation / Operation_ID), and the Capture_Generation.
- **Submission_Operation**: The single durable Outbox_Op created atomically by Complete_Capture that
  carries the frozen business snapshot and its Required_Manifest to the submission mechanism; one
  logical submission regardless of retries.
- **Capture_Generation**: A monotonic marker identifying a reopened/corrected capture cycle for a
  period, so evidence and decisions from an earlier generation are preserved and never conflated with a
  later one.
- **R0_Confirmation**: A "no tithing this week" confirmation for a period with no line items.
- **p50/p95/p99/max**: Latency percentiles and maximum, reported for measured operations.

---

## Requirements

> Every requirement has a stable ID (`R#`) and numbered EARS acceptance criteria (`R#.n`) so design,
> tasks, and tests can trace to it. Non-functional targets flagged by the brief as proposals are
> marked **(PROPOSAL — needs review)**. "THE System" refers to the component named in the Glossary.
>
> **Note:** As of this revision, several items are user-DECIDED: the **submission protocol** —
> Complete_Capture atomically freezes the business snapshot + the immutable Required_Manifest, creates
> one Submission_Operation, and locks local editing; the submission mechanism validates that exact
> snapshot + manifest, establishes server `Submitted`, and records its mandatory audit atomically;
> declared-missing proofs may finish uploading after `Submitted`; `Review_Ready` (and therefore formal
> approval) requires the submitted snapshot AND all required evidence verified (R15/R16); the
> **separation of approval, rejection, and reopen prerequisites** (R16/R26/R19); **operation-specific
> server authority** for capturer/auditor endpoints with the HO gate retained for HO-only admin
> (R29/CON-SEC2); Complete_Capture → `Submitted` mapping (R15/R16); shared-device actor isolation via
> explicit handover with re-validation before dispatch (R13/R17/R18/R28); the metadata p95 ≤ 2s
> engineering target (NFR-L2); and deferral of hot/cool storage tiering (NFR-R2).
>
> **Demo-scoping amendment (this revision):** This revision re-scopes several items for the near-term
> demo and PRESERVES all prior R1..R32 IDs. Same-device offline provisional review (R17 and its
> provisional-review-specific dependents) is DEFERRED post-demo; the demo uses an explicit ONLINE-ONLY
> review path (R38) that keeps offline capture and the saved-user picker. Overseer/HO in-month
> visibility, submission receipts, sync-staleness awareness, authorised provisional read-only
> visibility, and the reliability invariants are ADDED as R33–R38. R21 is corrected to describe the
> ACTUAL R500 ACKNOWLEDGEMENT behaviour. See the "Superseded & Deferred (post-demo)" subsection
> immediately below.

## Superseded & Deferred (post-demo)

The following were raised in earlier drafts or in the amendment brief and are explicitly NOT in this
phase. They are recorded here so the decision is on the record; none is deleted, and where they map to
existing criteria those IDs/text are PRESERVED and labelled in place. **Do NOT implement these in this
phase.**

- **SD-1 — Congregation-month LOCK TABLES.** A dedicated per-congregation-month lock table is NOT
  introduced. Month locking is expressed through Business_State (`SubmittedToHO` is the final month
  lock; HO-only unlock — R33.5, R19.3). **SUPERSEDED (deferred post-demo — do NOT implement).**
- **SD-2 — Authenticated Elder APPROVAL binding.** An operation-ID-bound authenticated Elder approval /
  authenticated acknowledgement workflow is NOT built. The capture-time comment stays RECORDED TEXT
  (R21.4). Whether it should become an authenticated approval remains OBD-c. **SUPERSEDED (deferred
  post-demo — do NOT implement); OBD-c stays OPEN.**
- **SD-3 — Expense-specific PARTIAL UNIQUE INDEXES / a new expense table.** No new expense table and no
  expense-specific partial unique index are mandated. Anti-duplication is expressed as a testable
  invariant without prescribing storage shape (R37.2). **SUPERSEDED (deferred post-demo — do NOT
  implement).**
- **SD-4 — New MONTH-COMPLETION DECLARATION.** No new month-completion declaration artefact is
  introduced; existing month-completion controls are preserved (R27). **SUPERSEDED (deferred post-demo
  — do NOT implement).**
- **SD-5 — New MONTHLY expense-aggregation binding.** No new monthly expense-aggregation rule is bound;
  the CURRENT per-period behaviour of `monthlyExpensesExceedThreshold` is preserved and the
  per-month-vs-per-period question remains OBD-b (R21.2). **SUPERSEDED (deferred post-demo — do NOT
  implement); OBD-b stays OPEN.**
- **SD-6 — Same-device offline PROVISIONAL review (R17 and dependents).** Same-device offline audit is
  NOT wired in source — `captureRepo.setClosed` and `syncEngine.isAuditApprovable` have no UI caller
  (Findings 12/13). R17, and the provisional-review-specific criteria R28.7 and R28.8, are a
  SEPARATELY-SCOPED feature **DEFERRED post-demo**. The demo uses the ONLINE-ONLY review path (R38).
  Actor-specific authenticated replay + explicit handover for CAPTURE sync (R28 core) remain
  demo-critical and are NOT deferred.

### Requirement 1 (R1) — Durable local-first persistence of capture and evidence

**User Story:** As a Treasurer capturing a service, I want every entry and photo saved locally the
moment I record it, so that nothing is lost if I close the app, lose signal, or the device restarts.

#### Acceptance Criteria
1. WHEN a capturer records a transaction, THE Capture_App SHALL persist the transaction to the
   Local_Store before confirming the entry to the capturer.
2. WHEN a capturer attaches a proof image, THE Capture_App SHALL persist the proof bytes to the
   Local_Store before confirming the attachment to the capturer.
3. WHILE the device is online, THE Capture_App SHALL persist capture writes to the Local_Store first
   (local-first), independent of backend availability.
4. WHEN the Capture_App is reopened after a close or restart, THE Capture_App SHALL reload previously
   captured transactions and their proof bytes from the Local_Store without data loss.
5. IF a Local_Store write fails (quota, I/O, or transaction error), THEN THE Capture_App SHALL report
   the failure to the capturer and SHALL NOT indicate the entry was saved.

### Requirement 2 (R2) — Dirty-state tracking so edited work is re-synced

**User Story:** As a capturer who corrects an entry after it first synced, I want my correction to be
transferred, so that the server reflects my latest work.

#### Acceptance Criteria
1. WHEN a capturer edits, adds, deletes, re-types, attaches a proof to, or banks any transaction in a
   period, THE Capture_App SHALL mark that period (and the affected operation) as having unsynced
   changes.
2. WHEN the Sync_Engine selects work to transfer, THE Sync_Engine SHALL include every period and
   operation that has unsynced changes, including periods previously transferred.
3. THE System SHALL record retry-scheduling timestamps separately from business modification
   timestamps so that a capture edit does not alter retry timing and a retry does not alter the
   business modification time.
4. WHEN a period is edited after a prior transfer, THE System SHALL transfer only the changed
   operations rather than resending unchanged transactions. **(PROPOSAL — needs review: delta scope.)**

### Requirement 3 (R3) — Server- and repository-enforced editability

**User Story:** As the organisation, I want edits blocked once a period is completed or approved
regardless of which screen or stale tab is used, so that approved records cannot be altered casually.

#### Acceptance Criteria
1. IF a mutation (add/edit/delete/retype/attach/bank) targets a period that is not in an editable
   Business_State, THEN THE Capture_App data layer SHALL reject the mutation independent of UI gating.
2. WHILE a period is `Submitted` or `AuditApproved`, THE Capture_App SHALL present it as display-only.
3. IF a stale tab, reopened proof modal, or a different saved user attempts to mutate a non-editable
   period, THEN THE System SHALL reject the mutation and report the current state.
4. THE System SHALL enforce editability server-side so that a direct API write to a non-editable
   period is rejected (traceable to R26).

### Requirement 4 (R4) — Idempotent deletion with preserved evidence history

**User Story:** As an auditor, I want deletions of already-transferred transactions to be explicit and
leave a history, so that evidence is never silently discarded.

#### Acceptance Criteria
1. WHEN a capturer deletes a transaction that has not yet transferred, THE Capture_App SHALL remove it
   locally and record a local deletion marker for reconciliation.
2. WHEN a capturer deletes a transaction that was previously transferred, THE System SHALL perform an
   explicit, idempotent deletion operation server-side rather than an unlogged removal.
3. THE System SHALL preserve an auditable history of a deleted transaction and any associated proof
   references under the documented correction workflow (traceable to R12).
4. IF a deletion operation is retried after a lost response, THEN THE System SHALL converge to a single
   logical deletion without error.

### Requirement 5 (R5) — Separate metadata progress from binary (proof) progress

**User Story:** As an auditor, I want transaction details to appear quickly even while large images are
still uploading, so that I can begin review without waiting for every photo.

#### Acceptance Criteria
1. THE Sync_Engine SHALL transfer transaction metadata independently of proof binary uploads.
2. WHILE proof uploads for a period are still in progress, THE System SHALL make already-transferred
   transaction metadata visible to authorised reviewers, clearly labelled as not yet Review_Ready.
3. THE System SHALL represent metadata-transfer progress and proof-upload progress as distinct
   Transfer_States for a period.

### Requirement 6 (R6) — Stable unique proof/version identity and collision-safe object keys

**User Story:** As the organisation, I want every proof to have a stable unique identity, so that
same-second photos never collide and retries never orphan files.

#### Acceptance Criteria
1. WHEN a proof is created locally, THE System SHALL assign it a stable unique proof identity and
   revision before transfer.
2. THE System SHALL derive each proof object key from its stable identity so that two proofs captured
   in the same second do not collide.
3. IF a proof upload is retried, THEN THE System SHALL target the same object key for the same proof
   revision and SHALL NOT create an orphaned duplicate object.
4. WHEN an object already exists at a proof's target key, THE System SHALL verify it is the same proof
   revision before treating the upload as successful.
5. WHEN a proof is replaced, THE System SHALL assign either a NEW proof identity or an object key that
   carries an explicit version, so that a prior accepted object's bytes are never overwritten
   (traceable to R12, R14).

### Requirement 7 (R7) — Error-checked server writes before local acknowledgement

**User Story:** As the organisation, I want local evidence kept until the server confirms every write,
so that a period is never marked done while server work is incomplete. (PRIORITY — Finding 5.)

#### Acceptance Criteria
1. WHEN the Sync_Engine inserts a `cashbook_attachment`, updates a proof status, or writes an audit
   record, THE Sync_Engine SHALL inspect the returned result and SHALL treat a returned error as a
   failed operation.
2. IF any required server write for an operation fails, THEN THE Sync_Engine SHALL retain the local
   proof bytes and SHALL NOT mark the operation or period as fully transferred.
3. THE Sync_Engine SHALL mark a period fully transferred only after every required transaction write,
   proof object upload, attachment link, and status/audit write for that period has been confirmed.
4. IF a mandatory audit write for a transition fails, THEN THE System SHALL treat the transition as not
   applied.

### Requirement 8 (R8) — Recoverable worker leases and startup recovery of interrupted work

**User Story:** As the organisation, I want sync to recover after a crash or close, so that work left
mid-transfer is retried rather than stranded.

#### Acceptance Criteria
1. WHEN the Sync_Engine begins processing an operation, THE Sync_Engine SHALL record a recoverable
   Worker_Lease rather than an unrecoverable in-progress flag.
2. WHEN the application starts, THE Sync_Engine SHALL recover operations whose lease is expired or
   whose owning worker is gone and SHALL make them eligible for processing again.
3. IF the application terminates mid-operation, THEN THE System SHALL NOT leave the operation
   permanently unselectable on subsequent runs.
4. THE Sync_Engine SHALL acquire, renew, and expire the Worker_Lease atomically with explicit ownership
   checks, so that only the current lease owner may acknowledge or clear an operation and a resumed
   worker after lease expiry cannot act as if it still owned the lease (traceable to R10).

### Requirement 9 (R9) — Capped backoff with jitter and a real scheduler

**User Story:** As the organisation, I want retries spread out and actually driven, so that failures
recover without stampeding the backend.

#### Acceptance Criteria
1. WHEN an operation fails transiently, THE Sync_Engine SHALL schedule a retry using capped exponential
   backoff with randomised jitter.
2. WHEN a backend response includes a `Retry-After` indication, THE Sync_Engine SHALL honour it.
3. WHILE operations are due for retry, THE System SHALL drive retries from a scheduler (not only on an
   explicit submit action).
4. WHILE proof uploads are retrying, THE Sync_Engine SHALL keep metadata transfer responsive rather
   than blocking it behind binary retries.

### Requirement 10 (R10) — Single-writer/version acknowledgement so newer work is never clobbered

**User Story:** As a capturer, I want a later edit to win over an in-flight older upload, so that a
stale sync run never erases my newer photo or marks newer work done.

#### Acceptance Criteria
1. THE System SHALL coordinate sync so that at most one worker owns an operation at a time
   (traceable to R8).
2. IF a sync run completes against an entity revision older than the current local revision, THEN THE
   System SHALL NOT clear the newer local proof bytes and SHALL NOT mark the newer work transferred.
3. WHEN a proof blob is replaced locally during an in-flight upload, THE System SHALL preserve the
   newer blob and reconcile the upload to the newer revision.
4. THE System SHALL acknowledge transfer completion against a specific entity revision.
5. THE System SHALL fence transfer acknowledgements so that a worker resumed after lease expiry, or an
   overlapping older request racing a newer one, CANNOT clear newer local work or mark newer work
   transferred; server-effect idempotency (R11) SHALL protect server state against duplicate
   application (traceable to R8).

### Requirement 11 (R11) — Idempotent operations and retry-safe server application

**User Story:** As the organisation, I want retries and lost acknowledgements to never create duplicate
transactions, attachments, submissions, or approvals.

#### Acceptance Criteria
1. WHEN the Capture_App creates an operation, THE System SHALL assign it a stable Operation_ID that
   persists across retries and lost responses.
2. THE System SHALL apply metadata and proof-finalisation operations via server mechanisms that are
   idempotent for a given Operation_ID (traceable to R26).
3. IF an operation is retried after its server effect already succeeded, THEN THE System SHALL converge
   to a single logical result without creating a duplicate.
4. WHEN detecting a conflict, THE System SHALL distinguish a status-rank advance from a content/revision
   conflict and SHALL NOT overwrite advanced server state.

### Requirement 12 (R12) — Evidence preservation, replacement, and correction history

**User Story:** As an auditor and the organisation, I want proof replacements and corrections to keep a
full history, so that we can see what was reviewed and when.

#### Acceptance Criteria
1. THE System SHALL preserve local proof bytes until a verified upload, a verified object, and a
   confirmed attachment/finalisation exist for that exact transaction revision.
2. WHEN a proof is replaced, THE System SHALL retain the prior proof reference and record the
   replacement under the documented correction workflow.
3. THE System SHALL expose, for a transaction, which proof version is current and the history of prior
   versions (traceable to R24).
4. THE System SHALL store object keys and metadata rather than permanent signed URLs.
5. THE System SHALL NOT automatically delete pending or incomplete-transfer records (no 48-hour purge);
   incomplete transfers SHALL be recoverable exceptions.
6. WHEN an uploaded proof object is verified, THE System SHALL use actual provider-supported server-side
   content, size, and integrity validation and SHALL NOT treat a successful HEAD/existence check as
   establishing readability or integrity; THE System SHALL record which actor/mechanism recorded the
   verified status and the verified revision.
7. WHEN selecting the current accepted proof version, THE System SHALL resolve it EXPLICITLY by its
   recorded version/identity (not by timestamp sort or first-match), preserving shared Deposit_Slip
   links and prior-version history (traceable to R24).
8. THE System SHALL prevent object mutation between proof verification and approval, so the approved
   bytes are exactly the bytes that were verified (traceable to R14, R29).

### Requirement 13 (R13) — Resume on startup, reconnect, and foreground; auth-aware pausing

**User Story:** As a field user, I want transfers to resume when I come back online or reopen the app,
so that I don't have to remember to trigger sync.

#### Acceptance Criteria
1. WHEN the application starts with pending operations, THE Sync_Engine SHALL attempt transfer subject
   to backoff and auth state.
2. WHEN connectivity is regained, THE System SHALL resume eligible transfers.
3. WHEN the application returns to the foreground, THE System SHALL resume eligible transfers.
4. IF an operation fails due to an authentication error, THEN THE Sync_Engine SHALL pause that actor's
   affected operations rather than retrying them in a tight loop (traceable to R18).
5. IF an operation fails due to a permanent validation error, THEN THE Sync_Engine SHALL stop retrying
   it and surface it for correction rather than retrying indefinitely.
6. THE System SHALL treat reported online status as a hint and SHALL confirm backend reachability
   before declaring an operation transferred.
7. THE System SHALL provide foreground resume, progress, and retry controls, and SHALL NOT claim that
   uploads continue while a mobile PWA is suspended or closed.
8. WHEN connectivity is regained, THE Sync_Engine SHALL re-validate the originating Actor's
   authorisation — identity, active access, role, hierarchy scope, and access window — BEFORE
   dispatching that Actor's queued operations, and SHALL NOT dispatch on a stale cached authorisation
   (traceable to R28).
9. WHEN hydrating server state into the Local_Store, THE System SHALL preserve pending local revisions,
   map local and server identities explicitly, and reconcile server approval, rejection, deletion, and
   correction WITHOUT last-write-wins (traceable to R24).

### Requirement 14 (R14) — Correct, private proof bucket and safe reference migration

**User Story:** As the organisation, I want proofs in the correct private bucket with references that
keep working, so that evidence stays accessible to authorised reviewers and private to everyone else.

#### Acceptance Criteria
1. THE Sync_Engine SHALL upload proofs to the actual configured proof bucket (reconciling the
   `cashbook-proofs` vs `cashbook_proofs` naming to the deployed value — UNVERIFIED, see R30).
2. THE System SHALL reference proofs by object key and retrieve them via scoped authenticated or
   short-lived signed access rather than a permanent public URL.
3. WHEN proof references exist in the legacy form (public URL / mismatched bucket), THE System SHALL
   migrate them without making existing evidence inaccessible.
4. IF the proof bucket is public, THEN THE System SHALL make it private as part of this feature
   (UNVERIFIED — confirm current privacy per R30 before changing).
5. WHILE a period is `Submitted` or approved, THE System SHALL permit ONLY the narrowly authorised
   creation/finalisation of proofs that were DECLARED outstanding in the Required_Manifest, and SHALL
   PROHIBIT object overwrite, proof replacement, undeclared attachments, and business edits.
6. THE System SHALL ensure that submitted or approved evidence CANNOT be altered through direct Storage
   APIs or through any previously issued upload permission, including after an interrupted upload, a
   rejection during transfer, or within a reopened Capture_Generation (traceable to R29).
7. THE System SHALL ensure that either every proof replacement receives a NEW proof identity or the
   object key carries an explicit version, so that approved object bytes are IMMUTABLE and never
   overwritten (traceable to R6, R12).

### Requirement 15 (R15) — "Complete Capture and Submit for Audit" as the completion boundary

**User Story:** As a capturer, I want a single clear action that finishes my capture and locks it, so
that completion is unambiguous while routine transfer still happens progressively beforehand.

#### Acceptance Criteria
1. THE Capture_App SHALL evolve "Submit for Audit" into "Complete Capture and Submit for Audit" while
   preserving its existing balance, proof-completeness, and R500 governance checks; at this boundary
   proof-completeness SHALL mean each required proof is present locally or legitimately exempt, and
   SHALL NOT require that every proof object has finished uploading.
2. WHEN a capturer invokes Complete_Capture, THE System SHALL atomically freeze the period's business
   snapshot and its immutable Required_Manifest, create exactly one durable Submission_Operation for the
   period (one logical submission regardless of retries), and lock local editing.
3. WHEN Complete_Capture succeeds locally, THE Capture_App SHALL immediately lock the period to
   display-only.
4. THE System SHALL treat Complete_Capture as the business completion boundary and SHALL NOT require it
   as the only trigger for transferring completed transactions (progressive transfer per R5).
5. THE System SHALL map Complete_Capture to the existing `Submitted` Business_State, locking local
   capture immediately on submit while keeping `Submitted` explicitly separate from Transfer_State and
   from server Review_Ready. **(DECIDED: mapping accepted; no distinct "CaptureComplete" marker is
   introduced; formal approval still requires completed revision + verified required evidence.)**
6. WHEN the Submission_Operation reaches the backend, THE System SHALL validate the EXACT frozen
   snapshot and its Required_Manifest, establish the server `Submitted` state, and record the mandatory
   submission audit record ATOMICALLY (all-or-nothing); IF snapshot/manifest validation or the audit
   write fails, THEN THE System SHALL NOT establish `Submitted`.
7. WHERE a required proof was DECLARED in the Required_Manifest but its object has not finished uploading
   at submission time, THE System SHALL allow that declared proof to finish uploading/finalising AFTER
   `Submitted`, and THE System SHALL NOT require every proof upload to complete before establishing
   `Submitted`.
8. THE Required_Manifest SHALL be immutable for the frozen snapshot and SHALL enumerate: the transaction
   identities and their revisions, the expected proof identities and versions, shared Deposit_Slip
   coverage, legitimate proof exemptions, the submission identity (Submission_Operation / Operation_ID),
   and the Capture_Generation.

### Requirement 16 (R16) — Server Review-Ready gating of formal approval

**User Story:** As an auditor, I want to only be able to formally approve a period once its capture is
complete and its required evidence is verified, so that approvals mean the evidence was present.

#### Acceptance Criteria
1. THE System SHALL compute Review_Ready for a period as true ONLY when the submitted frozen snapshot
   AND every required evidence dependency in the server-confirmed Required_Manifest are verified against
   the latest acknowledged entity revision.
2. WHILE a period is not Review_Ready, THE System SHALL present it (where authorised) as provisional
   work-in-progress and SHALL NOT allow formal approval.
3. WHERE a transaction is legitimately exempt from proof (per existing exemption rules), THE System
   SHALL treat its manifest requirement as satisfied without a proof object. (Existing cash-proof
   exemption via deposit slip must be preserved — confirm full exemption set in design.)
4. WHEN all required dependencies for a completed period are verified, THE System SHALL mark it
   Review_Ready.
5. THE System SHALL distinguish "locally complete" from "server Review_Ready" so a completed period can
   remain transfer-pending and locked while dependencies arrive.
6. WHEN an auditor formally approves a period, THE System SHALL require that the period is Review_Ready
   — complete verified evidence, a balanced submission, the current submitted revision, and the
   four-section verification — before accepting the approval; rejection prerequisites are separate and
   governed by R26 (traceable to R26).

### Requirement 17 (R17) — Same-device offline provisional review

> **DEFERRED (post-demo) — separately-scoped; NOT in demo scope (see SD-6, R38).** Same-device offline
> audit is unwired in source: `captureRepo.setClosed` and `syncEngine.isAuditApprovable` have no UI
> caller (Findings 12/13). The criteria below are PRESERVED for the future feature; for the demo, use
> the ONLINE-ONLY review path (R38). Capture-sync actor isolation and explicit handover (R28 core) are
> NOT deferred and remain demo-critical.

**User Story:** As a second authorised saved user on a shared field device, I want to review a locally
captured period offline and record a provisional decision, so that review can start without signal.

#### Acceptance Criteria
1. WHILE offline, WHERE a second saved authorised user is active on the same device, THE System SHALL
   allow that user to view the locally captured period and its local proofs, clearly labelled
   PROVISIONAL.
2. WHEN an authorised offline reviewer records a decision, THE System SHALL store it durably with the
   reviewing Actor identity and the exact reviewed entity revision, and SHALL lock the period locally.
3. WHEN connectivity returns, THE System SHALL upload the captured transactions and evidence
   dependencies BEFORE validating the offline review decision server-side.
4. IF the reviewing Actor's authority cannot be established on reconnect, THEN THE System SHALL keep the
   decision pending and request that Actor's online confirmation, and SHALL NOT attribute the decision
   to the capturer.
5. IF the reviewed revision is stale at validation time, THEN THE System SHALL reject the provisional
   decision and restore authorised read-only access to the current revision.
6. THE System SHALL NOT present an offline PIN decision as cryptographic non-repudiation.
7. THE System SHALL specify provisional APPROVAL and provisional REJECTION as separate offline flows,
   each re-validated under its own Actor's authority on reconnect (traceable to R28), and SHALL NOT
   allow any correction or handover path to bypass server-side locking.
8. THE System SHALL retain the verified local proof BYTES needed for same-device offline review so that
   a successful transfer does NOT auto-remove evidence a subsequent same-device reviewer still needs;
   THE System SHALL define a safe eviction policy and an unavailable-proof handling path, and SHALL NOT
   claim that browser storage is guaranteed (traceable to R28, R12).

### Requirement 18 (R18) — Durable, attributed override and acting-as audit events

**User Story:** As the organisation, I want every override and acting-as action recorded durably with
the real actor, so that governance exceptions are always traceable.

#### Acceptance Criteria
1. WHEN an Elder or Chairperson performs an `O` (override) capture, submit, or review action, THE
   System SHALL record a `SELF_REVIEW_EXCEPTION` (or the acting-as event) durably.
2. IF the override/acting-as audit record cannot be written online, THEN THE System SHALL queue it
   durably in the Local_Store and flush it on sync (no swallowed failure, no no-op).
3. WHEN a Chairperson submits on behalf of a Treasurer, THE System SHALL record the acting-as role and
   the actual user identity on the resulting audit event.
4. THE System SHALL preserve the originating Actor and authorisation context for every queued override
   so it is applied as that Actor's authenticated server action (traceable to R28).

### Requirement 19 (R19) — Complete, correct status-transition validation in the sync path

**User Story:** As the organisation, I want the Sync_Engine to apply only valid, non-regressive status
transitions, so that offline work can't drive the server backwards or into an invalid state.

#### Acceptance Criteria
1. WHEN the Sync_Engine applies a Business_State transition, THE Sync_Engine SHALL validate it against
   the canonical directional flow for the relevant vocabulary (C-2) rather than a 4-value rank alone.
2. IF the server has advanced beyond the locally captured Business_State, THEN THE Sync_Engine SHALL
   record a conflict and SHALL NOT overwrite the server state.
3. THE System SHALL restrict corrections and month-unlock transitions to HO.
4. WHEN an authorised reopen or correction occurs, THE System SHALL create a new Capture_Generation
   where appropriate and SHALL preserve the evidence and decisions of prior generations without
   overwriting them (traceable to R26).
5. THE System SHALL treat the `OverseerApproved` / `OverseerRejected` states — written and filtered by
   the Overseer review surface (`src/review/OverseerReview.tsx decide()`) but ABSENT from both the
   `ServiceStatus` enum (`src/lib/types.ts`) and the `statusFlow.ts` validator (whose `SubmittedToOverseer`
   successors are only `SubmittedToHO` / `Rejected`) — as a recorded status-vocabulary DISCREPANCY
   (Finding 29) requiring a separate decision, and SHALL NOT silently adopt either vocabulary without
   that decision (traceable to C-2).

### Requirement 20 (R20) — Correct proof-completeness semantics

**User Story:** As an auditor, I want "has proof" to mean a real verified proof exists, so that missing
evidence is never counted as present.

#### Acceptance Criteria
1. THE Capture_App SHALL treat a transaction as having its required proof only when a local proof blob
   or a verified proof object/attachment exists for the current revision.
2. THE Capture_App SHALL NOT treat a `Pending` proof status with no blob as satisfying a proof
   requirement.
3. WHEN proof is mandatory for a congregation and a required proof is absent, THE Capture_App SHALL
   block Complete_Capture and identify the affected transactions.

### Requirement 21 (R21) — Expense over-threshold ACKNOWLEDGEMENT gate (preserve current behaviour)

**User Story:** As the organisation, I want expenses over the threshold to be visibly flagged and to
require a mandatory acknowledgement before the capturer submits, so that large expenses are escalated to
the Overseer/HO's attention — WITHOUT changing the current gate in this phase.

> **Confirmed behaviour (do NOT change in this phase):** The gate fires at the PER-PERIOD
> Submit-for-Audit action in `CashbookForm.submit()` (`if (over500 && !elderComment.trim()) …` then
> `capture.submitPeriod`). It is an ACKNOWLEDGEMENT (awareness / reason-for-escalation-to-Overseer-HO /
> deterrent), NOT an approval. Over-threshold expenses are HIGHLIGHTED (amber banner) and do NOT stop
> capture. The MONTH submit-to-Overseer (`ChairpersonDashboard.handleSubmitAll`) enforces NO comment.
> The field is named `elderApprovalComment` / placeholder "Elder approval comment *";
> `monthlyExpensesExceedThreshold` is PER-PERIOD despite its name (it sums only the current period's
> items); `R500 = 500` is hardcoded and `congregation_settings.expense_approval_threshold` is unused.
> The three discrepancies flagged below are recorded as FINDINGS (Findings 16, 28) requiring a separate
> decision — this phase does NOT prescribe fixing them.

#### Acceptance Criteria
1. WHILE expenses in the current period exceed the threshold, THE Capture_App SHALL HIGHLIGHT the
   condition and SHALL NOT block capture of further transactions on that basis. **(Discrepancy — do NOT
   fix here: `R500` is hardcoded and `congregation_settings.expense_approval_threshold` is unused
   (Finding 16); whether to source the configurable threshold is an OPEN decision.)**
2. WHEN evaluating whether expenses exceed the threshold, THE System SHALL PRESERVE the CURRENT
   PER-PERIOD aggregation of `monthlyExpensesExceedThreshold`. **(PROPOSAL — per-month vs per-period is
   NOT an approved new business rule and remains OBD-b; the method name implies monthly but the code
   sums only the current period — Finding 16; see also SD-5.)**
3. WHILE expenses exceed the threshold, THE Capture_App SHALL require a mandatory ACKNOWLEDGEMENT comment
   before permitting the capturer's Submit-for-Audit / Complete_Capture step. **(Discrepancy — do NOT
   fix here: the gate is at per-period Submit-for-Audit, while the business description expects
   acknowledgement before submit-to-Overseer (Finding 28, OBD-d); the gate is NOT moved in this phase.)**
4. THE System SHALL treat the acknowledgement comment as RECORDED TEXT entered during capture and SHALL
   NOT represent capturer-entered text as authenticated Elder approval, even though the current field is
   labelled `elderApprovalComment`. **(Whether this should become an authenticated Elder approval /
   acknowledgement workflow is OBD-c and is DEFERRED post-demo — see SD-2, §9.3.)**

### Requirement 22 (R22) — Explicit congregation/ownership resolution for capture

**User Story:** As a capturer on a shared device, I want the app to open the period for the congregation
I'm authorised for, so that I never capture against the wrong congregation.

#### Acceptance Criteria
1. THE Capture_App SHALL resolve the permitted congregation from the active Actor's authorisation,
   not from the first local period on the device.
2. WHEN opening a period by local id, THE Capture_App SHALL verify the active Actor is authorised for
   that period's congregation before presenting it.
3. IF the active Actor is not authorised for a requested period's congregation, THEN THE Capture_App
   SHALL deny access and SHALL NOT present the period.
4. THE Capture_App SHALL resolve the local-to-server period id mapping explicitly rather than assuming
   a single shared-device scope.

### Requirement 23 (R23) — Bounded auditor dashboard refresh and a labelled WIP view

**User Story:** As an auditor, I want the queue to refresh and to optionally see provisional work, so I
can plan review without approving incomplete captures.

#### Acceptance Criteria
1. WHILE the Auditor dashboard is open and online, THE System SHALL refresh the pending queue on a
   bounded schedule and on reconnect.
2. THE System SHALL provide a separate, clearly labelled provisional work-in-progress view that
   includes authorised in-progress DRAFT capture progress AS WELL AS Submitted-but-not-yet-Review_Ready
   periods (traceable to R24).
3. THE System SHALL NOT make `Draft`/not-Review_Ready periods formally approvable from the WIP view
   (traceable to R16).

### Requirement 24 (R24) — Scoped, paginated, failure-aware attachment loading and current-version resolution

**User Story:** As an auditor, I want each period's proofs loaded correctly and completely, so that I
review the right current evidence.

#### Acceptance Criteria
1. WHEN loading a period for review, THE System SHALL query only that period's authorised attachments
   rather than fetching all RLS-visible attachments and filtering client-side.
2. THE System SHALL paginate attachment/line-item reads and handle API row limits explicitly.
3. WHEN multiple proof versions exist for a transaction, THE System SHALL resolve the current proof
   version EXPLICITLY by its recorded version/identity (not by first-match or timestamp sort), display
   it, and expose prior versions (traceable to R12).
4. IF an attachment/line-item query fails, THEN THE System SHALL surface the failure (traceable to R25).
5. WHEN loading a period for review, THE System SHALL use deterministic pagination and a consistent
   snapshot so that a review NEVER combines line items and attachments from incompatible revisions
   (traceable to R13).

### Requirement 25 (R25) — Fail-closed review on load/evidence failure

**User Story:** As the organisation, I want approval blocked when a review record didn't fully load, so
that an auditor can't approve against partial data.

#### Acceptance Criteria
1. IF line-item or attachment reads fail or are incomplete, THEN THE System SHALL block approval and
   SHALL NOT treat missing children as empty/valid.
2. WHEN the reviewed revision changes, the route changes, or the page reloads, THE System SHALL reset
   the four-section verification state.
3. WHEN an external change is detected, THE System SHALL refresh the changed items/attachments and
   SHALL reset stale external-change flags consistently.
4. IF a required proof object is missing or unreadable, THEN THE System SHALL block approval of that
   period.

### Requirement 26 (R26) — Atomic, server-validated review transitions bound to revision and actor

**User Story:** As the organisation, I want approve/reject/reopen to be a single server-validated
transaction with a mandatory audit record, so that decisions are consistent and always logged.

#### Acceptance Criteria
1. WHEN an auditor approves, rejects, or an authorised user reopens a period, THE System SHALL apply
   the decision as a single server-validated transition that includes the reviewed Entity_Revision, the
   Actor, and the mandatory audit record atomically (all-or-nothing); the prerequisites differ by
   decision type per R26.7–R26.9.
2. THE System SHALL enforce the four-section verification requirement recorded against the reviewed
   revision.
3. THE System SHALL enforce evidence completeness, balance, and permission server-side as prerequisites
   for APPROVAL (not only in the UI); rejection prerequisites are governed separately by R26.7.
4. IF the reviewed revision is stale (the record changed since load), THEN THE System SHALL reject the
   decision and require reload.
5. WHERE at most one decision per revision can be accepted, IF two auditors submit competing decisions,
   THEN THE System SHALL accept at most one and reject the other with its audit record intact.
6. THE System SHALL treat review completeness as a process control and SHALL NOT represent it as a
   guarantee that an auditor inspected every pixel.
7. WHEN an authorised reviewer rejects a submission, THE System SHALL require ONLY an authorised Actor,
   a mandatory rejection reason, and a reference to the reviewed snapshot/revision, and SHALL PERMIT
   rejection of an INCOMPLETE or UNBALANCED submission WITHOUT the approval prerequisites (complete
   evidence, balance, Review_Ready).
8. WHERE a period is reopened or corrected, THE System SHALL apply its own authorised rules (HO-only
   correction preserved; traceable to R19), SHALL create a new Capture_Generation where appropriate, and
   SHALL preserve earlier evidence and prior decisions.
9. THE System SHALL require, for formal APPROVAL only, complete verified evidence, a balanced
   submission, the current submitted revision, and the four-section verification (traceable to R16).
10. IF the single server transaction that records a decision rolls back, THEN THE System SHALL report
    the decision as FAILED, SHALL NOT claim the audit record remains committed, and SHALL record a
    competing/stale decision outcome; THE System SHALL distinguish a definitive failure RESULT from a
    transport EXCEPTION of unknown outcome and SHALL resolve the outcome idempotently.

### Requirement 27 (R27) — Server-validated month completion honouring the OAC calendar

**User Story:** As an Elder/Chairperson, I want month submission to require all expected weeks/services
(including R0 confirmations), so that incomplete months aren't advanced.

#### Acceptance Criteria
1. WHEN evaluating month completion, THE System SHALL validate the expected set of weeks and services
   for the OAC calendar month server-side, not only locally present periods.
2. THE System SHALL treat a required `R0_Confirmation` as satisfying the absence-of-transactions
   requirement for that week/service rather than a gap; HOWEVER an `R0_Confirmation` period SHALL still
   require normal audit approval before month advancement, and an `R0_Confirmation` SHALL NOT
   independently satisfy month completion.
3. THE System SHALL apply OAC calendar week rules consistently and SHALL handle transaction dates using
   the South African civil date rather than an unqualified UTC date. **(PROPOSAL — needs review:
   confirm timezone handling and the exact expected-period rule server-side; the exact expected AM/PM
   service calendar rules remain an OPEN business decision requiring confirmation — see §9.3.)**
4. IF a month is not complete, THEN THE System SHALL block month submission to the Overseer.
5. THE System SHALL treat month-submitted-to-Overseer (SERVER `SubmittedToOverseer`, not a local
   pending/queued state) as the prerequisite for advancing the next month where month sequencing
   applies; a read-only HO/Overseer in-month query SHALL NOT auto-unlock a month, and only HO may
   unlock or correct a locked month (traceable to R33, R19.3).
6. THE System SHALL treat AM (morning) and PM (evening / late-afternoon) services independently; absence
   of capture for either or both services for a week SHALL be permitted, SHALL NOT be manufactured into
   a mandatory AM/PM record, and SHALL NOT hinder next-week capture. THE System SHALL keep
   "service-did-not-occur" DISTINCT from "service-occurred-with-no-tithing" (`R0_Confirmation`, which
   still requires normal audit approval per R27.2). **(PROPOSAL — the exact expected AM/PM calendar rule
   remains OBD-a; preserve the existing behaviour and do NOT add a `has_pm_service` config. Any
   divergence between existing behaviour and intended governance is a FINDING for separate decision.)**

### Requirement 28 (R28) — Shared-device actor isolation and authenticated attribution

**User Story:** As the organisation, I want each saved user's queued work applied under their own
authority, so that one user's session never submits another user's work.

#### Acceptance Criteria
1. THE System SHALL NOT drain all saved users' pending operations under whichever JWT is currently
   active.
2. THE System SHALL persist the originating Actor and authorisation context with each operation and
   SHALL treat Device_ID as correlation only, never as permission.
3. WHEN an Actor's online authentication is unavailable, THE System SHALL pause that Actor's queued
   operations until that Actor's own authentication is available, using an explicit-handover model
   (the capturer authenticates and syncs their pending work, then the auditor authenticates and
   confirms their queued provisional review). **(DECIDED: pause-until-own-auth with explicit handover;
   the capturer's actions are never transmitted under the auditor's JWT; no delegation mechanism
   without a separate reviewed proposal; stored actor IDs alone are not sufficient authority.)**
4. THE System SHALL NOT accept a client-supplied actor/auditor id as authority and SHALL NOT store
   passwords for replay.
5. WHEN a user logs out, is revoked, or must re-authenticate, THE System SHALL preserve their captured
   work and quarantine unauthorised work for controlled reconciliation.
6. WHEN connectivity returns, THE System SHALL re-validate the originating Actor's authorisation —
   identity, active access, role, hierarchy scope, and access window — BEFORE dispatching that Actor's
   queued operations, and SHALL NOT dispatch on a stale cached authorisation (traceable to R13).
7. **(DEFERRED post-demo with R17 — see SD-6.)** THE System SHALL specify provisional APPROVAL and
   provisional REJECTION as separate flows (traceable to R17), each re-validated under its own Actor's
   authority on reconnect.
8. **(DEFERRED post-demo with R17 — see SD-6.)** THE System SHALL retain the verified local proof BYTES
   needed for same-device offline review so that a successful transfer does NOT auto-remove evidence a
   subsequent same-device reviewer still needs; THE System SHALL define a safe eviction policy and an
   unavailable-proof handling path and SHALL NOT claim that browser storage is guaranteed (traceable to
   R17, R12).
9. THE System SHALL NOT allow any correction or handover path to bypass server-side locking (traceable
   to R29).

### Requirement 29 (R29) — Server-side authorisation and integrity for all cashbook data

**User Story:** As the organisation, I want the database and storage to enforce access, so that UI gates
are never the only protection.

#### Acceptance Criteria
1. THE System SHALL restrict reads and writes of `cashbook_period`, `cashbook_line_item`, and
   `cashbook_attachment` to the Actor's authorised hierarchy scope via server-side policy, replacing
   any `USING (true)` all-authenticated policy.
2. THE System SHALL NOT trust client-supplied `congregation_id` or `uploaded_by`; it SHALL derive or
   validate them server-side.
3. THE System SHALL authorise every proof upload, read, replace, and delete against the real hierarchy,
   the parent line item, and the period state.
4. THE System SHALL prevent changes to proofs of submitted/approved periods via Storage APIs as well as
   table APIs, permitting ONLY authorised finalisation of manifest-declared outstanding proofs, and
   SHALL prohibit object overwrite, proof replacement, and undeclared attachments (traceable to R14).
5. THE System SHALL validate proof MIME type, size, and content on the server using actual
   provider-supported server-side validation rather than a mere existence/HEAD check, and SHALL
   preserve checksum, byte size, and compression provenance; THE System SHALL treat a client-provided
   hash as an integrity aid, not proof of authenticity.
6. THE System SHALL bind `audit_log` reads/writes to the Actor and scope rather than allowing
   unrestricted authenticated access.
7. THE System SHALL enforce ALL cashbook authority server-side via RLS and RPCs that perform internal
   actor/role/scope checks; HO-only administration SHALL retain its HO gate while capturer and auditor
   endpoints SHALL use OPERATION-SPECIFIC permissions; a frontend TypeScript validator SHALL NOT be
   treated as server authority (traceable to CON-SEC2, R28).
8. THE System SHALL revoke or constrain direct table writes that would bypass RPC validation, so that
   privileged state transitions cannot be performed by direct table access.

### Requirement 30 (R30) — Verify and restrict effective deployed security (live inspection)

**User Story:** As the organisation, I want the real deployed policies and bucket config confirmed and
tightened, so that we secure what actually runs, not what a migration filename implies.

#### Acceptance Criteria
1. THE System SHALL be assessed against the EFFECTIVE deployed RLS policies, grants, triggers,
   constraints, RPCs, `search_path`, storage buckets, and object policies (not migration filenames).
2. WHERE a deployed policy grants broader access than the Actor's authorised scope, THE System SHALL
   restrict it (traceable to R29).
3. THE System SHALL confirm the deployed proof bucket id and privacy before changing proof references
   (traceable to R14).
4. THE System SHALL confirm whether `get_or_create_period` and any approval/finalisation logic exist as
   server-side functions and whether they enforce authorisation and locking.
   *(All R30 items are UNVERIFIED — NEEDS LIVE INSPECTION; see the inspection commands in §9.)*

### Requirement 31 (R31) — Close exposed access from dormant Phase B–D features

**User Story:** As the organisation, I want dormant census/new-member data locked down even though its
UI is dormant, so that broad access policies don't leak member data.

#### Acceptance Criteria
1. THE System SHALL keep Phase B–D (census / new members / attendance) out of business scope for this
   feature.
2. WHERE a dormant Phase B–D table or the `member-docs` bucket grants broad authenticated access, THE
   System SHALL restrict or disable that access rather than relying on the dormant UI for protection.
3. THE System SHALL NOT assume absence of UI implies absence of data exposure.

### Requirement 32 (R32) — Protect pending records across upgrades, SW updates, and logout

**User Story:** As a field user, I want app updates and logouts to never wipe my unsynced work, so that
captured evidence survives maintenance.

#### Acceptance Criteria
1. THE System SHALL perform Local_Store schema upgrades additively and SHALL preserve pending records
   and proof bytes (no destructive clear).
2. WHEN the service worker updates the app, THE System SHALL preserve pending operations and evidence.
3. WHEN a user logs out, THE System SHALL preserve that user's unsynced captured work for later
   authenticated transfer (traceable to R28).
4. IF a Local_Store write fails due to quota, THEN THE System SHALL report it explicitly, SHALL request
   persistent storage where supported, and SHALL explain browser storage limits.
5. THE System SHALL review actual local proof encryption and per-user isolation and SHALL NOT treat PIN
   hashing as proof encryption. **(PROPOSAL — needs review: whether at-rest proof encryption is in
   scope.)**
6. THE System SHALL define a migration plan covering EVERY existing record state (pending, failed,
   syncing, synced, Submitted, approved), including proof blobs, missing-attachment acknowledgements,
   and duplicate/orphan reconciliation; additive schema creation ALONE SHALL NOT be treated as
   populating a usable outbox.
7. THE System SHALL NOT invent missing auditor identities and SHALL NOT silently certify legacy
   evidence as verified; THE System SHALL classify legacy records safely, support restartable backfill,
   and remain cutover-compatible.
8. THE System SHALL protect against older clients bypassing the new submission protocol and SHALL
   explicitly handle every supported upgrade path INCLUDING an install arriving from Dexie v1 through
   the existing DESTRUCTIVE v2 upgrade callback; a v5 additive declaration ALONE SHALL NOT be relied
   upon to protect such an install (traceable to CON-STORAGE4).
9. THE System SHALL NOT automatically purge historical records or evidence during migration.

### Requirement 33 (R33) — Convergence visibility, HO in-month visibility, and month lock/unlock

**User Story:** As an Overseer and as Head Office, I want to see the congregation work that has
converged to the Overseer and have in-month visibility of it before it reaches HO, so that we can plan
oversight and future ERP consumption without unlocking or altering the month.

> **Confirmed context:** All congregation captures converge at the Overseer (`SubmittedToOverseer`),
> which `src/review/OverseerReview.tsx` reads by `overseership_id`. HO (`src/review/HOReview.tsx`) today
> holds only `SubmittedToHO` work within its district-segregated scope; it is NOT yet the holder of
> `SubmittedToOverseer` work. The ERP/journaling consumption is a stated VISION, not built here.

#### Acceptance Criteria
1. WHILE online, THE System SHALL present to an Overseer the congregation captures routed to that
   Overseer (periods at `SubmittedToOverseer` within the Overseer's authorised hierarchy scope).
2. WHILE online, THE System SHALL give Head Office in-month VISIBILITY of `SubmittedToOverseer` work
   within the HO's district-segregated scope, clearly labelled as not-yet-at-HO (the holder is the
   Overseer; the server state is `SubmittedToOverseer`, not `SubmittedToHO`).
3. WHERE Head Office consumes or downloads submitted month data for ERP journaling or a future export
   API, THE System SHALL treat that capability as a future VISION and SHALL NOT be assumed built by
   this feature.
4. WHEN Head Office or an Overseer runs a read-only in-month visibility query, THE System SHALL NOT
   implicitly unlock a month and SHALL NOT alter any Business_State.
5. THE System SHALL treat `SubmittedToHO` as the final month lock; only Head Office may unlock or
   correct a locked month (traceable to R19.3, R27.5).
6. THE System SHALL scope all convergence and in-month visibility server-side to the viewer's authorised
   hierarchy (traceable to R29, R30).

### Requirement 34 (R34) — Submission/sync receipt exposing a stable Submission_Operation ID and acknowledged contents

**User Story:** As Head Office or an Overseer troubleshooting a submission, I want a stable reference ID
and a record of what the server actually acknowledged, so that I can reconcile a submission rather than
rely on a bare success timestamp.

#### Acceptance Criteria
1. WHEN a submission or sync reaches the backend, THE System SHALL expose a stable server-returned
   Submission_Operation identifier for the logical submission that persists across retries and lost
   acknowledgements (traceable to R11, R15).
2. THE System SHALL present a receipt that shows WHAT the server acknowledged — the submitted metadata,
   the Required_Manifest / required-proof state, and the acknowledged entity revision — rather than only
   a success timestamp.
3. THE System SHALL make the Submission_Operation identifier available to Head Office, the Overseer, and
   the capturer as a troubleshooting reference.
4. IF a submission's server-effect outcome is unknown (a lost acknowledgement), THEN the receipt SHALL
   reflect the unconfirmed state and THE System SHALL resolve the outcome idempotently rather than
   presenting an unverified success (traceable to R11, R26.10).

### Requirement 35 (R35) — Sync progress, staleness awareness, and progressive non-blocking sync

**User Story:** As a field capturer, I want to see that sync is not instant and how much of my work is
still outstanding, so that I understand what the server does and does not yet know.

> **Confirmed context:** Sync is fire-and-forget from `CashbookForm.submit()` only; there is no
> startup/reconnect/interval trigger, and `syncMeta.lastSyncAt` is written but not surfaced. These ACs
> make outstanding work and staleness visible without blocking capture.

#### Acceptance Criteria
1. THE Capture_App SHALL display the count of unsynced local operations/periods and the last successful
   sync time to the capturer.
2. WHILE local work remains unsynced beyond a review-warning threshold, THE Capture_App SHALL show a
   non-blocking stale-data warning. **(PROPOSAL — the warning threshold(s) are proposed for review and
   are NOT an agreed deadline.)**
3. THE System SHALL distinguish device-local unsent work (never transmitted, whose contents are
   unknowable server-side) from server-known incomplete submissions, so Head Office is not assumed to
   know the contents of a device that never synced.
4. THE System SHALL represent metadata-transfer status and proof-upload status as separate, inspectable
   states (for example: Dexie-write-ok/failed, pending/attempting, stored-on-Supabase,
   ready-for-auditor-review) (traceable to R5).
5. THE Sync_Engine SHALL start or resume progressive sync as soon as eligible work AND authenticated
   connectivity exist, and SHALL NOT wait for audit approval before transferring (traceable to R13, R9).
6. THE System SHALL surface non-blocking warnings for outstanding metadata/proofs, the oldest unsynced
   work, and incomplete server submissions.
7. THE System SHALL NOT hinder next-week capture because prior work remains unsynced (traceable to R13,
   R32).

### Requirement 36 (R36) — Authorised provisional read-only visibility of server-acknowledged in-progress capture

**User Story:** As an authorised auditor, I want read-only visibility of in-progress capture the server
has acknowledged, clearly marked provisional, so that I can plan review without approving incomplete
work.

#### Acceptance Criteria
1. WHERE an authorised auditor is online, THE System SHALL permit READ-ONLY visibility of
   server-acknowledged in-progress capture, clearly labelled PROVISIONAL (traceable to R23).
2. THE System SHALL restrict formal approval to the real submitted-for-audit state with complete
   required evidence and SHALL NOT allow approval from the provisional view (traceable to R16).
3. THE System SHALL scope provisional visibility server-side to the auditor's authorised hierarchy
   (traceable to R29, R30).

### Requirement 37 (R37) — Reliability invariants: idempotency ledger and financial-aggregate anti-duplication

**User Story:** As the organisation, I want retries and lost acknowledgements to never duplicate logical
work or double-count money, expressed as checkable invariants, so that reliability is testable without
over-prescribing storage shape.

#### Acceptance Criteria
1. THE System SHALL ensure that a logical operation applied with the same Operation_ID — on retry or
   after a lost acknowledgement — produces exactly one logical effect (idempotency-ledger invariant).
   **(The storage shape / field names are a DESIGN choice; this requirement does NOT mandate a specific
   table or column.)**
2. THE System SHALL ensure that a captured financial transaction or proof is counted AT MOST ONCE in any
   server-side aggregate despite retries, reconnects, or duplicate submissions (no-double-count
   invariant). **(Expressed as a testable invariant; this requirement does NOT mandate a new expense
   table or an expense-specific partial unique index — see SD-3.)**
3. THE System SHALL justify each new reliability constraint against a concrete observed reliability
   defect and SHALL preserve authorised correction and reopen (traceable to R12, R19, R26).

### Requirement 38 (R38) — Demo online-only review path (offline capture preserved)

**User Story:** As the demo operator, I want a clearly-communicated online-only review path while
same-device offline review is deferred, so that the demo is reliable without removing offline capture.

#### Acceptance Criteria
1. FOR the demo, THE System SHALL provide a clearly-communicated ONLINE-ONLY review and approval path
   (the capturer captures offline; the auditor reviews and approves online after the capture has
   synced).
2. THE System SHALL preserve offline capture and the saved-user picker; the online-only review path
   SHALL NOT remove either.
3. THE System SHALL preserve actor-specific authenticated replay and explicit handover for CAPTURE sync
   as demo-critical (traceable to R28).
4. THE System SHALL treat same-device offline PROVISIONAL review (R17) as a separately-scoped feature
   DEFERRED post-demo and SHALL NOT rely on it for the demo (traceable to SD-6).

---

## Non-Functional Requirements, Targets & Architectural Constraints

NFR targets flagged by the brief as proposals are explicit; the **business requirement** is the
2-minute proof expectation (NFR-L1). Measurement-dependent values must not be reinterpreted as the
only metric reported.

### Latency (NFR-L)
- **NFR-L1 (business requirement):** WHILE connected, WHEN a completed transaction enters the transfer
  queue, THE System SHALL make its required proof reviewable within **2 minutes**. Every breach SHALL
  be reported; the measure SHALL be reported as p50/p95/p99 and max — not reduced to p95 alone.
- **NFR-L2:** WHEN a proofless transaction's metadata is transferred, THE System SHALL make it visible
  to authorised reviewers near-immediately. Initial target **p95 ≤ 2 seconds — engineering target
  (adopted)** under defined measurement conditions (not a user-facing guarantee); THE System SHALL
  define the measurement conditions and report every breach. The 2-minute proof-ready expectation
  (NFR-L1) remains the business requirement.
- **NFR-L3:** THE System SHALL set and report, EXPLICITLY and ALONGSIDE the per-transaction 2-minute
  requirement (NFR-L1), a whole-period Complete_Capture→Review_Ready expectation under declared
  workload, file-size, and connectivity conditions; THE System SHALL report user-perceived elapsed time
  and transfer time SEPARATELY (including authentication and offline waits), and SHALL NOT reset the
  clock after an arbitrary delay.
- **NFR-L4:** THE System SHALL make offline waiting and reauthentication waiting separately visible in
  latency reporting (they are not counted as transfer latency).

### Throughput / capacity model (NFR-C)
- **NFR-C1:** THE System SHALL be planned against ~6,000 simultaneously **active users** (not DB
  connections), modelling the capturer/auditor mix explicitly (typically 1–2 capturers + 1–2 auditors
  per congregation).
- **NFR-C2:** THE System SHALL model ~30,000 proofs/month and ~20 transactions with ~17 proofs per
  capture activity, with a distinct concentrated-Sunday stress scenario. These SHALL be treated as
  separate planning figures, not multiplied into "6,000 × 20 proofs at peak" unless explicitly run as a
  stress scenario.
- **NFR-C3 (PROPOSAL — needs review):** default **one active proof upload per device** initially,
  configurable from measurement; metadata transferred in bounded batches.
- **NFR-C4:** THE System SHALL NOT add fixed 2–5s per-file delays unless tests justify them. Client
  jitter is not global admission control; THE System SHALL measure server bottlenecks and add fair,
  bounded admission/rate limiting only where required.

### Proof size & readability (NFR-P)
- **NFR-P1:** THE System SHALL MEASURE the current `compressImage` output (p50/p95/max compressed size)
  from `src/lib/imageCompress.ts` / `ProofModal` on representative devices rather than promising a WebP
  quality/size. Current defaults are JPEG `quality=0.8`, `maxWidth=1920`, pass-through below 500KB.
- **NFR-P2:** THE System SHALL keep proofs readable enough for auditors to read text and signatures;
  thumbnails SHALL NOT replace evidence.

### Cost & operability (NFR-O)
- **NFR-O1 (design/tasks phase):** THE System SHALL produce a cost model from CURRENT official Supabase
  pricing and the actual chosen compute/region (storage, egress, DB, Auth, functions, Realtime, logs),
  with base and stress scenarios, assumptions, and alerts. THE System SHALL base storage estimates on
  the measured MEAN/TOTAL retained bytes plus retention accumulation over time, using p95/max for
  stress scenarios; THE System SHALL NOT treat the p50 per-file size as a reliable total-storage
  estimate. THE System SHALL NOT assume a plan tier guarantees capacity or unlimited spend caps.
- **NFR-O2:** THE System SHALL use scoped queries, selected columns, pagination, and indexes proven
  with representative query plans; THE System SHALL avoid table-wide local scans and resending
  unchanged children; THE System SHALL bound dashboard polling/subscriptions.
- **NFR-O3:** THE browser client SHALL use the Supabase HTTP Data API; THE System SHALL NEVER embed a
  Postgres connection string or the service-role key in the Vite bundle.
- **NFR-O4:** THE System SHALL monitor queue age, incomplete submissions, retry/429/error rates,
  auth-paused actions, proof-ready latency, DB resource, Realtime fanout, and storage/egress growth.
- **NFR-O5:** THE System SHALL retain security/error evidence while reducing debug volume and SHALL NOT
  disable audit logging to save cost.
- **NFR-O6:** THE System SHALL verify backups cover BOTH the database and proof bytes, with a tested
  coordinated restore and a reference-integrity check.
- **NFR-O7:** THE System SHALL NOT require monthly partitioning solely because of ~360k proofs/yr;
  partitioning decisions SHALL start from actual growth, indexes, and query plans. Historical review
  SHALL remain usable without recompressing or altering approved evidence.

### Retention (NFR-R)
- **NFR-R1:** THE System SHALL retain historical months and proofs as retrievable; there is NO agreed
  retention/deletion period and THE System SHALL NOT purge historical evidence.
- **NFR-R2 (DECIDED — DEFERRED):** Hot/cool storage tiering is deferred; THE System SHALL retain
  private Supabase Storage and measure growth/cost first, with no automatic deletion or recompression.
  "proofs <45 days hot, older cool" remains a future cost objective, not an established setting; THE
  System SHALL validate provider capability before proposing tiering and SHALL NOT implement a
  fabricated hot/cool setting or delete old proofs.

### Testing & verification (NFR-T)
- **NFR-T1:** THE System SHALL use property-based tests for pure logic (for example reducers,
  validators, backoff, manifest/revision reconciliation) and SHALL NOT describe property tests as proof
  of server-side correctness.
- **NFR-T2:** THE System SHALL verify client durability with REAL-BROWSER IndexedDB, suspension/
  termination, migration, and multi-tab tests rather than mocks alone.
- **NFR-T3:** THE System SHALL verify server behaviour with REAL RPC, RLS, and Storage integration
  tests, and SHALL run load tests only under separate explicit authorisation.
- **NFR-T4:** THE System SHALL NOT prescribe one test per property, nor an arbitrary iteration count,
  as sufficient evidence of correctness.

### Security architecture constraints (CON-SEC)
- **CON-SEC1:** Keep the six host-level security headers (vercel.json + public/_headers) intact.
- **CON-SEC2:** The service-role key lives only in Edge Functions; never in the client bundle. HO-only
  administration SHALL retain the `admin-write` HO gate (key present → bearer → `auth.getUser` → active
  HO access → validate body → service-role write), and any new HO-only privileged Edge Function
  reproduces that gate. Capturer and auditor privileged operations SHALL be authorised by
  OPERATION-SPECIFIC server checks (RLS + RPCs performing internal actor/role/scope checks), NOT by the
  HO gate; a frontend TypeScript validator SHALL NOT be treated as server authority. Direct table
  writes that would bypass RPC validation SHALL be revoked or constrained (traceable to R29).
- **CON-SEC3:** Offline auth stays a provisional convenience gate; RLS + reconnect re-validation remain
  authoritative.

### Storage / data-durability constraints (CON-STORAGE)
- **CON-STORAGE1:** Persist a transaction mutation AND its durable Outbox_Op atomically in Dexie,
  tracking Entity_Revision, Actor identity, congregation, Operation_ID, dependencies, attempts,
  nextAttemptAt, lease, and failure category. **(Exact schema field names are a DESIGN choice — the
  design SHALL justify a minimal change compatible with existing v4 data and additive Dexie upgrades.)**
- **CON-STORAGE2:** Separate Business_State from Transfer_State in the local and server models.
- **CON-STORAGE3:** A shared Deposit_Slip object may be referenced by multiple banked items; the
  manifest and deduplicated attachment links SHALL survive partial failures.
- **CON-STORAGE4:** The historical destructive Dexie v2 upgrade assumption ("no real offline data")
  SHALL NOT be reused; the migration SHALL explicitly handle an install arriving from v1 THROUGH that
  destructive v2 callback, since a later additive (v5) declaration ALONE does not protect such an
  install (traceable to R32).

### Interface constraint (CON-IF)
- **CON-IF1:** Keep storage operations behind a modest, replaceable interface to allow a later migration
  — without overengineering. (Retained provider is Supabase Storage; see Exclusions.)

---

## Acceptance-Test Coverage Map (criteria exist for these scenarios)

The detailed test plan belongs in the tasks phase; this maps required scenarios to requirements so the
design can derive correctness properties.

- Offline local save + reload preserves capture + proof bytes → R1.
- Progressive metadata visibility without waiting for image transfer or complete capture; unsubmitted
  work labelled and not approvable → R5, R16.
- Complete_Capture atomically freezes the snapshot + immutable manifest, creates one durable
  Submission_Operation, locks local editing immediately; the submission mechanism validates the exact
  snapshot + manifest and records its audit atomically; declared-missing proofs finish uploading AFTER
  `Submitted`; the period becomes Review_Ready only after the submitted snapshot AND all required
  dependencies are verified → R15, R16.
- Rejection of an incomplete/unbalanced submission requires only an authorised actor + mandatory reason
  + reviewed-revision reference (not the approval prerequisites); reopen/correction creates a new
  capture generation preserving prior evidence/decisions; a rolled-back decision transaction is reported
  as failed and never claimed committed → R26, R19, R16.
- Zero duplicate logical transactions/attachments/submissions/approvals after retries + lost acks →
  R11, R6, R26.
- Failure injection after object upload / after line insert / during attachment insert / during
  finalisation / during local ack; no evidence discarded; recovery converges → R7, R8, R10, R12.
- Termination during sync, multiple tabs, simultaneous calls, editing/replacing proof during upload,
  same-second proofs, shared deposit links, deleting an already-uploaded line → R6, R8, R10, R11,
  CON-STORAGE3, R4.
- JWT expiry, revoked roles, different active user, network flapping, unreachable backend, 429,
  permanent validation failure; attribution + pending data preserved → R13, R28, R9.
- Offline capturer→auditor switch on one device; provisional approval; reconnection per actor; stale
  reviewed-version rejection + restoration of authorised read-only → R17, R28. **(DEFERRED post-demo —
  SD-6; the demo exercises the online-only review path instead → R38.)**
- Demo online-only review path keeps offline capture + the saved-user picker; capture-sync actor replay
  and explicit handover remain demo-critical → R38, R28.
- Overseer sees converged `SubmittedToOverseer` captures in scope; HO has in-month visibility of
  `SubmittedToOverseer` work without auto-unlocking; `SubmittedToHO` is the final month lock, HO-only
  unlock → R33, R27.5, R19.3.
- Submission/sync receipt exposes a stable Submission_Operation ID and shows what the server
  acknowledged (metadata, required-proof state, revision), not a bare timestamp; lost-ack resolves
  idempotently → R34, R11, R26.10.
- Unsynced count + last-sync time + stale-data warning surfaced; device-local unsent vs server-known
  incomplete distinguished; metadata vs proof statuses separated; progressive sync starts on
  eligible-work + authenticated connectivity without waiting for approval; next-week capture never
  blocked by unsynced prior work → R35, R5, R13.
- Authorised auditor read-only PROVISIONAL visibility of server-acknowledged in-progress capture; no
  approval from the provisional view → R36, R23, R16.
- Idempotency-ledger invariant (one logical effect per Operation_ID on retry/lost-ack) and
  no-double-count financial-aggregate invariant, without mandating a new expense table or
  expense-specific partial index → R37, R11, SD-3.
- Two auditors compete → at most one accepted decision per revision with atomic audit record; failed
  reads/missing objects/stale checkboxes block approval → R26, R25.
- Direct API + Storage attempts by unauthorised users; auditors attempting proof changes;
  cross-congregation access; fake `uploaded_by`/audit actor; approved-period mutation (test real
  RLS + RPCs, not only UI) → R29, R3, R26.
- Historical month retrieval + replacement history; no retention purge; accurate expected-period / R0 /
  month-completion + local/server id routing → R12, R27, R22, NFR-R1.
- Low-end mobile compression/readability + storage quota failures + update/migration preserves pending
  records → NFR-P1/P2, R32.
- Repeatable 20–30-user live demo, then staged 100 / 500 / 1,000 / 6,000 active-user tests on a
  dedicated env with distinct authenticated users, representative congregation distribution, realistic
  captures/reviews, measured images, and a concentrated reconnect burst — WITH explicit authorisation
  and provider-compatibility confirmation BEFORE high-volume paid tests → NFR-C1/C2, NFR-O1.
- Reporting: p50/p95/p99 AND max latency, errors, retries, correctness, resource/cost; NFR-L2 (metadata
  p95 ≤ 2s) is an adopted engineering target under defined measurement conditions; NFR-L1 (2-minute
  proof) is the business requirement — report every breach, define qualifying conditions, do not
  reinterpret as only-p95 → NFR-L1..L4.
- Capacity SHALL NOT be certified from mocks or a 30-user demo → NFR-C1.
- Property tests cover pure logic only (not proof of server correctness); real-browser IndexedDB /
  suspension / migration / multi-tab tests, real RPC/RLS/Storage integration tests, and
  separately-authorised load tests are required; no one-test-per-property or fixed iteration count is
  treated as sufficient → NFR-T1..T4.

---

## Exclusions

The following are explicitly out of scope for this feature:

1. **No new backend platform / storage provider.** Retain Vite + React + TypeScript PWA, Dexie, and
   Supabase (Auth/Postgres/RLS/Storage). Do NOT introduce Azure storage, Azure SSO, ZIP exports, or
   sponsored-data integrations. (Storage ops kept behind a modest replaceable interface per CON-IF1.)
2. **No rebuild.** This hardens the existing app; it does not re-architect roles, the permission
   matrix, the hierarchy model, or the capture UX beyond the reliability/security changes specified.
3. **Phase B–D business features stay dormant** (census / new members / attendance / baptisms). Only
   their *exposed data access* is fixed/disabled (R31); no dormant UI or workflow is built.
4. **No automatic retention/deletion** and no hot/cool storage tiering in this feature — tiering is
   DEFERRED pending growth/cost measurement; retain private Supabase Storage with no automatic deletion
   or recompression (NFR-R1, NFR-R2).
5. **No reliance on the superseded `cashbook_service` schema** (`src/lib/supabase/schema.sql`) or the
   obsolete `captureQueue` model; the original AI-research conversation's superseded suggestions and
   unsupported guarantees are NOT authoritative.
6. **No certification of 6,000-user capacity** from mocks or the demo; capacity claims require the
   staged, authorised load tests (§7).

---

## Unknowns / To-Be-Measured (and how to resolve them)

### 9.1 Measurements required (before promising targets)
- U-M1: Compressed proof size distribution (p50/p95/max) from the current `compressImage` pipeline on
  representative devices/images → feeds NFR-P1, NFR-C2, NFR-O1.
- U-M2: Metadata-transfer latency and whole-period Review_Ready latency under base and
  concentrated-Sunday load → feeds NFR-L1..L3.
- U-M3: Retention growth rate, proof replacement/version frequency, shared-deposit-slip frequency →
  feeds NFR-O1, NFR-O7, NFR-R.
- U-M4: Server resource behaviour (DB, Realtime fanout, egress) at 100/500/1,000/6,000 active users →
  feeds NFR-C, NFR-O1.
- U-M5: `monthlyExpensesExceedThreshold` actual aggregation scope (read `@/lib/captureTotals.ts` in
  design) → feeds R21.
- U-M6: Current OAC week rules and timezone handling (`@/lib/oacWeeks`, UTC `slice(0,10)` dates) →
  feeds R27.
- U-M7: Service-worker precache/runtime strategy and whether any Background Sync exists → feeds R13,
  R32.

### 9.2 Live Supabase inspection required (read-only) — resolves R30 and UNVERIFIED findings
Run against the deployed project (psql or Supabase SQL editor; read-only). These confirm effective
security rather than inferring it from migration files.

```sql
-- RLS enabled/forced on cashbook + audit + settings tables
select relname, relrowsecurity, relforcerowsecurity
from pg_class
where relname in ('cashbook_period','cashbook_line_item','cashbook_attachment',
                  'audit_log','congregation_settings');

-- Effective policies on those tables (cmd, roles, USING, WITH CHECK)
select schemaname, tablename, policyname, cmd, roles, qual, with_check
from pg_policies
where tablename in ('cashbook_period','cashbook_line_item','cashbook_attachment',
                    'audit_log','congregation_settings',
                    'census_congregation','census_priestship','attendance_monthly',
                    'new_members_register')
order by tablename, cmd;

-- Grants to anon/authenticated on the cashbook tables
select table_name, grantee, privilege_type
from information_schema.role_table_grants
where table_name in ('cashbook_period','cashbook_line_item','cashbook_attachment','audit_log')
order by table_name, grantee;

-- Storage buckets: id + privacy flag (confirm cashbook-proofs vs cashbook_proofs, public?)
select id, name, public, file_size_limit, allowed_mime_types from storage.buckets;

-- Storage object policies (proof bucket + member-docs)
select policyname, cmd, roles, qual, with_check
from pg_policies
where schemaname = 'storage' and tablename = 'objects';

-- Server-side functions (approval/period/month logic) + SECURITY DEFINER + search_path
select n.nspname as schema, p.proname, p.prosecdef as security_definer,
       pg_get_function_identity_arguments(p.oid) as args,
       (select array_agg(c) from unnest(p.proconfig) c) as config
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and (p.proname ilike '%period%' or p.proname ilike '%approve%'
       or p.proname ilike '%audit%' or p.proname ilike '%month%' or p.proname ilike '%lock%');

-- Non-internal triggers (any server-side enforcement of transitions/locks)
select tgname, tgrelid::regclass as table, tgenabled
from pg_trigger where not tgisinternal;

-- Base table shape of cashbook_period (confirm status vocabulary, lock column, constraints)
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_name = 'cashbook_period' order by ordinal_position;
select conname, pg_get_constraintdef(oid)
from pg_constraint where conrelid = 'public.cashbook_period'::regclass;

-- Migration history actually applied (do NOT infer from docs/migrations filenames)
select version, name from supabase_migrations.schema_migrations order by version;
```

CLI alternatives (read-only):
```bash
# Edge Function deployment status (Finding: functions written but deployment unverified)
supabase functions list

# Pull the live schema for diffing against repo SQL (requires linked project)
supabase db dump --schema public --file ./live_public_schema.sql
```

### 9.3 Decisions needing explicit sign-off before design

The submission protocol (R15/R16), the separation of approval/rejection/reopen prerequisites
(R16/R26/R19), shared-device actor isolation with re-validation before dispatch (R13/R17/R28), and
operation-specific server authority (R29/CON-SEC2) are now DECIDED and are no longer open. The
following remain open.

**Open BUSINESS decisions (require sign-off):**
- OBD-a: The exact expected AM/PM service calendar rules for month completion (R27.3) — OPEN.
- OBD-b: Per-month vs per-period expense-threshold aggregation (R21.2) — OPEN; the design preserves the
  CURRENT behaviour as a proposal, NOT an approved new business rule.
- OBD-c: Whether the capturer-entered Elder comment should become an authenticated Elder approval
  rather than recorded text (R21.4) — OPEN. (The authenticated workflow itself is DEFERRED post-demo —
  SD-2.)
- OBD-d: The R500 gate LOCATION — it currently fires at per-period Submit-for-Audit, while the business
  description expects acknowledgement before month submit-to-Overseer (Finding 28, R21.3) — OPEN; the
  gate is NOT moved in this phase.

**Open TECHNICAL / measurement decisions:**
- D-2: Delta-sync granularity for edited periods (R2.4).
- D-6: Whether at-rest local proof encryption is in scope (R32.5).
- D-7: NFR-C3 single-active-upload default (confirm from measurement; NFR-L2 metadata target adopted).
- D-8: Reconciling the `OverseerApproved` / `OverseerRejected` status-vocabulary discrepancy — states
  used by the Overseer surface but absent from `ServiceStatus` and `statusFlow.ts` (Finding 29, R19.5)
  — recorded as a FINDING for separate decision; not reconciled in this phase.
- D-9: Sync-staleness warning threshold(s) (R35.2) — proposed for review, not an agreed deadline.

**DEPENDS-ON / UNVERIFIED deployed-schema items (retained):** All R30 / §9.2 live-inspection items
remain open until confirmed against the deployed project; no requirement asserts deployed security as
fact.

---

## Traceability Notes

- Findings → Requirements: see the "Drives" column in §3. Every one of the 29 findings maps to at
  least one requirement.
- Conflicts C-1..C-6 (§3.1) are reflected in R14, R19, R27, R32 and the Exclusions.
- All UNVERIFIED items converge on R30 with the §9.2 commands; no requirement asserts deployed security
  as fact.
- This revision's amendments: the "Superseded & Deferred (post-demo)" subsection (SD-1..SD-6) records
  the five explicitly-out-of-scope items plus the deferral of same-device offline review (R17 → R38);
  R21 is corrected to the actual R500 ACKNOWLEDGEMENT behaviour (Findings 16, 28; OBD-c, OBD-d); the
  status-vocabulary discrepancy is R19.5 / Finding 29 / D-8; and R33–R38 add Overseer/HO convergence &
  in-month visibility, submission receipts, sync-staleness awareness, authorised provisional read-only
  visibility, the reliability invariants, and the demo online-only review path. All DEPENDS-ON /
  UNVERIFIED deployed-schema items (§9.2, R30) remain open; no new schema field names are prescribed
  before the deployed data model is reconciled.
