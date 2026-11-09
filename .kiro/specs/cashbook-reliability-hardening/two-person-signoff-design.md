# Design Note — Two-Person Audit Sign-Off + Elder Referral

> **Scope:** a focused design note for the genuinely NEW Priority-2 behaviour in the
> cashbook-reliability-hardening spec: a **two-person audit sign-off** against one submitted
> revision, a **Chairperson acting-auditor** second sign-off under recorded reason and
> independence, and an **Elder referral** gap path. This note **extends** the spec's existing
> single-decision authority (`cashbook_review_decision`, design §6.1/§6.3) — it does **not**
> replace it and is **not** a new spec. It builds on the gap analysis (PRIORITY 2) and the
> captured pre-cutover backend (`policy-definitions.sql`, `functions.sql`, `grants.sql` under
> `…/backups/tranche4-precutover-20261104/`).
>
> **Status:** authored for review only. No code is implemented and no migration is applied in
> this step (pre-production backend `cwdyixafvylzgtpsfmwr` is untouched; see environment rules).
> Every server-side element is a design-level proposal tagged `DEPENDS-ON-UNVERIFIED` and must be
> reconciled with the deployed schema/enum/policies (design §12) and exercised on a **disposable**
> stack before any apply. Server checks that cannot be executed locally (no Docker, no hosted
> apply) are marked **NEEDS AUTHENTICATED/HOSTED TESTING**.
>
> **Open-decision guard:** this note does **not** resolve any open `OBD-*`, `D-*`, or `SD-*`
> decision. Where it touches one (status-vocabulary D-8, threshold/aggregation OBD-b, offline
> provisional review SD-6), it defers to the existing record and only describes behaviour inside
> the online review path (R38).

---

## 1. Overview

Today a single auditor approval closes a period. `AuditReviewPage.decide()` writes
`cashbook_period.update({ status:'AuditApproved' }).eq('status','Submitted')` and then a **separate**
`logAuditAction('AUDIT_APPROVE')` (not atomic, not server-validated beyond an optimistic row match,
design Finding 22). The spec's hardening already proposes replacing that with one atomic
`cashbook_review_decision` RPC that records **one** accepted decision per reviewed revision (design
§6.3, partial unique index `… where (outcome='accepted')`).

This note changes the governance rule from one approval to **two independent sign-offs** on the **same
submitted revision**, while keeping the spec's atomic-RPC + revision-binding + idempotency-ledger
machinery. The transition to `AuditApproved` is produced by, and only by, the operation that records the
**second valid sign-off**, inside one transaction. When a second valid sign-off cannot be obtained the
period stays `Submitted` (pending) and is surfaced to the **Elder assigned to that congregation** as a
referral to coordinate the missing reviewer; the Overseer is involved only if the Elder cannot resolve
it. Elder oversight is **not** an audit signature, and for the pilot there is **no one-signature
closure**.

The design reuses, rather than rebuilds:

- the **permission matrix** (`src/lib/permissions.ts`) as the single source of truth for who may sign
  (`audit.approve`: Auditor `A`, Chairperson/Elder `O`);
- the deployed hierarchy-scope function `get_my_hierarchy_ids()` and the `cashbook_period` /
  `cashbook_line_item` RLS policies captured in `policy-definitions.sql`;
- the spec's `cashbook_review_decision` table, `cashbook_op_ledger` idempotency ledger (design §5.3),
  `cashbook_submission_manifest` + `Review_Ready` computation (design §6.6), and `capture_generation` /
  `server_revision` revision model (design §3.2).

---

## 2. Technology stack (locked for this feature)

No new technology. Server: Postgres + Supabase RLS + a `plpgsql` `SECURITY DEFINER` RPC
(`cashbook_review_decision`, extended) owned by `postgres`, plus a small `BEFORE UPDATE` trigger guard on
`cashbook_period`. Client: existing Vite + React + TS, `@supabase/supabase-js` via
`@/lib/supabase/client`, `react-router-dom`, shadcn/ui under `@/components/ui`. All role/permission gating
in the client routes through `@/lib/permissions.ts`; the server derives authority from the JWT and
`user_hierarchy_access` (never from client-supplied ids).

---

## 3. Key design decisions

### 3.1 Extend `cashbook_review_decision` into a sign-off ledger (do not replace it)

The spec's `cashbook_review_decision` already records approve/reject/reopen bound to actor +
`reviewed_revision` + `capture_generation`, with an idempotency `decision_op_id`. We extend it rather
than add a parallel table, so one ledger holds the full, preserved history of every sign-off and
decision for a period.

**Additive column deltas** (all `DEPENDS-ON-UNVERIFIED`; reconcile to the real table in design §12):

```sql
-- Extend the spec's public.cashbook_review_decision (design §6.1). Additive only.
alter table public.cashbook_review_decision
  add column if not exists signoff_slot      smallint,      -- 1 = first sign-off, 2 = second/completing
  add column if not exists signoff_perm_code text,          -- matrix code used: 'A' (auditor) | 'O' (acting)
  add column if not exists acting_as_auditor boolean not null default false,
  add column if not exists acting_reason     text,          -- mandatory when acting_as_auditor = true
  add column if not exists completes_approval boolean not null default false; -- true on the row that drove AuditApproved
```

`decision` gains a `'signoff'` value alongside the existing `approve|reject|reopen` (widen the CHECK
constraint). A sign-off is recorded as `decision='signoff'`, `outcome='accepted'`; the existing
`approve` value is retired for the two-person flow (reject/reopen are unchanged). `actor_user_id`,
`reviewed_revision`, `capture_generation`, `reason`, `created_at` stay as the spec defines them.

**Uniqueness changes.** The spec's `cashbook_review_decision_one_accepted` partial index (at most one
accepted decision per reviewed revision) is **incompatible** with needing two accepted sign-offs. Replace
it with two narrower partial indexes:

```sql
-- One accepted sign-off per DISTINCT signer per reviewed revision -> "same person cannot sign twice".
drop index if exists public.cashbook_review_decision_one_accepted;
create unique index cashbook_signoff_one_per_signer
  on public.cashbook_review_decision (period_id, capture_generation, reviewed_revision, actor_user_id)
  where (outcome = 'accepted' and decision = 'signoff');

-- Exactly one row may carry the completing transition for a reviewed revision.
create unique index cashbook_signoff_one_completer
  on public.cashbook_review_decision (period_id, capture_generation, reviewed_revision)
  where (completes_approval);

-- Reject keeps at-most-one accepted terminal decision per reviewed revision.
create unique index cashbook_reject_one_accepted
  on public.cashbook_review_decision (period_id, capture_generation, reviewed_revision)
  where (outcome = 'accepted' and decision = 'reject');
```

`cashbook_signoff_one_per_signer` is the **server-enforced** "no same person twice" guard. The
`completes_approval` index guarantees two racing second-sign-offs cannot both drive the transition.

### 3.2 Sign-off collection and the completing transition (atomic, succeed-or-fail together)

One RPC call records one sign-off. The RPC counts the accepted sign-offs for the **current** revision
after inserting this one; the transition to `AuditApproved` happens **in the same transaction** only when
this call makes the count reach two with a valid pair.

- **First valid sign-off:** insert the `signoff` row (`signoff_slot = 1`); period stays `Submitted`; no
  transition. Returned result reports "1 of 2".
- **Second valid sign-off:** insert the `signoff` row (`signoff_slot = 2`, `completes_approval = true`);
  in the SAME transaction set `status = 'AuditApproved'`, bump `server_revision`, and write the mandatory
  `AUDIT_APPROVE` audit row. If any of the insert / transition / audit writes fails, the whole
  transaction rolls back — **neither the second sign-off nor `AuditApproved` is committed** (the user's
  "succeed or fail together" requirement).

The RPC takes `SELECT … FOR UPDATE` on the target `cashbook_period` row first, so two concurrent second
sign-offs serialise: the first commits the transition, the second then sees the advanced
`server_revision` and is recorded `outcome='rejected_stale'` (reload required). A valid pair requires **at
least one `signoff_perm_code='A'` (a real Auditor) sign-off**; the acting-auditor slot (`'O'`) may fill
only the second position and never be the sole signatory (§3.4).

### 3.3 Involvement check — independence from preparation, not just role (server-side)

Role eligibility is necessary but not sufficient. The server disqualifies any signer who took part in
preparing, editing, or submitting the capture being signed. Involvement is derived server-side from data
the server can trust, never from the client:

```
involvement_set(period) =
    { cashbook_period.submitted_by }
  ∪ { audit_log.user_id : entity_type = 'cashbook_period'
                          AND entity_id = period.id
                          AND action_type IN ('CAPTURE','SUBMIT','ACTING_AS_TREASURER',
                                              'SELF_REVIEW_EXCEPTION') }
```

A signer whose `auth.uid()` is in `involvement_set(period)` is rejected with `signer_involved`. This
covers all four required rules at once: **no self-approval** (the submitter is in the set), and the
**role-switch block** — a Chairperson who captured as Treasurer logs `ACTING_AS_TREASURER` against the
period (`logActingAsTreasurer`, flushed by the sync engine), so that same user is in the set and **cannot
sign by switching back to Chairperson**. The check uses *actual involvement*, not role.

**Data dependency (flagged).** Involvement completeness depends on preparer/editor/submitter identity
being recorded per period. Today `submitted_by` is set by `get_or_create_period`/submission, and
`ACTING_AS_TREASURER` / `SELF_REVIEW_EXCEPTION` rows carry `user_id`, but routine capture **edits** are
not reliably written to `audit_log` with the editing user. The spec's submit RPC (design §6.2) is
expected to record a mandatory `SUBMIT` row with `user_id`; until capture/edit attribution is also
written per revision, the involvement set may under-detect a pure editor who never submitted. This is an
implementation + **NEEDS AUTHENTICATED/HOSTED TESTING** item, not resolved here.

### 3.4 Eligibility via the permission matrix; Chairperson acting-auditor with recorded reason

The client decides which controls to show through `@/lib/permissions.ts` only — no role-string checks in
components (steering invariant #1):

- `hasPermission(role, 'audit.approve')` gates the sign-off control. `getPermission` returns `'A'` for
  **Auditor** (primary sign-off) and `'O'` for **Chairperson**/**Elder** (acting/override).
- When the code is `'O'`, the UI renders the acting-auditor sub-flow: a mandatory **recorded reason**
  field and a confirmation that a `SELF_REVIEW_EXCEPTION` will be logged (consistent with invariant #6
  and the existing override pattern already in `AuditReviewPage.decide()`).

The **server** narrows the acting slot to **Chairperson** and enforces the business rule — server-side
role checks against `user_hierarchy_access` are legitimate authority (the deployed RLS and
`functions.sql` already gate on roles). The RPC rule:

- primary sign-off: actor role resolves to `audit.approve = 'A'` (Auditor);
- acting sign-off: actor role is **Chairperson** (`audit.approve = 'O'`), `acting_as_auditor = true`, and
  a non-empty `acting_reason` (else `reason_required`); it may occupy only `signoff_slot = 2` and the pair
  must still contain one Auditor-`A` sign-off.

**Elder is not an acting auditor.** Elder also carries `'O'` on `audit.approve` for the existing drill-in
override path (the `/audit/:periodId` route reached from `ElderDashboard`), but the two-person sign-off
business rule states Elder oversight is **not** an audit signature. The RPC therefore rejects an Elder as
a two-person sign-off signatory (`signer_role_not_eligible`). Availability of a second real Auditor is a
human fact the server cannot verify; it is **attested** by the Chairperson's recorded reason (e.g.
"only one auditor available / Treasurer ill"), not server-proven — stated as a limitation, not a gap.

### 3.5 Fresh revision requires fresh sign-offs; history preserved

Every sign-off row is bound to `(period_id, capture_generation, reviewed_revision)` where
`reviewed_revision = server_revision` at the time of signing. The completing-count query and the
transition only consider accepted sign-offs matching the period's **current** generation and
`server_revision`. Consequences, with no extra machinery:

- A **re-submission** (new `server_revision` within a generation) or an **HO reopen/correction** (new
  `capture_generation`, design §6.4) leaves earlier sign-offs bound to the superseded revision — they do
  **not** count toward the new one. Fresh sign-offs are required.
- Nothing is deleted. Earlier sign-off rows (and any `rejected_stale`/`rejected_competing` outcomes)
  remain for the full audit trail (**preserve sign-off history**).

### 3.6 Close the bypass: RPC-only transition into AuditApproved

The deployed `cashbook_period_write` policy is `FOR ALL TO authenticated USING (congregation_id IN
get_my_hierarchy_ids()) WITH CHECK (same)` and `grants.sql` shows `GRANT ALL ON cashbook_period TO
authenticated`. Any in-scope authenticated user can therefore `UPDATE status` directly today — the exact
bypass the acceptance test targets. Two options were considered:

1. **Column-privilege revoke** — `REVOKE UPDATE (status) ON public.cashbook_period FROM authenticated` and
   let only the owner-defined RPCs change status. Clean, but it simultaneously disables the **other**
   status writers (submit, month submit-to-Overseer in `ElderDashboard`, Overseer/HO), so it can only
   land together with the spec's full set of transition RPCs (design §6.2/§6.4/§6.5). Too broad to own
   inside this feature.
2. **Trigger-GUC guard scoped to the AuditApproved transition** — a `BEFORE UPDATE` trigger on
   `cashbook_period` that rejects any transition **into** `AuditApproved` unless a transaction-local GUC
   set by the review RPC is present.

**Chosen: option 2** for this feature, because it closes the two-person bypass surgically without
breaking the month/submit writers that are hardened elsewhere. The column-revoke (option 1) is noted as
the broader-spec end state once all transition RPCs exist.

```sql
-- SECURITY DEFINER RPC (owner postgres) sets this transaction-local flag before the controlled UPDATE:
--   perform set_config('cashbook.review_rpc', '1', true);   -- true = local to the transaction

create or replace function public.cashbook_guard_audit_approved()
returns trigger language plpgsql as $$
begin
  if new.status = 'AuditApproved' and coalesce(old.status,'') <> 'AuditApproved'
     and current_setting('cashbook.review_rpc', true) is distinct from '1' then
    raise exception 'AuditApproved may only be set via cashbook_review_decision'
      using errcode = '42501';
  end if;
  return new;
end $$;

create trigger trg_guard_audit_approved
  before update on public.cashbook_period
  for each row execute function public.cashbook_guard_audit_approved();
```

`AuditReviewPage` stops issuing the direct `.update({ status:'AuditApproved' })` and calls the RPC
instead. A direct Data-API update to `AuditApproved` is then rejected by the trigger even for an in-scope
user. **NEEDS AUTHENTICATED/HOSTED TESTING:** that the trigger blocks a direct update under a real JWT and
that the RPC path still succeeds (the acceptance test). The GUC must be set only inside the RPC and only
after authority + sign-off validation.

### 3.7 Elder referral gap path (leave pending; no one-signature closure)

When a submitted revision is `Review_Ready` but has only **one** accepted sign-off and no eligible,
independent second signer is available, the period **stays `Submitted`**. No new status and no lock table
are introduced (consistent with SD-1). The pending-needs-second condition is **derived**, not stored:

```
pending_needs_second(period) :=
     period.status = 'Submitted'
 AND Review_Ready(period) = true
 AND count(accepted signoff rows for current generation + server_revision) = 1
```

The Elder assigned to the congregation is the first point of contact. `ElderDashboard` already resolves
the Elder's congregations and loads each month's periods and their `audit_log`; it gains a referral
surface that lists each `pending_needs_second` period with **why** it is pending — who gave the first
sign-off (role + name/initials from the sign-off row), what is missing (a second independent sign-off),
and whether an acting-auditor reason is required. The Elder **coordinates** the missing reviewer
(contacts an independent Auditor, or arranges a Chairperson acting-auditor where justified). The Elder's
coordination is **not** a signature and writes no sign-off row; `ElderDashboard` must not expose a sign
action for the Elder here (the existing drill-in `/audit/:periodId` override path is a separate,
audited mechanism and is unchanged).

Escalation to the **Overseer** is a UI/coordination step surfaced only when the Elder marks the referral
unresolved or Overseer authority is needed; it changes no `Business_State`. For the pilot there is **no
one-signature closure** — the capture remains pending until two valid sign-offs are obtained.

An optional lightweight Elder coordination note (who was contacted / escalation reason) is **deferred**:
it would require a new `audit_log` action enum value and is not needed to leave captures pending. Noted,
not built.

---

## 4. Server contract — `cashbook_review_decision` (extended), `DEPENDS-ON-UNVERIFIED`

One RPC serves `signoff` and `reject` (and the existing HO `reopen`, unchanged). Function and column names
are design choices to reconcile against design §12.

- **Inputs:** `p_decision_op_id uuid`, `p_period_id uuid`, `p_capture_generation int`,
  `p_decision text` (`'signoff' | 'reject'`), `p_reviewed_revision int`, `p_payload_fingerprint text`,
  `p_acting_as_auditor boolean` (signoff only), `p_acting_reason text` (required when acting),
  `p_reason text` (required for reject), `p_verification jsonb` (four-section flags, approve-completing).
- **Transaction + lock:** one transaction; `SELECT … FOR UPDATE` on `public.cashbook_period`.
- **Idempotent replay:** first step consults `cashbook_op_ledger` on `p_decision_op_id` (design §5.3) —
  a replay with a matching fingerprint returns the recorded result and never re-applies; a mismatched
  fingerprint for a reused id is a conflict.
- **Authority:** derive actor from JWT; require active, time-valid `user_hierarchy_access` scoped to the
  period's congregation (mirror `get_my_hierarchy_ids()` semantics) and the operation-specific matrix
  permission (`audit.approve` for signoff, `audit.reject` for reject) — **not** the HO admin gate.
- **Revision/generation binding:** require `server_revision = p_reviewed_revision` and
  `capture_generation = p_capture_generation`; otherwise record `outcome='rejected_stale'` and return a
  definitive failure result.

**`signoff` steps (atomic):**
1. idempotency-ledger check;
2. authority + role resolution (`'A'` Auditor, or `'O'` Chairperson for the acting slot; Elder rejected);
3. involvement check — `auth.uid()` not in `involvement_set(period)` (§3.3);
4. acting-slot rules — if `p_acting_as_auditor`: role must be Chairperson, `p_acting_reason` non-empty,
   this must be `signoff_slot = 2`;
5. insert the `signoff` row (`outcome='accepted'`); the `cashbook_signoff_one_per_signer` index rejects a
   second sign-off by the same person (mapped to `already_signed`);
6. count accepted sign-offs for the current generation + revision:
   - count `= 1` → set `signoff_slot = 1`; commit; result "1 of 2", period stays `Submitted`;
   - count `= 2` **and** the pair includes an Auditor-`A` sign-off **and** `Review_Ready = true` **and**
     the submission is balanced **and** `p_verification` present → set `signoff_slot = 2`,
     `completes_approval = true`; `set_config('cashbook.review_rpc','1',true)`; set
     `status='AuditApproved'`, bump `server_revision`, write mandatory `AUDIT_APPROVE` audit row; insert
     the ledger row; commit;
   - count `= 2` but not `Review_Ready` / unbalanced / verification missing → raise `not_review_ready` /
     `unbalanced` / `verification_required` (whole tx rolls back; the second sign-off is **not** recorded,
     keeping sign-off and transition together).
7. for a Chairperson acting sign-off, also write the `SELF_REVIEW_EXCEPTION` audit row in the same tx.

**`reject` steps (atomic, narrow prerequisites — unchanged from design §6.3):** authority + mandatory
`p_reason` + reviewed-revision reference only; set `status='Rejected'`, bump `server_revision`, write
`AUDIT_REJECT`; reject does **not** require Review_Ready, two sign-offs, balance, or verification, and is
permitted while a period has zero or one sign-off.

**Outputs / error model:**

| Condition | Recoverable? | Caller receives | Logged |
|---|---|---|---|
| success (1 of 2) | n/a | result: `status='Submitted'`, `signoffs=1`, who signed | sign-off row + optional SELF_REVIEW_EXCEPTION |
| success (2 of 2 → approved) | n/a | result: `status='AuditApproved'`, `server_revision` | sign-off row + `AUDIT_APPROVE` (+ SELF_REVIEW_EXCEPTION if acting) |
| `not_authorised` / `signer_role_not_eligible` | no (fatal for actor) | raised exception → client maps to `auth`; show access error | none (tx rollback) |
| `signer_involved` | no | raised exception; UI explains independence failure | none (tx rollback) |
| `already_signed` (same person) | no | definitive failure result; UI shows "you already signed" | unique-index violation; no new row |
| `reason_required` (acting signoff) / reason missing (reject) | yes (re-enter) | raised exception; UI requires the field | none (tx rollback) |
| `not_review_ready` / `unbalanced` / `verification_required` (completing) | yes | raised exception; period stays `Submitted` | none (tx rollback) |
| `rejected_stale` (revision advanced) | yes (reload) | definitive failure result with current status | recorded decision row (outcome) |
| transport failure (unknown outcome) | yes | exception; client **retries same `decision_op_id`** → ledger resolves idempotently | ledger if the write committed |

Client mapping of error categories follows the spec: `not_authorised`→`auth`;
`rejected_stale`→`conflict`; `not_review_ready`/`unbalanced`/`verification_required`→`permanent` (for this
attempt); transport→`transient` (retry by op id).

---

## 5. Client / UI changes

- **`src/audit/AuditReviewPage.tsx`** — replace the direct `.update({status}).eq('status','Submitted')` +
  separate `logAuditAction` with a single `supabase.rpc('cashbook_review_decision', …)` call carrying
  `decision_op_id` (client UUID), reviewed revision, generation, and, for an `'O'` role, the acting reason.
  Render sign-off state: **"Sign-off 1 of 2 — Auditor (name)"**, and after the second,
  **"Second sign-off: Chairperson (acting auditor) — reason: …"** or **"Second sign-off: Auditor
  (name)"**. The four-section verification boxes gate only the **completing** sign-off (approve path).
  Keep the existing Realtime watch; refresh sign-off state on external change.
- **`src/audit/AuditDashboard.tsx`** — split the pending queue into **awaiting first sign-off**,
  **one-of-two (needs independent second)**, and show `pending_needs_second` items distinctly. No new
  role strings; gate via `hasPermission(role,'audit.view_queue')`.
- **`src/elder/ElderDashboard.tsx`** — add the referral surface (§3.7): list `pending_needs_second`
  periods for the Elder's congregations with the "why pending" detail and a coordinate/escalate control;
  no Elder sign action here.
- **`src/lib/permissions.ts`** — no matrix change required (`audit.approve` already Auditor `A`,
  Chairperson/Elder `O`). Add thin pure helpers if useful (e.g. `isActingAuditor(role)` =
  `getPermission(role,'audit.approve')==='O'`) — matrix-routed, no role strings.
- **`src/lib/types.ts`** — add the sign-off result/row shapes (slot, perm code, acting flag, reason,
  completes_approval) and the `decision='signoff'` literal; no new `AuditActionType` is required for the
  pilot (approve/reject/self-review already exist).
- **New migration** `supabase/migrations/<ts>_two_person_signoff.sql` (**authored, NOT applied**): the
  `cashbook_review_decision` column deltas + index swap (§3.1), the extended RPC (§4), and the trigger
  guard (§3.6).
- **New SQL suite** `supabase/tests/two_person_signoff_rls.test.sql` (**authored, unexecuted**): the
  effective-policy / behaviour suite for §6.

---

## 6. Testing strategy

**Unit-testable locally (no backend):** pure eligibility/slot logic extracted to `src/audit/` or
`src/lib/` — matrix-routed eligibility (`A` primary vs `O` acting), the "valid pair needs one Auditor-`A`"
rule, acting-reason-required, the derived `pending_needs_second` predicate, and the UI label mapping.
These run under vitest alongside the existing 104 tests.

**Integration / server (authored, unexecuted here):** the extended RPC, the indexes, the trigger guard,
and the involvement query must be exercised on a disposable local stack (`supabase start`, Docker) or an
explicitly disposable throwaway project, then reconciled to the deployed schema (design §12) before any
apply. Passing effective-RLS + integrity tests on a disposable stack is the gate.

### NEEDS AUTHENTICATED/HOSTED TESTING (cannot be executed locally in this step)

1. **Bypass closure (the acceptance test):** neither the pre-existing approval path nor a direct Data-API
   `update status='AuditApproved'` can bypass readiness or the second sign-off — the trigger guard rejects
   the direct update under a real JWT while the RPC succeeds.
2. **Succeed-or-fail-together:** the second valid sign-off and the `AuditApproved` transition commit
   atomically; forcing the audit/transition write to fail rolls back the second sign-off too.
3. **No self-approval / no same person twice / involvement:** the submitter and any
   `CAPTURE`/`SUBMIT`/`ACTING_AS_TREASURER`/`SELF_REVIEW_EXCEPTION` participant is rejected
   (`signer_involved`); the `cashbook_signoff_one_per_signer` index blocks a repeat signer.
4. **Chairperson-acting-as-Treasurer role switch is blocked** (the `ACTING_AS_TREASURER` row puts them in
   the involvement set) and the acting slot is Chairperson-only, reason-mandatory, second-slot-only.
5. **Fresh-revision binding:** sign-offs for a superseded `server_revision`/`capture_generation` do not
   count after re-submission or HO reopen; history rows are preserved.
6. **Elder referral is not a signature:** nothing the Elder does writes a sign-off row or advances status;
   `pending_needs_second` captures stay `Submitted` with no one-signature closure.
7. **Involvement-data completeness** depends on per-revision preparer/editor/submitter attribution being
   recorded (§3.3) — verify against the submit RPC and capture/edit audit writes once deployed.
8. **RLS/scope + idempotency** of the extended RPC under real auth: in-scope-only, `decision_op_id` replay
   returns the recorded result, competing/stale outcomes recorded correctly.

---

## 7. Edge cases

- **Two real Auditors sign:** no acting flag, no reason, pair valid, second sign-off transitions.
- **Only one Auditor, Chairperson signs second:** acting reason mandatory; involvement-clear Chairperson;
  transition on the second.
- **Chairperson tries to be the only/first signer:** rejected — a valid pair requires one Auditor-`A`;
  acting is second-slot-only.
- **Same Auditor opens the review twice / double-clicks:** idempotency ledger (same `decision_op_id`)
  returns the recorded "1 of 2"; a *different* op id by the same person hits
  `cashbook_signoff_one_per_signer` → `already_signed`.
- **Reject after one sign-off:** allowed; sets `Rejected`; the earlier sign-off row is preserved; a reopen
  creates a new generation needing fresh sign-offs.
- **Period edited/re-submitted between the two sign-offs:** `server_revision` advances; the second
  sign-off is `rejected_stale`; the first sign-off no longer counts — both reviewers must re-sign the new
  revision.
- **Not Review_Ready at the second sign-off** (declared proof still uploading): completing sign-off raises
  `not_review_ready`, tx rolls back, period stays `Submitted` with one sign-off recorded.
- **Elder with `O` tries to count as a sign-off:** server rejects (`signer_role_not_eligible`); the Elder
  drill-in override path remains a separate, audited mechanism and is untouched.

---

## 8. Invariant ownership and alignment with steering

- **Permission matrix is the single source of truth (invariant #1):** client gating via
  `permissions.ts` (`hasPermission`/`getPermission`/`isOverrideAction`); the server enforces authority
  from `user_hierarchy_access` (legitimate server-side role authority, as the deployed functions already
  do). No role strings in components.
- **Self-review exceptions are audited (invariant #6):** a Chairperson acting-auditor sign-off writes
  `SELF_REVIEW_EXCEPTION` in the same transaction as the sign-off.
- **Status flow is directional; HO-only corrections (invariant #9):** the only new transition is the
  guarded `Submitted → AuditApproved` produced solely by the completing sign-off; reject/reopen are
  unchanged; the trigger guard owns enforcement of "AuditApproved only via the RPC."
- **Fail-closed auth (invariant #5):** every failure in the sign-off chain (authority, involvement, role,
  reason, revision, Review_Ready, integrity) raises/returns a definitive failure and never falls through
  to an approval.
- **Secretary totals-only (invariant #7):** unaffected; Secretary has no `audit.*` permission.
- **Enforcement layer:** the two-person rule and the AuditApproved transition are owned **server-side**
  (RPC + trigger + indexes) because a client cannot be trusted to enforce independence or atomicity; the
  client is a UX aid only (design §6.9, R29.7).

## 9. Open decisions preserved (not resolved here)

- **D-8 status vocabulary** (`OverseerApproved`/`OverseerRejected` absence, deployed enum): this note
  touches only `Submitted → AuditApproved`; the transition validator must still be reconciled to the
  deployed enum before any apply (design §2.4).
- **SD-6 offline provisional review:** this note describes the online review path (R38) only; offline
  provisional sign-off is deferred.
- **OBD-b/-c/-d** (expense threshold/aggregation, acknowledgement label): untouched.
- The **optional Elder coordination note** (new `audit_log` action) is deferred, not designed.
