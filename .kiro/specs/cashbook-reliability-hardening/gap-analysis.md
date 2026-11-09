# Cashbook Reliability Hardening — Gap Analysis & Ordered Plan

> READ-ONLY investigation of branch `feat/treasurer-dashboard-v1`, verified against the
> existing spec (`requirements.md` R1–R38, `design.md` §1–§17 + Properties, `tasks.md`
> Tasks 1–10), the Tranche 4 evidence records, and the pre-cutover backend capture at
> `C:\Users\User\OneDrive - Morriscom Solutions\OAC\backups\tranche4-precutover-20261104\`.
> This file does NOT rewrite the spec; it records what is already on-branch, the concrete
> gaps, the grep-confirmed files to touch, and what can only be proven with
> authenticated/hosted testing. It does NOT resolve the spec's open OBD-/D-/SD- decisions.

## Verified baseline (this session, local only)
- `npm run typecheck` → exit 0 (clean).
- `npm test` (vitest run) → **104 passed / 14 files** (grown from the tranche4c record of 71/10).
- `npm run lint` → exit 1, ~7 pre-existing findings (captureRepo `_params`, AuditReviewPage,
  button.tsx, ho/*Screen loadData) — none introduced here; do not auto-fix (steering).
- **Docker / local Supabase stack UNAVAILABLE** → every server-side SQL / RLS / Storage-byte
  claim below is *reasoned about only*, never executed. This is the gate for Tranche 4.
- Pre-existing uncommitted state left untouched: `src/audit/ProofLink.tsx` (EOL-only),
  untracked `.agents/`, `.kiro/specs/cashbook-reliability-hardening/`, a stray zip.

## Pre-production guardrails (carried, not re-decided)
Pilot = 20–40 capture users; 4,000–6,000 is a separate, UNPROVEN load milestone — neither is
claimed proven here. Backend `cwdyixafvylzgtpsfmwr` is the dev/demo project (labelled
"PRODUCTION" but NOT launched; first demo Nov 2026). No schema/policy/bucket change is applied
to it and nothing is deployed in this pass. A full functional retest follows hardening.

---

## PRIORITY 1 — Progressive transfer + "Complete Capture and Submit for Audit"

### (a) What already exists on-branch vs spec
- **Local-first capture**: `src/db/captureRepo.ts` writes all capture to Dexie
  (`src/db/schema.ts`, DB `oac_cashbook_local` v4) with zero network latency; the UI never
  blocks on the network.
- **Single reconciliation path**: `src/utils/syncEngine.ts` `syncPending()` processes
  `pending`/`failed` periods oldest-first with exponential backoff (`backoffDelayMs`,
  `isDueForRetry`), conflict detection (`isServerDownstream`, fail-closed for unknown/later
  statuses), and **retains proof Blobs on any failure** (period stays retryable). Manual
  "Sync now" (TreasurerDashboard) and the post-submit `void syncPending(...)` in
  `CashbookForm.tsx` both call the **same** `syncPending` — there is no second path.
- **Stable per-proof identity + idempotent proof replay (Tranche 4 r2)**: `proofObjectKey`/
  `depositObjectKey` + `proofHash`/`proofSize` are assigned at capture (`captureRepo.attachProof`,
  `markCashBanked`) and reused across retries; `uploadProofStable` verifies byte-identity on
  "already exists" and the atomic compare-and-clear clears **only the exact delivered version**,
  so a retry never duplicates a proof object and a newer replacement keeps the period pending.
- **Submitted locks local edit**: `isPeriodEditable` = Draft/Rejected only; `submitPeriod`
  flips to `Submitted`.
- **Post-submission proof finalisation is DEFAULT-DISABLED**: `SUBMITTED_PROOF_FINALISATION_ENABLED
  = false`; a locked parent with pending proof is held (`BLOCKED_SUBMITTED_PROOF_MSG`), not
  silently dropped.
- **Acting-as capture**: `LocalPeriod.actingAsRole` is captured and the mandatory
  `ACTING_AS_TREASURER` audit is flushed by the sync engine (`flushActingAsAudit`).

Spec alignment: this matches the Tranche-4 boundary (minimal stable proof identity, manual/
foreground sync, finalisation disabled). The spec's durable outbox, automatic/progressive
dispatch, and actor isolation are explicitly recorded as the FOLLOWING stage
(`next-stage-direction.md`; tasks 4.6 / 5.1 / 5.2 gated behind Task 8.1/8.2).

### (b) Concrete gaps
1. **Actor isolation is NOT implemented (BIGGEST P1 GAP).** `syncPending(now, congregationId)`
   filters the queue by `congregationId` only — never by `capturedByUserId` or the
   authenticated user. `CashbookForm.submit()` itself flags this in a code comment: on a shared
   device, a second user's pending work in the SAME congregation can be dispatched under the
   second user's JWT. There is no per-user queue filter and no authenticated-replay check before
   dispatch (spec Task 8.1). This MUST exist before any automatic/progressive dispatch is enabled.
2. **No automatic/progressive dispatch ("transfer as connectivity allows").** Transfer is
   manual/foreground-triggered only (a "Sync now" button + a fire-and-forget call after submit).
   There is no `SyncController` / scheduler reacting to `online`/`visibilitychange` (spec Task
   4.6, 5.1, 5.2). Building it is permitted; ENABLING auto-dispatch stays gated behind gap #1.
3. **No durable outbox / stable identity for METADATA operations.** Only proof *objects* have
   stable identity. Period/line replays re-upsert mutable rows, and `audit_log` has **no
   idempotency/dedupe key** — the engine documents that a lost ack after a committed
   `ACTING_AS_TREASURER` / submission insert can duplicate on retry. (Spec: `cashbook_op_ledger`,
   `cashbook_submission_manifest` — schema-gated by Task 2.)
4. **Complete_Capture does not freeze a Required_Manifest / proof list.** `submitPeriod` only
   sets `status=Submitted`, `submittedAt`, comments, `actingAsRole`. Nothing records the *proof
   list belonging to that revision*, so "proofs declared outstanding may finish after submission"
   cannot be distinguished from arbitrary later upload (this is exactly why finalisation is
   disabled). (Spec R15/R16; `cashbook_submission_manifest`, `cashbook_proof_version`.)
5. **"Submitted ≠ Ready for Audit" is NOT enforced.** `AuditReviewPage` opens the decision as
   soon as `period.status === "Submitted"` (`decisionOpen`/`activeReview`); there is no server
   `Review_Ready` gate that verifies evidence + balance for the exact revision before approval
   opens. The four-section checkboxes are client-only and not persisted. (Spec R15.4, Task 3.9.)
6. **Treasurer-default / Chairperson-exception sign-off is implicit and role-string-driven.**
   `TreasurerDashboard` derives `actingAsRole` with a hardcoded `role === "Chairperson"` check
   rather than through the permission matrix, and there is no explicit "Treasurer signs off by
   default; Chairperson only as a recorded exception (e.g. Treasurer ill)" control at
   Complete_Capture. (Steering invariant #1 — route through `permissions.ts`.)

### (c) Exact files to touch (grep-confirmed)
- `src/utils/syncEngine.ts` — per-user queue filter + authenticated-replay guard; dispatch
  gating constant; metadata idempotency key use.
- `src/db/captureRepo.ts` — Complete_Capture freeze + recorded proof list; route acting-as
  through the matrix.
- `src/db/schema.ts` — any additive manifest/outbox fields (additive, non-indexed; keep v4 rows valid).
- `src/components/CashbookForm.tsx` — submit → Complete_Capture wiring; scope sync to the actor.
- `src/components/TreasurerDashboard.tsx` — Treasurer-default vs Chairperson-exception sign-off UI;
  remove the `role === "Chairperson"` string check.
- `src/audit/AuditReviewPage.tsx` — gate the decision on server Review_Ready, not bare `Submitted`.
- New: a `SyncController` module under `src/utils/` (or `src/lib/`) for progressive dispatch (gated).
- Tests alongside: `src/utils/syncEngine.retention.test.ts`, `src/utils/syncEngine.versionBinding.test.ts`.

### (d) Only verifiable with authenticated/hosted testing
- That RLS actually refuses a second user's metadata upserts/proof writes under the wrong JWT
  (actor isolation at the server, not just the client filter).
- Interrupted/resumed upload behaviour over a real network; real duplicate behaviour on a lost
  ack after a committed insert (the documented `audit_log` dedupe dependency).
- Atomicity of a submission/Review_Ready mechanism (needs the server RPCs, Task 2/3).

---

## PRIORITY 2 — Two-person sign-off + Elder referral  (BIGGEST NET-NEW WORK)

### (a) What already exists on-branch vs spec
- **Single-decision audit only.** `AuditReviewPage.decide()` performs a client-side optimistic
  row-lock: `supabase.from("cashbook_period").update({status:'AuditApproved'|'Rejected'})
  .eq("id").eq("status","Submitted")` + `logAuditAction(AUDIT_APPROVE|AUDIT_REJECT)`, with a
  four-section checkbox gate and a Realtime watch for external changes. **One** approval →
  `AuditApproved`. There is no RPC (`syncEngine` is the only `.rpc()` caller, and only for
  `get_or_create_period`).
- **Permissions**: `audit.approve`/`audit.reject` = Auditor `A`; Elder/Chairperson `O` (override,
  logs `SELF_REVIEW_EXCEPTION`). No self-approval, same-person-twice, or involvement check exists.
- **Spec proposes a SINGLE decision authority**: `cashbook_review_decision` RPC with an
  at-most-one-ACCEPTED-per-revision partial unique index (Task 3.6, design §6.3) and
  concurrent-audit tests (Task 6.10). This is one decision per revision — it is **not** two
  independent sign-offs, and the prompt's Priority 2 explicitly extends beyond it.

### (b) Concrete gaps
1. **No two-sign-off model at all (BIGGEST GAP).** The entire flow treats one approval as
   closure. Needed (NEW, extending the `cashbook_review_decision` approach rather than replacing
   it): a sign-off record collecting **two** eligible-auditor signatures against the **same
   submitted revision**, with the transition to `AuditApproved` occurring **only** when the
   second valid sign-off lands — "second sign-off and the transition succeed or fail together."
2. **No server-enforced authority.** Because approval is a direct Data-API `UPDATE`, the
   two-person rule cannot be enforced client-side and a direct status update could bypass it
   entirely. Needs a server RPC enforcing: no self-approval; same person cannot sign twice;
   **involvement check (not just role)** — a signer who prepared/edited/submitted that capture is
   disqualified; a NEW revision requires FRESH sign-offs; full sign-off history preserved.
3. **No involvement data to check independence.** Independence currently has only weak signals:
   `cashbook_period.submitted_by`, and `audit_log` `ACTING_AS_TREASURER`/`SELF_REVIEW_EXCEPTION`.
   There is no per-revision record of who prepared/edited/submitted to drive the check, and no
   enforcement that a Chairperson who acted as Treasurer (role-switch) is disqualified.
4. **No Chairperson "second sign-off as acting auditor, with recorded reason" path**, and no UI
   label such as "Second sign-off: Chairperson (acting auditor)".
5. **No Elder referral gap path.** When two valid sign-offs cannot be obtained, nothing marks the
   capture as PENDING-needs-second-reviewer, surfaces it to the **Elder assigned to that
   congregation** (first point of contact, sees why pending, coordinates the missing reviewer),
   or escalates to the Overseer only if the Elder cannot resolve. `ElderDashboard` exists but has
   no referral concept. Elder oversight is explicitly NOT an audit signature. For the pilot,
   captures are to be LEFT PENDING when two valid sign-offs cannot be obtained — no one-signature
   closure.

### (c) Exact files to touch (grep-confirmed)
- `src/audit/AuditReviewPage.tsx` — replace the direct `.update(...).eq("status","Submitted")`
  with a call to the new sign-off RPC; render first/second sign-off state + "acting auditor".
- `src/audit/AuditDashboard.tsx` — show one-of-two vs two-of-two; pending-needs-second queue.
- `src/lib/permissions.ts` — matrix-route eligibility; no new role strings in components.
- `src/elder/ElderDashboard.tsx` — referral surface: why pending, coordinate the missing reviewer,
  escalate-to-Overseer only when unresolved.
- `src/lib/types.ts` — sign-off / involvement enums + the `audit_log` action additions.
- New migration under `supabase/migrations/` (**authored, NOT applied**): the sign-off table/RPC
  with the server-side checks; a new `supabase/tests/*.sql` effective-policy suite for it.
- Pure-logic tests under `src/audit/` or `src/lib/` for eligibility/involvement/fresh-revision.

### (d) Only verifiable with authenticated/hosted testing
- The user's **acceptance test**: that neither the existing approval path nor a direct Data-API
  status update can bypass readiness or the second sign-off, and that the second valid sign-off
  and the `AuditApproved` transition succeed-or-fail together for the same revision.
- All server-side enforcement (no self-approval, no twice, involvement, fresh-revision) — authored
  as RPC/RLS + an unexecuted SQL suite; **report every check that could not be verified locally.**

---

## PRIORITY 3 — Public landing page + dismissible role guides

### (a) What already exists on-branch vs spec
- **Nothing.** `src/App.tsx` routes `/` → `/login` (Navigate) and `*` → `/login`; the only
  unauthenticated route is `src/features/auth/LoginPage.tsx`. No public landing, no role guide,
  no Help entry point. shadcn/ui primitives are available under `@/components/ui`. The spec
  (requirements/design/tasks) contains no landing-page or role-guide content.

### (b) Concrete gaps
1. **No public landing page (BIGGEST GAP — none exists).** Needed: an unauthenticated route
   explaining what Cashbook does and the capture→submit→audit flow, with roles stated explicitly
   (Treasurer default; Chairperson exception only; cannot sign own preparation), a **sign-in
   control top-right**, and mobile-friendly layout using `@/components/ui`.
2. **No per-role dismissible guide.** Needed: a "What you can do here" card per role shown after
   sign-in, dismissible for the session **and** a persisted "Don't show again", always reachable
   via a **Help** entry — not a compulsory pop-up.
3. **Keep in-app gaps/pending separate from DHO announcements.** Real gaps/pending captures stay
   inside the signed-in app; DHO notices are a small follow-on only — do NOT build the DHO
   notice system in this pass.

### (c) Exact files to touch (grep-confirmed)
- New `src/features/landing/LandingPage.tsx` (or `src/landing/`), wired as the `/` route in
  `src/App.tsx` (replace the `/` → `/login` redirect; keep fail-closed on protected areas).
- `src/App.tsx` — add the public route; add a Help route/entry into the authenticated shell.
- New role-guide component under `src/components/` + a small persistence helper (localStorage for
  "don't show again"; the role comes from `resolveAccess()`/`permissions.ts`, no role strings).
- `src/components/AppShell.tsx` / `src/settings/SettingsPage.tsx` — Help entry point.
- Reuse `@/components/ui/*` (card/button) to match existing patterns.

### (d) Only verifiable with authenticated/hosted testing
- Essentially none beyond local build/tests and responsive/manual checks; this priority is
  client-only and independent, and can run alongside P1/P2 without touching the backend.

---

## PRIORITY 4 — Tranche 4 prep (PREPARE FOR REVIEW — DO NOT APPLY)

### (a) What already exists on-branch vs spec
- **Migration fully authored (round-2), NOT APPLIED**:
  `supabase/migrations/20261012010000_tranche4_proof_access.sql`. It contains: cast-safe path
  parsers (`proof_ref_key`, `proof_path_period_id`, `proof_path_congregation`,
  `proof_path_uploader`) using MATERIALIZED validate-before-cast; `get_my_proof_congregations()`
  (Secretary excluded on ALL branches; HO/District requires BOTH an active HO District role AND
  a matching `ho_district_assignments` row — no generic District bypass); **drops the four
  unscoped hyphen policies `Authenticated_CRUD l4t6gw_0..3`**; scoped `proofs_select_scoped` /
  `proofs_insert_capture` / `proofs_delete_correction`; **no UPDATE policy (overwrite denied)**;
  attachment linkage policies + restrictive locked-period locks; R05 reference-count delete
  guard; R06 non-destructive duplicate pre-check + unique index.
- **Legacy cross-bucket leak fix present**: the three underscore-bucket policies are rewritten to
  `bucket_id = 'cashbook_proofs' AND (A OR B)`.
- **App read-side done**: `src/lib/storage/storagePort.ts` (signed-url read, never persisted),
  `src/lib/storage/proofReference.ts` (exact origin/route/bucket resolver), `src/audit/ProofLink.tsx`
  (mint-on-click, missing/denied/transient distinction). `syncEngine` stores durable object keys.
- **SQL effective-policy suite authored, UNEXECUTED**: `supabase/tests/tranche4_proof_rls.test.sql`.
- Evidence records: `tranche4-implementation.md`, `tranche4b-implementation.md`,
  `tranche4c-implementation.md`, `tranche4-proof-access-proposal-rev2.md`.

### (b) Concrete gaps (prep only)
1. **Confirmed legacy cross-bucket write defect in the LIVE baseline.** In
   `policy-definitions.sql` the underscore-bucket `insert/update/delete` policies are
   `((bucket_id='cashbook_proofs' AND folder∈my-congs) OR (EXISTS … scope_level<>'Congregation'))`
   — the second OR branch is **outside** the `bucket_id` check, so a non-Congregation-scope user
   satisfies the WITH CHECK/USING for a write targeting **any** bucket (including `cashbook-proofs`).
   The migration's rewrite to `bucket_id AND (A OR B)` closes this. **Deliverable**: a concise
   BEFORE/AFTER review packet proving the rewritten policies cannot authorize another bucket, and
   that dropping `l4t6gw_*` removes the broad `l4t6gw_2` SELECT (any authenticated read).
2. **Exact migration diff + authenticated before/after access checks + safe fallback.** The
   migration exists; the gap is a clean reviewable diff against the captured live baseline
   (`policy-definitions.sql` / `functions.sql`), the before/after access matrix (who can
   read/write which object, by role/scope, before vs after), and the documented rollback
   (bucket stays private; rollback disables the offending new policy fail-closed and/or rolls
   back the app build; never re-enables public read).
3. **Migration + SQL suite are UNEXECUTED (the GATE).** No Docker/local stack here, so neither
   the effective-RLS tests nor real Storage-byte upload/retrieve can run. Passing them on a
   disposable stack is the gate before applying even to the dev/demo backend.
4. **Portability note**: `proof_ref_key` hardcodes the project ref
   `cwdyixafvylzgtpsfmwr.supabase.co` in its URL prefixes — correct for this backend, flag for any
   other target.

### (c) Exact files to touch (grep-confirmed)
- `supabase/migrations/20261012010000_tranche4_proof_access.sql` (review/refine only — NOT applied).
- `supabase/tests/tranche4_proof_rls.test.sql` (the suite to run on a disposable stack).
- A new review packet doc under `.kiro/specs/cashbook-reliability-hardening/` (diff + before/after
  + fallback), sourced from `policy-definitions.sql` / `functions.sql` in the backup folder.
- App read-side already in place: `src/lib/storage/storagePort.ts`, `src/lib/storage/proofReference.ts`,
  `src/audit/ProofLink.tsx`, `src/utils/syncEngine.ts`.

### (d) Only verifiable with authenticated/hosted testing
- Everything server-side: effective-RLS behaviour, real Storage-API byte upload/retrieve/verify,
  and the before/after access checks. Reasoned about only; not proven until run on a disposable
  stack (Docker) or an explicitly disposable test project. **Do NOT apply to `cwdyixafvylzgtpsfmwr`.**

---

## SEPARATE WORK ITEMS — FLAGGED, do NOT fold into the hardening loops

### User access provisioning (Elder → Overseer → DHO)
- Flow: Elder raises a user-access request (details, congregation, role, motivation) → Overseer
  approves → DHO creates/authorises an account limited to the approved scope. DHO administers
  access and does **not** appoint CMC; an approved request is **NOT** an audit sign-off.
- Current state: there is an interim-**officer** request flow (`officers_interim_request_insert`
  policy; `supabase/migrations/20261102210349_officers_interim_fields.sql`) — this is a different
  thing. The privileged write path is `supabase/functions/admin-write/index.ts` (HO-only). There
  is **no account-provisioning request workflow** matching Elder→Overseer→DHO.
- **FLAG as a pilot dependency**: if there is no authorised way to provision the 20–40 pilot
  accounts today, this blocks the pilot and must be tracked separately — it must not swallow the
  hardening pass.

### Officers Fund
- Separate workstream. **Do NOT build.** It can reuse the hardened transfer path but needs its own
  OF-Treasurer / Overseership scope. Record and defer.

---

## Ordered implementation plan (consumed by the four staged hardening loops)

Dependency order within and across priorities. Each item leaves the tree buildable; verify with
`npm run typecheck` && `npm test` (and `npm run lint` — expect the same ~7 pre-existing findings,
none new). Server items are authored + unit/SQL-tested only; mark hosted checks as pending.

- [ ] 1. **P1 actor isolation (gate).** Add a `capturedByUserId`/authenticated-user filter to
      `syncPending` and an authenticated-replay guard so no build can drain another saved user's
      queue under the wrong JWT. Files: `src/utils/syncEngine.ts`, `src/components/CashbookForm.tsx`,
      `src/components/TreasurerDashboard.tsx`. Verify: new `syncEngine.retention.test.ts` cases pass.
- [ ] 2. **P1 Complete_Capture freeze + recorded proof list**, with `Submitted` kept distinct from
      Review_Ready. Files: `src/db/captureRepo.ts`, `src/db/schema.ts` (additive fields),
      `src/components/CashbookForm.tsx`, `src/components/TreasurerDashboard.tsx` (matrix-routed
      Treasurer-default / Chairperson-exception sign-off). Verify: unit tests + typecheck.
- [ ] 3. **P1 Review_Ready gate in audit UI** (decision opens only after server-verified evidence +
      balance for the exact revision). Files: `src/audit/AuditReviewPage.tsx`. Authored server
      verification is reasoned-about; flag hosted.
- [ ] 4. **P1 progressive dispatch controller (built, ENABLE gated behind item 1).** New
      `src/utils/syncController.ts`; bootstrap in `src/App.tsx`/`src/main.tsx`. Verify: pure-logic tests.
- [ ] 5. **P2 sign-off model + server RPC (authored, NOT applied).** Two eligible sign-offs on the
      same revision; no self-approval / no twice / involvement check / fresh-revision / preserved
      history; `AuditApproved` only on the second valid sign-off. Files: new
      `supabase/migrations/*.sql` + `supabase/tests/*.sql`, `src/lib/types.ts`. Verify: SQL suite
      authored (unexecuted), pure-logic eligibility tests pass.
- [ ] 6. **P2 audit UI → RPC + Chairperson acting-auditor label.** Files: `src/audit/AuditReviewPage.tsx`,
      `src/audit/AuditDashboard.tsx`, `src/lib/permissions.ts`. Verify: typecheck + tests.
- [ ] 7. **P2 Elder referral gap path** (pending-needs-second surface on the congregation's Elder;
      Overseer escalation only when unresolved; leave pending, no one-signature closure). Files:
      `src/elder/ElderDashboard.tsx`. Verify: tests + typecheck.
- [ ] 8. **P3 public landing page** at `/` (roles explicit, sign-in top-right, mobile, shadcn/ui).
      Files: new `src/features/landing/LandingPage.tsx`, `src/App.tsx`. Verify: build + manual responsive.
- [ ] 9. **P3 per-role dismissible guide + Help** (session dismiss + persisted "don't show again";
      always reachable via Help; not compulsory). Files: new guide component under `src/components/`,
      `src/components/AppShell.tsx`, `src/settings/SettingsPage.tsx`. Verify: tests + typecheck.
- [ ] 10. **P4 Tranche 4 review packet** (exact diff vs `policy-definitions.sql`/`functions.sql`;
      authenticated before/after access matrix; legacy cross-bucket write proof; safe fallback).
      Files: review doc under `.kiro/specs/cashbook-reliability-hardening/`; refine
      `supabase/migrations/20261012010000_tranche4_proof_access.sql` + `supabase/tests/tranche4_proof_rls.test.sql`.
      **Do NOT apply; do NOT deploy.** Verify: local typecheck/tests unaffected; SQL suite pending a disposable stack.

## Digest (files this plan touches)
- `src/utils/syncEngine.ts` — `syncPending(now, congregationId?)` filters by congregation only
  (no actor filter); proof identity/idempotency already solid. Tests:
  `syncEngine.retention.test.ts`, `syncEngine.versionBinding.test.ts`. Change: add actor filter +
  replay guard + metadata idempotency key.
- `src/db/captureRepo.ts` — `submitPeriod` sets `Submitted` with no manifest/proof-list freeze;
  `queueOverrideAudit` is a no-op placeholder. Change: Complete_Capture freeze + proof list;
  matrix-route acting-as.
- `src/db/schema.ts` — `LocalPeriod`/`LocalLineItem` additive-field pattern (keep v4 rows valid).
- `src/components/CashbookForm.tsx` — `submit()` → `submitPeriod` then `void syncPending(..., congregationId)`;
  `editable = isPeriodEditable`. Change: Complete_Capture + actor-scoped sync.
- `src/components/TreasurerDashboard.tsx` — `actingAsRole = role === "Chairperson" ? "Treasurer" : null`
  (role-string; route through matrix). New-week/R0 modal lives here.
- `src/audit/AuditReviewPage.tsx` — `decide()` = client `.update().eq("status","Submitted")` +
  `logAuditAction`; `decisionOpen` keyed on bare `Submitted`. Change: RPC + Review_Ready + two sign-offs.
- `src/audit/AuditDashboard.tsx` — queue; add one-of-two / pending-needs-second.
- `src/elder/ElderDashboard.tsx` — add referral surface.
- `src/lib/permissions.ts` — matrix (`audit.approve` Auditor A / Elder,Chair O); `getUserAccess`
  uses `limit(1).maybeSingle()` with **no order** (known non-deterministic primary — do NOT fix here).
- `src/lib/routeGuard.ts` / `src/App.tsx` — `/` → `/login`; add landing + Help; keep fail-closed guards.
- `src/services/authService.ts` — single in-memory `currentSession`; per-user `credentials`/
  `offlineUsers`; `signOut` clears session. Relevant to actor isolation.
- `supabase/migrations/20261012010000_tranche4_proof_access.sql` + `supabase/tests/tranche4_proof_rls.test.sql`
  — authored, NOT applied/executed (no Docker). New P2 sign-off migration + SQL suite to be added the same way.
- Build/test commands: `npm run typecheck` (0), `npm test` (104/14 pass today), `npm run lint`
  (exit 1, ~7 pre-existing). Backend untouched; nothing deployed.
