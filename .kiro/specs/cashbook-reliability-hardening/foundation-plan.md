# Implementation Plan — Two-Person Sign-Off Server Foundation

Branch `feat/treasurer-dashboard-v1`, worked IN PLACE. Repo/cwd for every step:
`c:\Users\User\OneDrive - Morriscom Solutions\Apps\jw-cashbook-v4`.
Commit incrementally. Do NOT push, deploy, or apply any SQL to any backend. Do NOT modify
Tranche-4 proof-access objects. Keep `PROGRESSIVE_DISPATCH_ENABLED` and
`SUBMITTED_PROOF_FINALISATION_ENABLED` unchanged.

Design authority: `.kiro/specs/cashbook-reliability-hardening/foundation-design.md`. The exact object
names/columns/types, the submit/manifest decision, the RLS rules, and the server contract are there;
this plan sequences the build. Do not re-decide the architecture.

Gate after the relevant steps: `npm run typecheck` (0 errors), `npx vitest run` (baseline 199 passing),
`npm run lint` (not worse than baseline).

---

- [ ] 1. Create the additive foundation migration.
      Create `supabase/migrations/20261105110000_signoff_foundation.sql` (timestamp sorts BEFORE
      `20261105120000`). It must be additive — `create ... if not exists`, `create or replace`, `add
      column if not exists`; the only `drop` permitted is `drop trigger if exists trg_guard_submitted`
      / `drop policy if exists` on objects this migration itself creates (so a clean backend is a
      no-op drop). Contents, in order, matching foundation-design.md §2 exactly:
      (a) `alter table public.cashbook_period add column if not exists server_revision integer not null
          default 0, add column if not exists capture_generation integer not null default 1;`
      (b) base table `public.cashbook_review_decision` with columns `id, period_id, actor_user_id,
          capture_generation, reviewed_revision, decision, outcome, reason, created_at`, the named
          constraints `cashbook_review_decision_decision_check` (`decision in
          ('approve','reject','reopen')`) and `cashbook_review_decision_outcome_check` (`outcome in
          ('accepted','rejected_stale')`), and the unique partial index
          `cashbook_review_decision_one_accepted` on `(period_id, capture_generation,
          reviewed_revision) where (outcome = 'accepted')`.
      (c) `public.cashbook_op_ledger (op_id uuid primary key, result jsonb not null, created_at
          timestamptz not null default now())`.
      (d) `public.cashbook_submission_manifest` with columns `id, period_id, capture_generation,
          revision, balanced, outstanding_proof_count, proofs, frozen_by, frozen_at` and `unique
          (period_id, capture_generation, revision)`.
      (e) `public.cashbook_review_ready(p_period_id uuid, p_reviewed_revision int) returns boolean`
          (SECURITY DEFINER, `set search_path to ''`, stable) implementing the 4 conditions in
          foundation-design.md §2.5.
      (f) `public.cashbook_submit_period(...)` with the exact signature + fail-closed body in
          foundation-design.md §4.2, including `perform set_config('cashbook.submit_rpc','1', true)`
          before the `Submitted` update, the manifest upsert, the `SUBMIT` audit-log insert, and the
          op-ledger write.
      (g) `public.cashbook_guard_submitted()` trigger function + `trg_guard_submitted` BEFORE UPDATE
          trigger on `public.cashbook_period`, mirroring `trg_guard_audit_approved` but for
          `new.status = 'Submitted'` and GUC `cashbook.submit_rpc`.
      (h) RLS per foundation-design.md §2.7: enable RLS on all three new tables; scoped SELECT policy
          on `cashbook_review_decision` and `cashbook_submission_manifest`; no policies on
          `cashbook_op_ledger`; `revoke all ... from public, anon` on the two RPCs + `op_ledger`,
          `grant select` on the two readable tables and `grant execute` on both RPCs to
          `authenticated`.
      Files: supabase/migrations/20261105110000_signoff_foundation.sql
      Verify: `npx vitest run` and `npm run typecheck` still pass (no app code changed yet — SQL is
      not executed here). Static self-review: every object `20261105120000` references (grep it) has a
      matching name/type in the new file.

- [ ] 2. Confirm `20261105120000_two_person_signoff.sql` needs no edit.
      Read `20261105120000` against step 1's objects and verify each referenced name/column/type
      matches (base table columns, `cashbook_review_decision_one_accepted`,
      `cashbook_review_decision_decision_check`, `cashbook_op_ledger(op_id,result)`,
      `cashbook_period.server_revision`/`capture_generation`, `cashbook_review_ready(uuid,int)`,
      `cashbook_submission_manifest`, `audit_log.assumed_role`). Expected outcome: NO change required
      (foundation-design.md §5). If and only if a genuine mismatch is found, fix it in the FOUNDATION
      file (step 1), not here, and record the reconciliation in foundation-design.md §5.
      Files: (none expected) supabase/migrations/20261105120000_two_person_signoff.sql
      Verify: a written note in the step output stating "no edits required" (or listing the exact
      foundation-side change made and why).

- [ ] 3. Add the `submitOpId` field to the local period model.
      Add `submitOpId?: string | null;` to `LocalPeriod` in `src/db/schema.ts` (additive, optional,
      non-indexed — no Dexie `.version()` bump, consistent with the existing optional LocalPeriod
      fields). Add a short comment that it is the stable op-ledger id reused across submit-RPC retries.
      Files: src/db/schema.ts
      Verify: `npm run typecheck` = 0; `npx vitest run` still 199.

- [ ] 4. Add a pure submit-manifest payload helper + its tests.
      In `src/lib/completeCapture.ts` add `export interface SubmitManifestPayload { balanced: boolean;
      outstandingProofCount: number; proofs: ManifestProofEntry[]; }` and `export function
      buildSubmitManifestPayload(manifest: RequiredManifest | null | undefined): SubmitManifestPayload`
      — returns `{ balanced:false, outstandingProofCount:0, proofs:[] }` when the manifest is absent
      (fail-closed: unbalanced ⇒ not Review_Ready), otherwise `{ balanced: manifest.balanced,
      outstandingProofCount: outstandingProofs(manifest).length, proofs: manifest.proofs }`. Add a
      `describe("buildSubmitManifestPayload", ...)` block to `src/lib/completeCapture.test.ts` covering
      the null case, a balanced manifest with zero outstanding, and a manifest with declared-outstanding
      proofs (non-zero count).
      Files: src/lib/completeCapture.ts, src/lib/completeCapture.test.ts
      Verify: `npx vitest run src/lib/completeCapture.test.ts` passes (11 existing + new cases).

- [ ] 5. Set a stable `submitOpId` at Complete_Capture time.
      In `src/db/captureRepo.ts`, in both `submitPeriod` and `confirmR0NoTithing`, set `submitOpId:
      crypto.randomUUID()` in the `db.periods.update(...)` alongside the existing Complete_Capture
      freeze fields, so each submitted revision gets a fresh stable id (a re-submission after rejection
      mints a new one). Do not change any existing field.
      Files: src/db/captureRepo.ts
      Verify: `npx vitest run src/db/captureRepo.banking.test.ts` passes; `npm run typecheck` = 0.

- [ ] 6. Reroute the sync-engine submit branch to the `cashbook_submit_period` RPC.
      In `src/utils/syncEngine.ts` `reconcilePeriod`, replace the `if (period.status === "Submitted")`
      direct `supabase.from("cashbook_period").update({ status:"Submitted", ... }).eq("id",
      serverId).select("id")` + `requireOneRow(...)` block with a call to
      `supabase.rpc("cashbook_submit_period", { ... })`. Build the args from the local period:
      `p_op_id` = `period.submitOpId` (if falsy, generate `crypto.randomUUID()`, persist it to the
      period via `db.periods.update`, and use it), `p_period_id` = `serverId`, `p_payload_fingerprint`
      = a stable string e.g. `` `${period.naturalKey}:${period.completeCaptureRevision ?? 1}` ``,
      the manifest fields from `buildSubmitManifestPayload(period.requiredManifest)` (import from
      `@/lib/completeCapture`), `p_submitted_at` = `period.submittedAt`, `p_requestor_comment` /
      `p_elder_approval_comment` from the period. Treat the result as acknowledged only when `error`
      is null AND `data?.status === "Submitted"`; otherwise `throw new Error(error?.message ?? "period
      submission not acknowledged")` (preserving the existing fail-closed, retryable semantics that the
      old zero-row/`requireOneRow` check gave). Keep the subsequent `flushActingAsAudit(...)` call and
      everything else in the branch unchanged.
      Files: src/utils/syncEngine.ts
      Verify: `npm run typecheck` = 0 (expect `syncEngine.retention.test.ts` to fail until step 7).

- [ ] 7. Update the sync-engine retention test mock for the submit RPC.
      In `src/utils/syncEngine.retention.test.ts`, make the mocked Supabase `rpc` distinguish by
      function name: `get_or_create_period` keeps returning `mock.rpc`; add a `mock.submitRpc`
      (default `{ data: { status: "Submitted", server_revision: 1, capture_generation: 1 }, error:
      null }`) returned for `cashbook_submit_period`. Reset `mock.submitRpc` in `beforeEach`. Change
      the two "not acknowledged" submit cases (currently `mock.periodUpdate = { data: [], error: null
      }`: "Area3: a zero-row period submission is not reported successful" and "a zero-value submission
      whose server period update affects 0 rows is NOT reported synced") to instead set `mock.submitRpc
      = { data: null, error: null }` (or `{ data: { status: "Draft" }, error: null }`), so the new
      "acknowledged only when `data.status === 'Submitted'`" check treats them as not acknowledged.
      Leave all locked-period cases (server status `Submitted`/`SubmittedToOverseer`) unchanged — they
      return before the submit branch. Do not weaken any assertion about `synced`/`failed`/`skipped`
      counts.
      Files: src/utils/syncEngine.retention.test.ts
      Verify: `npx vitest run src/utils/syncEngine.retention.test.ts` passes; then `npx vitest run`
      back to green with the SAME total count after accounting for the new step-4 tests (>= 199).

- [ ] 8. Extend the SQL behaviour test for the foundation.
      In `supabase/tests/two_person_signoff_rls.test.sql` (keep the NOT-RUN / disposable-stack banner),
      add foundation-focused cases: (a) `cashbook_submit_period(...)` on a `Draft`/`Rejected` period
      sets `Submitted`, bumps `server_revision`, writes a `cashbook_submission_manifest` row, and a
      `SUBMIT` audit row; (b) `cashbook_review_ready(period, rev)` is false when no manifest exists and
      false when `balanced=false` or a proof-required line lacks an attachment, true when balanced +
      fully evidenced; (c) a direct `update cashbook_period set status='Submitted'` is rejected by
      `trg_guard_submitted` (SQLSTATE 42501). Adjust the existing CASE fixtures so the submitted,
      Review_Ready revision is produced via `cashbook_submit_period` (not a raw insert of
      `server_revision=1`), so the manifest exists for the completing sign-off in CASE 4.
      Files: supabase/tests/two_person_signoff_rls.test.sql
      Verify: not runnable here (needs Docker). Static review: every referenced object exists in the
      step-1 migration; SQL parses visually. Note in the step output that execution is deferred to a
      disposable stack.

- [ ] 9. Final gate + incremental commits.
      Run the full gate and commit the work in logical chunks (migration; schema+helper+repo; syncEngine
      + test; SQL test; design/plan docs). Do not push.
      Files: (none new)
      Verify: `npm run typecheck` = 0; `npx vitest run` green (report the count; must be >= 199 with the
      new step-4 cases); `npm run lint` not worse than the pre-existing baseline (capture the baseline
      count first with `npm run lint` on a clean tree if unknown).

---

## Digest

Build/test commands (from `package.json`): typecheck `tsc --noEmit` (`npm run typecheck`); tests
`vitest run` (`npm run test` / `npx vitest run`); lint `eslint . --ext .ts,.tsx` (`npm run lint`).
Verified now on a clean tree: `npx vitest run` → **26 files, 199 passed**; this is the baseline to
hold. SQL migrations/tests are NOT executed here (no Docker; orchestrator applies SQL later).

### supabase/migrations/20261105110000_signoff_foundation.sql — NEW (step 1)
Additive foundation. Creates `cashbook_period.server_revision integer not null default 0` +
`capture_generation integer not null default 1`; base `cashbook_review_decision` (+ index
`cashbook_review_decision_one_accepted`, constraint `cashbook_review_decision_decision_check`);
`cashbook_op_ledger(op_id uuid pk, result jsonb, created_at)`; `cashbook_submission_manifest`
(unique `(period_id, capture_generation, revision)`); `cashbook_review_ready(uuid,int) returns
boolean`; `cashbook_submit_period(...)` (signature in foundation-design.md §4.2);
`cashbook_guard_submitted()` + `trg_guard_submitted`; RLS + grants per §2.7. Test: SQL suite
`supabase/tests/two_person_signoff_rls.test.sql` (deferred to a disposable stack).

### supabase/migrations/20261105120000_two_person_signoff.sql — READ-ONLY verify (step 2)
Authored sign-off extender. Expected NO edit. Referenced objects all created by the foundation;
`audit_log.assumed_role` already exists (written by `logSelfReviewException` in
`src/lib/permissions.ts`). Only edit if a real mismatch surfaces on a stack — and then fix the
foundation, not this file.

### src/db/schema.ts — EDIT (step 3)
`LocalPeriod` interface (the Complete_Capture freeze block near `requiredManifest?`): add
`submitOpId?: string | null;`. Additive optional field; no `this.version()` change. No direct unit
test; covered indirectly by `src/utils/syncEngine.retention.test.ts` and
`src/db/captureRepo.banking.test.ts`.

### src/lib/completeCapture.ts — EDIT (step 4)
Add `SubmitManifestPayload` interface and `buildSubmitManifestPayload(manifest)` after
`outstandingProofs(...)`. Pure; reuses existing `outstandingProofs`. Test:
`src/lib/completeCapture.test.ts` (11 existing cases pass today; add a `buildSubmitManifestPayload`
block).

### src/lib/completeCapture.test.ts — EDIT (step 4)
Add `describe("buildSubmitManifestPayload", ...)`: null manifest → fail-closed `{false,0,[]}`;
balanced + zero outstanding; manifest with `declared-outstanding` → non-zero count.
Verify: `npx vitest run src/lib/completeCapture.test.ts`.

### src/db/captureRepo.ts — EDIT (step 5)
`submitPeriod` (the `db.periods.update(periodLocalId, { status:"Submitted", ... })` freeze block,
~line 167) and `confirmR0NoTithing` (the `db.periods.update(period.localId, { status:"Submitted",
... })` block, ~line 214): add `submitOpId: crypto.randomUUID()`. Test:
`src/db/captureRepo.banking.test.ts` (11 cases).

### src/utils/syncEngine.ts — EDIT (step 6)
`reconcilePeriod`, the `if (period.status === "Submitted")` block (~line 403): replace the direct
`supabase.from("cashbook_period").update({...}).eq("id", serverId).select("id")` + `requireOneRow`
with `supabase.rpc("cashbook_submit_period", {...})`; acknowledged iff `!error && data?.status ===
"Submitted"`, else `throw`. Args from `period` + `buildSubmitManifestPayload(period.requiredManifest)`
(add import from `@/lib/completeCapture`); stable `p_op_id` = `period.submitOpId` (generate+persist if
absent). Keep the following `flushActingAsAudit(...)` call. Tests:
`src/utils/syncEngine.retention.test.ts` (25), `src/utils/syncEngine.idempotency.test.ts` (1),
`src/utils/syncEngine.versionBinding.test.ts` (3). Idempotency + versionBinding do NOT hit this branch
(server status `Submitted`/`Draft`-with-local-`Draft` respectively) and need no change; retention does
(step 7).

### src/utils/syncEngine.retention.test.ts — EDIT (step 7)
Mocked Supabase (top `vi.mock`/`vi.hoisted` block): make `rpc` switch on the function name, add
`mock.submitRpc` (default acknowledged `Submitted`), reset it in `beforeEach`. Change the two
"not acknowledged" submit cases from `mock.periodUpdate = { data: [], error: null }` to
`mock.submitRpc = { data: null, error: null }`. Leave locked-period cases untouched.
Verify: `npx vitest run src/utils/syncEngine.retention.test.ts` then full `npx vitest run`.

### supabase/tests/two_person_signoff_rls.test.sql — EDIT (step 8)
Keep the NOT-RUN banner. Add foundation cases (submit RPC populates manifest + bumps revision + SUBMIT
audit; `cashbook_review_ready` false-without-manifest / false-unbalanced-or-evidence-short / true;
direct `Submitted` update blocked by `trg_guard_submitted`); route the Review_Ready fixture through
`cashbook_submit_period` so CASE 4's completing sign-off has a manifest. Execution deferred to a
disposable Docker stack.

### .kiro/specs/cashbook-reliability-hardening/foundation-design.md — NEW (already written)
The design authority (foundation objects, submit/manifest decision, exact server contract). No test.

### What I verified before planning
- `npx vitest run` → 26 files / 199 passed (baseline).
- The client sign-off call in `src/audit/AuditReviewPage.tsx` already matches the authored
  `cashbook_review_decision` signature; the page reads `server_revision`/`capture_generation`
  defensively (`?? 0` / `?? 1`).
- The submit path today is a direct `UPDATE cashbook_period SET status='Submitted'` in
  `src/utils/syncEngine.ts` `reconcilePeriod` — no manifest write, no revision bump (the root cause of
  an unreachable `cashbook_review_ready`).
- That direct-update branch is reached only when the server period is still editable; several
  `syncEngine.retention.test.ts` cases exercise it (hence step 7), while the idempotency and
  versionBinding tests do not.
- `OpKind` in `src/lib/opLedger.ts` already anticipates `"SUBMIT"`/`"AUDIT_DECISION"`; the op ledger
  table PK is a `uuid`, so the stable submit id is carried on `LocalPeriod.submitOpId` (step 3/5).
