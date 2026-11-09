# Cashbook Reliability Hardening — FINAL REPORT (this pass)

> Branch: `feat/treasurer-dashboard-v1`. Spec: `.kiro/specs/cashbook-reliability-hardening/`.
> Scope of this pass: implement the gaps found in `gap-analysis.md` across four priorities,
> prepare the Tranche 4 proof-access migration for review, and keep every server-side change
> authored-but-unapplied. Backend `cwdyixafvylzgtpsfmwr` was not touched; nothing was deployed
> or pushed. This document is the pass's closing record; it changes no application code.
>
> **Nothing here claims the pilot or the load milestone has been proven** — see the explicit
> statement at the end.

---

## 0. Baseline this pass built on

- Pre-pass branch state (commit `0d1bf88d`, "Treasurer/Auditor hardening + interim-officer
  migration") was the baseline the read-only `gap-analysis.md` measured:
  `typecheck` = 0, `vitest run` = **~104 passed / 14 files**, `lint` = exit 1 with a known
  **1 error + ~6 warnings** (7 findings) that pre-date this work.
- Docker / local Supabase was unavailable throughout, so every server-side SQL / RLS / Storage
  claim is reasoned about and authored only — never executed. This is the stated gate for
  Tranche 4 and for the two-person sign-off server rules.

---

## 1. WHAT CHANGED — files + commits, by priority

All commits below are new on `feat/treasurer-dashboard-v1` in this pass
(`git log 0d1bf88d..c6a5fcca`), oldest first. None has been pushed.

### Foundation (shared, enabling P1)
- `0e234836` docs(steering): add `environment-context` — pre-production dev/demo backend facts.
  - `.kiro/steering/environment-context.md`
- `93ed6ab9` refine(dashboard): compact, accessible sync labels + info legend; added a
  congregation-isolation test for `syncPending`.
  - `src/components/TreasurerDashboard.tsx`, `src/utils/syncEngine.retention.test.ts`
- `45d3f62e` fix(sync): scope submit/R0 auto-sync to the period's congregation (stops a submit
  in one congregation pushing another's pending work under the current session).
  - `src/components/CashbookForm.tsx`, `src/components/TreasurerDashboard.tsx`

### Priority 1 — progressive transfer + Complete Capture / Submit for Audit
- `500f0aff` feat: actor-isolated + idempotent progressive transfer.
  - `src/utils/syncActor.ts` (+test) — fail-closed per-user/per-congregation queue filter +
    replay authorization; `syncPending` gains an `actorUserId` scope so a build never drains
    another saved user's queue under the wrong JWT (shared-device user switch).
  - `src/lib/opLedger.ts` (+test) — deterministic per-operation dedupe key + replay guard;
    `flushActingAsAudit` pre-checks the natural key so a lost-ack retry cannot duplicate
    `ACTING_AS_TREASURER`.
  - `src/utils/syncController.ts` / `src/utils/syncBootstrap.ts` (+test) — connectivity/
    visibility-reactive dispatch, **kept inert** (`PROGRESSIVE_DISPATCH_ENABLED = false`);
    bootstrapped in `src/App.tsx`.
  - `src/utils/syncEngine.ts`, `src/utils/syncEngine.idempotency.test.ts`,
    `src/utils/syncEngine.retention.test.ts`.
- `d438f401` feat: Complete_Capture freeze + manifest, sign-off, Review_Ready gate.
  - `src/lib/completeCapture.ts` (+test) — freezes the proof LIST belonging to a revision
    (declared-present / declared-outstanding / exempt); `resolveSignOff` routes eligibility
    through the permission matrix (Treasurer default; anyone else = recorded exception);
    `computeReviewReadiness` mirrors the server condition (evidence present + balanced).
  - `src/db/schema.ts` — additive, non-indexed `LocalPeriod` fields (no Dexie version bump;
    v4 rows stay valid).
  - `src/db/captureRepo.ts` — `submitPeriod`/`confirmR0NoTithing` freeze revision + manifest +
    sign-off; re-submission freezes a fresh revision.
  - `src/components/CashbookForm.tsx`, `src/components/TreasurerDashboard.tsx` — sign-off
    resolution + exception-reason input; removed the hardcoded `role === "Chairperson"` check.
  - `src/audit/AuditReviewPage.tsx` — approval opens only when Review_Ready (evidence + balance
    for the exact revision); rejection stays available; readiness banner.

### Priority 2 — two-person audit sign-off + Elder referral
- `fa5b9e88` feat(audit): sign-off eligibility/involvement pure logic.
  - `src/audit/signoff.ts` (+ `src/audit/signoff.test.ts`, 25 cases) — matrix-routed
    eligibility (Auditor primary `A`; Chairperson acting `O` via new `audit.acting_signoff`;
    Elder excluded), involvement-based independence, fresh-revision binding, completing-
    transition coupling, `pendingNeedsSecond` predicate.
  - `src/lib/permissions.ts`, `src/lib/types.ts` — new matrix key + `isActingAuditor` helper +
    extended decision-ledger types.
- `5aaccdbd` feat(db): sign-off RPC + bypass trigger + SQL suite — **AUTHORED, NOT APPLIED**.
  - `supabase/migrations/20261105120000_two_person_signoff.sql` — extends
    `cashbook_review_decision` into a sign-off ledger (slot/perm_code/acting flags), swaps the
    single-accepted index for one-per-signer + one-completer guards, adds a `BEFORE UPDATE`
    trigger blocking any direct transition into `AuditApproved` unless set by the RPC, and the
    extended RPC enforcing authority, involvement, acting-slot rules, fresh-revision binding,
    and the atomic completing transition.
  - `supabase/tests/two_person_signoff_rls.test.sql` — behaviour suite expressing the
    acceptance test. `DEPENDS-ON-UNVERIFIED`; not run (no Docker).
- `f0f2978f` feat(ui): two-person sign-off flow + Elder referral surface.
  - `src/audit/AuditReviewPage.tsx` — approval routes through `rpc('cashbook_review_decision')`,
    never a direct `AuditApproved` write; renders "Sign-off N of 2" and "Second sign-off:
    Chairperson (acting auditor)"; mandatory acting-reason field; fail-closed (no auto-approve
    fallback). Reject keeps the direct Submitted→Rejected path.
  - `src/audit/AuditDashboard.tsx` — splits the pending queue into awaiting-first vs
    needs-independent-second.
  - `src/elder/ElderDashboard.tsx` — referral card listing captures pending a second sign-off
    with why-pending detail and an Overseer-escalation toggle that changes **no** business
    state (captures left pending; no one-signature closure).

### Priority 3 — public landing page + role guides
- `97e73f96` feat: role-guide content map + dismissal prefs (pure logic).
  - `src/lib/roleGuide.ts` (+test), `src/lib/roleGuidePrefs.ts` (+test) — per-role
    "What you can do here" content for all 8 roles; non-compulsory auto-show decision with
    session dismiss + persisted "don't show again".
- `91d0e9c1` feat: public landing page + dismissible role guide via Help.
  - `src/features/landing/LandingPage.tsx`, `src/App.tsx` — public `/` (what Cashbook does,
    capture→submit→audit, roles explicit incl. Treasurer-default / Chairperson-exception /
    no self-sign-off, sign-in top-right, mobile-first, shadcn/ui).
  - `src/components/RoleGuideHost.tsx`, `src/components/RoleGuideCard.tsx`,
    `src/components/AppHeader.tsx` — non-modal card, always re-openable from header Help; role
    resolved via `routeGuard`/`permissions`. DHO announcements were deliberately **not** built.

### Priority 4 — Tranche 4 proof-access prep (REVIEW ONLY, NOT APPLIED)
- `2ae1f6f9` test(tranche4): encode the cross-bucket write predicate as pure logic.
  - `src/lib/storage/crossBucketPredicate.ts` (+test, 8 cases) — models the underscore-bucket
    write policy in its leaky (before) and fixed (after) forms and proves the fixed policy
    cannot authorize a write to any bucket other than its own.
- `c6a5fcca` docs(tranche4): migration diff + access checks (review, not applied).
  - `.kiro/specs/cashbook-reliability-hardening/tranche4-migration-diff.sql` — exact
    BEFORE→AFTER diff of the `storage.objects` proof policies.
  - `.kiro/specs/cashbook-reliability-hardening/tranche4-access-checks.md` — authenticated
    BEFORE/AFTER access matrix (A–E), pre-apply gate, safe fallback.

Independent review (all APPROVED, zero findings) is recorded under `.agents/tasks/hardening/`:
`review-transfer.md`, `review-signoff.md`, `review-landing.md`, `review-tranche4.md`.

---

## 2. WHAT PASSED LOCALLY

Re-run once at the close of this pass (HEAD `c6a5fcca`):

| Check | Command | Result | vs baseline |
|---|---|---|---|
| Typecheck | `npm run typecheck` (`tsc --noEmit`) | **exit 0, clean** | unchanged (was 0) |
| Unit tests | `npx vitest run` | **182 passed / 182, 0 failed, 23 files** | up from ~104 / 14 (+~78 tests, +9 files); no regressions |
| Lint | `npm run lint` | **exit 1 — 7 problems (1 error, 6 warnings)** | identical to the known 1-error + ~6-warning baseline; none introduced |

The single lint error is pre-existing (`src/db/captureRepo.ts:554` `_params` unused); the six
warnings are the pre-existing `react-hooks/exhaustive-deps` / `react-refresh` findings
(`AuditReviewPage`, `button.tsx`, and the four `ho/*Screen` `loadData` effects). Per steering,
pre-existing findings were not auto-fixed.

New test coverage added this pass (all green): `syncActor`, `opLedger`, `syncController`,
`syncEngine.idempotency`, `syncEngine.retention` (expanded), `completeCapture`, `signoff`
(25 cases), `roleGuide`, `roleGuidePrefs`, `crossBucketPredicate`.

---

## 3. WHAT STILL NEEDS AUTHENTICATED / HOSTED TESTING

Everything below is authored and reasoned about only. No Docker/local stack and no hosted apply
were available, so none of it was executed. It must pass effective-RLS + integrity tests on a
disposable stack before any apply — even to the dev/demo backend.

### P1 progressive transfer / Complete Capture
- Server RLS actually refusing a second user's metadata upserts / proof writes under the wrong
  JWT (actor isolation at the server, not just the client filter).
- The durable duplicate guarantee: the authored `audit_log (entity_id, action_type, user_id)`
  unique key is **not applied**; today's protection is app-layer only. Prove no duplicate on a
  real lost ack over the network.
- Authoritative exact-revision Review_Ready computed server-side from
  `cashbook_submission_manifest` (schema-gated, not applied) — the client gate is an advisory
  mirror over current server rows, not the frozen manifest's exact revision.
- Interrupted/resumed real-network upload + reconnect re-validation before
  `PROGRESSIVE_DISPATCH_ENABLED` is ever flipped on.

### P2 two-person sign-off (server rules) — including the acceptance test
- **Bypass closure (the acceptance test):** neither the pre-existing approval path nor a direct
  Data-API `update status='AuditApproved'` can bypass readiness or the second sign-off — the
  `trg_guard_audit_approved` trigger must reject the direct update under a real JWT while the
  RPC still succeeds.
- **Succeed-or-fail-together:** the second valid sign-off and the `AuditApproved` transition
  commit atomically in one RPC transaction; forcing the audit/transition write to fail must
  roll the second sign-off back too.
- **No self-approval / no same person twice / involvement-not-just-role:** the submitter and any
  `CAPTURE`/`SUBMIT`/`ACTING_AS_TREASURER`/`SELF_REVIEW_EXCEPTION` participant rejected
  (`signer_involved`); `cashbook_signoff_one_per_signer` blocks a repeat signer.
- **Chairperson acting-as-Treasurer role switch blocked** (the `ACTING_AS_TREASURER` row puts
  them in the involvement set); acting slot is Chairperson-only, reason-mandatory, second-slot
  only; a valid pair requires at least one real Auditor (`A`).
- **Fresh-revision binding:** sign-offs for a superseded `server_revision`/`capture_generation`
  do not count after re-submission or HO reopen; history rows preserved.
- RLS/scope + op-ledger idempotency of the extended RPC under real auth; involvement-data
  completeness once per-revision preparer/editor/submitter attribution is recorded server-side.

### P4 Tranche 4 before/after access checks
- The whole BEFORE/AFTER matrix (Sections A–E of `tranche4-access-checks.md`) is marked
  **NEEDS AUTHENTICATED/HOSTED TESTING**, including:
  - Legacy cross-bucket write check (A1–A4): the underscore-bucket rewrite
    `bucket AND (A OR B)` cannot authorize a write to any other bucket. The predicate shape is
    proven as pure boolean logic locally (`crossBucketPredicate.test.ts`); effective RLS is not.
  - Broad-read closure (B1–B7): dropping `l4t6gw_2`; Secretary excluded on every branch;
    cross-congregation denied; no generic District bypass (HO needs an `ho_district_assignments`
    row); malformed keys denied.
  - INSERT / DELETE / attachment-row checks (C, D, E): uploader-bound, exact-editable-period,
    capture-role, reference-count delete guard, restrictive locked-period locks, dedupe index.
- Pre-apply gate (Section F): `supabase db pull` drift check, the effective-RLS suite
  `supabase/tests/tranche4_proof_rls.test.sql`, and real Storage-API byte upload/retrieve/verify
  — all **UNEXECUTED** here.

---

## 4. WHAT REMAINS FOR THE 20–40 CAPTURE-USER PILOT

- **Stand up a disposable stack** (Docker `supabase start` or an explicitly disposable throwaway
  project) and run the two authored SQL suites (`two_person_signoff_rls.test.sql`,
  `tranche4_proof_rls.test.sql`) plus real Storage byte-level checks. These passing are the gate.
- **Apply the two authored migrations** (two-person sign-off; Tranche 4 proof-access) only after
  the gate passes, following the staged Tranche 4 deployment order and keeping the bucket private.
- **Schema-gated server pieces not yet applied:** `cashbook_submission_manifest` /
  authoritative Review_Ready, `cashbook_op_ledger` durable idempotency, the `audit_log` dedupe
  unique key. Until applied, exact-revision readiness and durable de-dup are client-advisory only.
- **Progressive auto-dispatch stays OFF** (`PROGRESSIVE_DISPATCH_ENABLED = false`) until server
  actor isolation is verified under real JWTs; enabling it is gated on that.
- **A full end-to-end functional retest** on real devices/network (interrupted upload, lost-ack
  retry, shared-device user switch, two-sign-off close, Elder referral) — this pass proved pure
  logic and local build only.
- **Provisioning the pilot accounts** — see §5; this is a hard pilot dependency.

---

## 5. USER-ACCESS-PROVISIONING — PILOT DEPENDENCY STATUS

Kept as a **separate work item**, not folded into the hardening loops, and **not built** in this
pass.

- **Agreed flow:** Elder raises a user-access request (details, congregation, role, motivation)
  → Overseer approves → DHO creates/authorises an account limited to the approved scope.
- **DHO administers access and does NOT appoint CMC.** An approved access request is **NOT** an
  audit sign-off. A newly authorised auditor may review a pending capture once active, only if
  independent of its preparation.
- **Current state on-branch:** there is an interim-**officer** request flow
  (`officers_interim_request_insert`; `20261102210349_officers_interim_fields.sql`) — a different
  thing — and the HO-only privileged write path `supabase/functions/admin-write/index.ts`. There
  is **no account-provisioning request workflow** matching Elder → Overseer → DHO.
- **FLAGGED AS A PILOT DEPENDENCY:** if there is no authorised way to provision the 20–40 pilot
  accounts today, this blocks the pilot and must be tracked and resolved separately. It must not
  swallow the hardening pass (and did not).

**Officers Fund** is a **separate workstream** and was **NOT built** this pass. It may reuse the
hardened transfer path but needs its own OF-Treasurer / Overseership scope. Recorded and deferred.

---

## 6. TRANCHE 4 REVIEW ARTIFACTS — EXPLICITLY UNAPPLIED

- `tranche4-migration-diff.sql` — exact BEFORE→AFTER diff of the `storage.objects` proof
  policies (drops the four unscoped `Authenticated_CRUD l4t6gw_0..3` incl. the `l4t6gw_2` broad
  SELECT; adds per-congregation scoped SELECT/INSERT/DELETE with **no** UPDATE policy = overwrite
  denied; rewrites the three underscore-bucket write policies to `bucket AND (A OR B)` to close
  the legacy cross-bucket write leak). Wrapped `BEGIN … ROLLBACK`; headed NOT APPLIED. The
  executable form is the authored `supabase/migrations/20261012010000_tranche4_proof_access.sql`.
- `tranche4-access-checks.md` — authenticated BEFORE/AFTER access matrix (A–E), the pre-apply
  gate (F), and the safe fallback (G: bucket stays private, fail closed, never reopen, prefer app
  rollback, handle stale PWA signed URLs, Dexie queue untouched).
- **Status:** the migration, the SQL suite, and every access check are **UNAPPLIED and
  UNEXECUTED**. Nothing was applied to `cwdyixafvylzgtpsfmwr` or any backend; no hosted project
  was created; nothing was deployed or pushed. The one noted documentation nit (a headline
  "7 → 7" policy-count line that should read 7 → 6) is cosmetic and does not affect the DROP/CREATE
  statements.

---

## 7. EXPLICIT NON-CLAIM

Neither the **20–40-user pilot** nor the **4,000–6,000-user load milestone** is claimed proven.
This pass delivered client-side logic with local unit tests (182 passing), authored-but-unapplied
server migrations and SQL suites, and review-only Tranche 4 artifacts. All server-side RLS/RPC/
Storage behaviour — including the two-person sign-off acceptance test and the Tranche 4 access
checks — remains to be verified on a disposable stack under real authentication. The load
milestone is a separate, unproven target and was not exercised at all.
