# Two-Person Sign-Off — Server Foundation (Design Note)

Status: design-first, NOT applied. Branch `feat/treasurer-dashboard-v1`, worked in place.
Companion deliverable: `foundation-plan.md` (ordered implementation plan).

No SQL is applied and nothing is deployed by this work. The orchestrator applies the
additive foundation migration via MCP afterward; the drop-containing sign-off migration
(`20261105120000`) is applied through the SQL editor. Local gates only:
`npm run typecheck`, `npm run lint`, `npx vitest run`.

---

## 1. Problem

The authored two-person sign-off migration (`supabase/migrations/20261105120000_two_person_signoff.sql`)
and the P1/P2 client both depend on schema objects that do not exist on the backend:

- tables `cashbook_review_decision`, `cashbook_op_ledger`, `cashbook_submission_manifest`
- functions `cashbook_review_ready(period_id, reviewed_revision)`, `cashbook_review_decision(...)`
- columns `cashbook_period.server_revision`, `cashbook_period.capture_generation`

`20261105120000` is an *extender*: it `ALTER`s `cashbook_review_decision`, `DROP`s the index
`cashbook_review_decision_one_accepted` and the constraint `cashbook_review_decision_decision_check`,
and its RPC reads `cashbook_op_ledger(op_id, result)`, `cashbook_period.server_revision` /
`capture_generation`, and calls `cashbook_review_ready(...)`. None of that exists, so the migration
cannot apply and the client RPC call 404s.

Separately, the completing (second) sign-off calls `cashbook_review_ready()`, which must read the
**submission manifest** for the exact reviewed revision. Today the submit path is a direct
`UPDATE cashbook_period SET status='Submitted'` inside `src/utils/syncEngine.ts`
(`reconcilePeriod`); nothing writes a manifest and nothing bumps `server_revision`. Therefore
`cashbook_review_ready()` could never be true and the second sign-off would always fail with
`not_review_ready`. The foundation must also supply the minimal correct submit/manifest path.

## 2. The foundation (all additive)

New migration `supabase/migrations/20261105110000_signoff_foundation.sql` (timestamp sorts BEFORE
`20261105120000`). It creates the base objects the sign-off migration extends, with the EXACT names,
columns, and types `20261105120000` references, so that migration applies on top with **no edits**.

### 2.1 `cashbook_period` revision columns (additive, defaulted)

```
server_revision    integer not null default 0
capture_generation integer not null default 1
```

Defaults are chosen so a period that never went through the submit RPC still has coherent values
(`rev=0`, `gen=1`). The client reads these with `?? 0` / `?? 1`; matching the defaults means client
and server agree without a mismatch that would be mis-read as `rejected_stale`. HO-reopen generation
bumps are out of scope (the sign-off migration leaves `reopen` unchanged), so `capture_generation`
stays `1` for the pilot.

### 2.2 `cashbook_review_decision` (base table the sign-off migration extends)

```
id                 uuid primary key default gen_random_uuid()
period_id          uuid not null references cashbook_period(id) on delete cascade
actor_user_id      uuid not null
capture_generation integer not null default 1
reviewed_revision  integer not null
decision           text not null
outcome            text not null
reason             text
created_at         timestamptz not null default now()
constraint cashbook_review_decision_decision_check check (decision in ('approve','reject','reopen'))
constraint cashbook_review_decision_outcome_check  check (outcome  in ('accepted','rejected_stale'))
```

Plus the base index the sign-off migration drops and replaces:

```
create unique index cashbook_review_decision_one_accepted
  on cashbook_review_decision (period_id, capture_generation, reviewed_revision)
  where (outcome = 'accepted');
```

The sign-off migration then adds `signoff_slot`, `signoff_perm_code`, `acting_as_auditor`,
`acting_reason`, `completes_approval`; drops `cashbook_review_decision_one_accepted` and
`cashbook_review_decision_decision_check`; re-adds the decision CHECK widened to include `'signoff'`;
and creates the per-signer / one-completer / one-reject partial indexes. The base `outcome` CHECK
admits both values the sign-off RPC inserts (`accepted`, `rejected_stale`).

### 2.3 `cashbook_op_ledger` (idempotency ledger)

```
op_id      uuid primary key
result     jsonb not null
created_at timestamptz not null default now()
```

Shared by both the submit RPC and the sign-off RPC for lost-ack replay: a replayed `op_id` with a
matching `payload_fingerprint` returns the recorded `result`; a mismatching fingerprint is a conflict.

### 2.4 `cashbook_submission_manifest` (the Review_Ready evidence anchor)

```
id                      uuid primary key default gen_random_uuid()
period_id               uuid not null references cashbook_period(id) on delete cascade
capture_generation      integer not null default 1
revision                integer not null
balanced                boolean not null
outstanding_proof_count integer not null default 0
proofs                  jsonb not null default '[]'::jsonb
frozen_by               uuid
frozen_at               timestamptz not null default now()
unique (period_id, capture_generation, revision)
```

One frozen row per submitted revision. `balanced` is the client-computed balance verdict
(`captureTotals.isBalanced`, the single source for the cash-banking reconciliation math) captured at
submit. `proofs` is the frozen Required_Manifest record. The manifest's *existence* for a revision is
the linchpin that proves the submit went through the RPC.

### 2.5 `cashbook_review_ready(p_period_id uuid, p_reviewed_revision int) returns boolean`

`SECURITY DEFINER`, `search_path=''`, `stable`. Returns true only when all hold:

1. the period exists and `server_revision = p_reviewed_revision` (fresh-revision binding);
2. a manifest row exists for `(period_id, period.capture_generation, p_reviewed_revision)`;
3. `manifest.balanced` is true;
4. every proof-required line item of the period (`item_type in
   ('EFT','DirectDebit','Burial','Expense','CashBanked')`) has at least one
   `cashbook_attachment`.

This is the server authority mirrored by the client's `completeCapture.computeReviewReadiness`.
Condition 2 is why nothing can be approved unless the submit RPC ran. Evidence (condition 4) is
checked against live attachments; under the applied Tranche-4 RLS, attachments can only be inserted
while a period is `Draft`/`Rejected`, so the live set equals the frozen set once `Submitted` — this
is not disturbed by the foundation.

### 2.6 `cashbook_submit_period(...)` RPC + the submit guard

See §4.2 for the exact signature. The RPC is the minimal correct submit/manifest path: it freezes the
manifest, bumps `server_revision`, records the submitter, and writes a `SUBMIT` audit row, all in one
transaction.

A BEFORE UPDATE trigger `trg_guard_submitted` on `cashbook_period` rejects any transition INTO
`Submitted` unless a transaction-local GUC `cashbook.submit_rpc` is set — exactly mirroring the
sign-off migration's `trg_guard_audit_approved` for `AuditApproved`. This makes submit consistent
with the approval bypass guard: `Submitted` can only be produced by `cashbook_submit_period`, which
guarantees a manifest and a bumped revision always accompany the status. The guard only ever fires on
`new.status = 'Submitted'`; `Rejected`, `SubmittedToOverseer`, `SubmittedToHO`, `HOReviewed`, and the
`Draft` creation path are untouched.

### 2.7 RLS on the new tables (scoped, fail-closed)

- `cashbook_review_decision`: RLS enabled. SELECT only, scoped to periods in
  `get_my_hierarchy_ids()`. No INSERT/UPDATE/DELETE policy, so direct writes are denied; the sign-off
  RPC writes as `SECURITY DEFINER` owner and bypasses RLS. `grant select` to `authenticated`
  (the client reads sign-off rows in `AuditReviewPage`, `ElderDashboard`, `AuditDashboard`).
- `cashbook_submission_manifest`: RLS enabled, scoped SELECT only; writes via the submit RPC definer.
  `grant select` to `authenticated`.
- `cashbook_op_ledger`: RLS enabled, NO policies (fully denied to `authenticated`); `revoke all` from
  `public, anon`. Only the definer RPCs read/write it.

All new functions: `revoke all ... from public, anon`; `grant execute ... to authenticated` for
`cashbook_submit_period` and `cashbook_review_ready`.

## 3. Submit / manifest decision and why `Submitted` ≠ `Review_Ready`

**Decision: a `cashbook_submit_period` RPC, with the client submit path rerouted through it.**

Rationale (chosen over a DB-trigger-only approach that recomputes balance in SQL):

- The balance verdict is non-trivial cash-banking reconciliation logic that already lives in exactly
  one place, `src/lib/captureTotals.isBalanced`. Re-implementing it in SQL would duplicate business
  logic and risk divergence, violating steering §"single source of truth". The RPC instead accepts
  the client-computed `balanced` and freezes it.
- A multi-table atomic effect (status + revision bump + manifest + audit row + idempotency) belongs
  in one server transaction, not spread across client Data-API calls.
- It lets the submit path be made consistent with the existing approval bypass guard (§2.6).

**`Submitted` is a business-state lock; `Review_Ready` is a separate, stronger condition.**
`cashbook_submit_period` sets `Submitted` and freezes the manifest even when proofs are still
`declared-outstanding` or the revision does not balance — submission is allowed to lock the period
regardless. `cashbook_review_ready()` is independent: it requires `manifest.balanced` AND every
proof-required line to have an attachment for that exact `server_revision`. The sign-off RPC gates the
*completing* sign-off on `cashbook_review_ready()` (and on a real Auditor being in the pair), so a
`Submitted` revision that is unbalanced or evidence-short is locked but NOT approvable. This preserves
the steering invariant "Submitted is NOT Review_Ready" at the server, matching the client mirror.

A re-submission after a rejection bumps `server_revision` again and writes a FRESH manifest row for
the new revision; sign-offs bound to a superseded revision no longer count (the sign-off RPC records
them `rejected_stale`). History rows are preserved.

## 4. Exact server contract (code ↔ DB)

### 4.1 Sign-off — `cashbook_review_decision` (unchanged; authored in `20261105120000`)

The client (`src/audit/AuditReviewPage.tsx`) already calls it with an argument list that matches the
migration exactly; the foundation changes nothing here. For reference:

```
cashbook_review_decision(
  p_decision_op_id      uuid,
  p_period_id           uuid,
  p_capture_generation  int,
  p_decision            text,     -- 'signoff' | 'reject'
  p_reviewed_revision   int,
  p_payload_fingerprint text,
  p_acting_as_auditor   boolean default false,
  p_acting_reason       text    default null,
  p_reason              text    default null,
  p_verification        jsonb   default null
) returns jsonb
```

Return shape: `{ "status": "Submitted"|"AuditApproved"|"Rejected", "signoffs": 1|2,
"payload_fingerprint": text }` (first sign-off → `Submitted`/`signoffs:1`; completing → `AuditApproved`/
`signoffs:2`; reject → `Rejected`).

### 4.2 Submit — `cashbook_submit_period` (NEW, in the foundation)

```
cashbook_submit_period(
  p_op_id                  uuid,
  p_period_id              uuid,
  p_payload_fingerprint    text,
  p_balanced               boolean,
  p_outstanding_proof_count int        default 0,
  p_manifest               jsonb       default '[]'::jsonb,
  p_submitted_at           timestamptz default null,
  p_requestor_comment      text        default null,
  p_elder_approval_comment text        default null
) returns jsonb
```

Fail-closed order: `auth.uid()` present → op-ledger replay (fingerprint match returns recorded
result; mismatch = `op_id_fingerprint_conflict`) → lock period `FOR UPDATE` → active, time-valid,
in-scope access with a capture role (`Treasurer`/`Chairperson`/`Elder`) via `get_my_hierarchy_ids()`
→ status must be `Draft`/`Rejected` → set GUC → `UPDATE` to `Submitted` with `submitted_by=auth.uid()`
and `server_revision = server_revision + 1` → upsert the manifest row for the new revision → write a
`SUBMIT` audit row → record the op-ledger result.

Return shape: `{ "status": "Submitted", "server_revision": int, "capture_generation": int,
"payload_fingerprint": text }`.

Setting `submitted_by = auth.uid()` and writing the `SUBMIT` audit row both feed the sign-off RPC's
involvement check, correctly disqualifying the submitter from signing off (no self-approval).

### 4.3 Period fields the client reads

`src/audit/AuditReviewPage.tsx` reads `period.server_revision` (as `serverRevision ?? 0`) and
`period.capture_generation` (as `captureGeneration ?? 1`) and uses them as `p_reviewed_revision` and
`p_capture_generation` in the sign-off call, and to scope `signoffsForRevision(...)`. It reads the
sign-off ledger columns `actor_user_id, signoff_perm_code, acting_as_auditor, acting_reason,
capture_generation, reviewed_revision, signoff_slot` from `cashbook_review_decision`. All exist once
both migrations are applied.

## 5. Reconciliation with `20261105120000` (zero edits)

Every object `20261105120000` references is created by the foundation with matching name and type:
base table + its `*_one_accepted` index and `*_decision_check` constraint, `cashbook_op_ledger(op_id,
result)`, `cashbook_submission_manifest`, the two `cashbook_period` columns, and
`cashbook_review_ready(uuid,int)`. `audit_log.assumed_role` (referenced by the sign-off migration's
`SELF_REVIEW_EXCEPTION` insert) already exists and is written by `logSelfReviewException`. Therefore
**no edit to `20261105120000` is required**. The plan includes a verification step to confirm this on
a disposable stack; if any mismatch is found there, the fix is a name/type change in the foundation,
keeping `20261105120000` untouched.

## 6. Invariant preservation (steering_old.md)

1. Permission gate single source — eligibility stays matrix-routed (`signoff.ts`, `permissions.ts`);
   the submit authority uses `capture.submit` holders (Treasurer/Chairperson/Elder).
2. No self-approval / two independent sign-offs / involvement — enforced by the authored sign-off RPC;
   the submit RPC strengthens it by recording `submitted_by` and a `SUBMIT` audit row.
3. `Submitted` ≠ `Review_Ready` — §3.
4. Fail-closed — missing manifest ⇒ `cashbook_review_ready` false; no manifest write policy;
   `cashbook_op_ledger` fully denied; the submit guard blocks any out-of-band `Submitted` write.
5. Tranche-4 proof access is not touched.
6. `PROGRESSIVE_DISPATCH_ENABLED` and `SUBMITTED_PROOF_FINALISATION_ENABLED` are unchanged.

## 7. Tests and gate

- `supabase/tests/two_person_signoff_rls.test.sql` extended with foundation fixtures (submit RPC
  populates the manifest; `cashbook_review_ready` false without a manifest, true with a balanced +
  fully-evidenced one; a direct `Submitted` update is blocked by `trg_guard_submitted`). SQL tests are
  authored, not run here (need a disposable Docker stack).
- Vitest: a new pure helper `buildSubmitManifestPayload` (shapes the submit RPC payload from a
  `RequiredManifest`) with unit tests; `syncEngine.retention.test.ts` mock updated so the submit
  branch exercises `rpc('cashbook_submit_period')` instead of a direct `cashbook_period` update.
- Gate: `npm run typecheck` = 0; `npx vitest run` green (baseline 199); `npm run lint` not worse than
  baseline.
