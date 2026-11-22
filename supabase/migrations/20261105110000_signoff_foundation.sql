-- ============================================================================
-- PRIORITY 2 foundation - the schema the two-person sign-off migration EXTENDS
--                                                        *** NOT APPLIED ***
--
-- Authored for review and for application ONLY in a disposable LOCAL stack
-- (`supabase start`, needs Docker) or an explicitly identified disposable test project.
-- NOT run against the dev/demo backend cwdyixafvylzgtpsfmwr; nothing is deployed in this
-- pass. This file sorts BEFORE 20261105120000_two_person_signoff.sql so it applies first.
--
-- It creates the base objects 20261105120000 assumes but that do NOT exist on the
-- backend (design: foundation-design.md): the revision columns, the base
-- cashbook_review_decision ledger (+ the index + decision CHECK that 20261105120000
-- drops and replaces), the op ledger, the submission manifest, cashbook_review_ready(),
-- the cashbook_submit_period() submit/manifest path, and the Submitted bypass guard.
--
-- ADDITIVE / NON-DESTRUCTIVE: create ... if not exists, create or replace, add column
-- if not exists. The only drops are `drop trigger if exists` / `drop policy if exists`
-- on objects THIS migration itself creates (so a clean backend is a no-op drop, and the
-- orchestrator can apply this additive file via the MCP; 20261105120000's drop-containing
-- parts go through the SQL editor).
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. cashbook_period revision columns (additive, sensibly defaulted).
--    rev=0 / gen=1 keep a never-submitted period coherent; the client reads these as
--    `?? 0` / `?? 1`, so defaults match and nothing is mis-read as rejected_stale.
-- ---------------------------------------------------------------------------
alter table public.cashbook_period
  add column if not exists server_revision    integer not null default 0,
  add column if not exists capture_generation integer not null default 1;

-- ---------------------------------------------------------------------------
-- 2. cashbook_review_decision - the base ledger 20261105120000 turns into a sign-off
--    ledger. It expects to DROP the index cashbook_review_decision_one_accepted and the
--    constraint cashbook_review_decision_decision_check, so both must exist here.
--    outcome admits the two values the sign-off RPC inserts: accepted | rejected_stale.
-- ---------------------------------------------------------------------------
create table if not exists public.cashbook_review_decision (
  id                 uuid primary key default gen_random_uuid(),
  period_id          uuid not null references public.cashbook_period(id) on delete cascade,
  actor_user_id      uuid not null,
  capture_generation integer not null default 1,
  reviewed_revision  integer not null,
  decision           text not null,
  outcome            text not null,
  reason             text,
  created_at         timestamptz not null default now(),
  constraint cashbook_review_decision_decision_check check (decision in ('approve','reject','reopen')),
  constraint cashbook_review_decision_outcome_check  check (outcome  in ('accepted','rejected_stale'))
);

-- The single-accepted index the sign-off migration drops and replaces with its
-- per-signer / one-completer / one-reject guards.
create unique index if not exists cashbook_review_decision_one_accepted
  on public.cashbook_review_decision (period_id, capture_generation, reviewed_revision)
  where (outcome = 'accepted');

-- ---------------------------------------------------------------------------
-- 3. cashbook_op_ledger - lost-ack idempotency shared by the submit + sign-off RPCs.
--    A replayed op_id with a matching payload_fingerprint returns the recorded result;
--    a mismatching fingerprint is a conflict.
-- ---------------------------------------------------------------------------
create table if not exists public.cashbook_op_ledger (
  op_id      uuid primary key,
  result     jsonb not null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 4. cashbook_submission_manifest - the Review_Ready evidence anchor. One frozen row
--    per submitted revision. Its EXISTENCE for a revision proves the submit went through
--    cashbook_submit_period (nothing else can write it).
-- ---------------------------------------------------------------------------
create table if not exists public.cashbook_submission_manifest (
  id                      uuid primary key default gen_random_uuid(),
  period_id               uuid not null references public.cashbook_period(id) on delete cascade,
  capture_generation      integer not null default 1,
  revision                integer not null,
  balanced                boolean not null,
  outstanding_proof_count integer not null default 0,
  proofs                  jsonb not null default '[]'::jsonb,
  frozen_by               uuid,
  frozen_at               timestamptz not null default now(),
  unique (period_id, capture_generation, revision)
);

-- ---------------------------------------------------------------------------
-- 5. cashbook_review_ready(period, reviewed_revision) -> boolean. Called by the sign-off
--    RPC to gate the COMPLETING sign-off. True only when, for the EXACT revision:
--      (1) the period exists and server_revision = p_reviewed_revision;
--      (2) a manifest row exists for (period, capture_generation, revision);
--      (3) manifest.balanced is true;
--      (4) every proof-required line item has at least one attachment.
--    Condition (2) is why nothing is approvable unless the submit RPC ran. Fail-closed:
--    any missing/false condition returns false.
-- ---------------------------------------------------------------------------
create or replace function public.cashbook_review_ready(p_period_id uuid, p_reviewed_revision int)
returns boolean
language plpgsql
security definer
set search_path to ''
stable
as $$
declare
  v_period   public.cashbook_period%rowtype;
  v_manifest public.cashbook_submission_manifest%rowtype;
begin
  select * into v_period from public.cashbook_period where id = p_period_id;
  if not found then
    return false;
  end if;
  if v_period.server_revision is distinct from p_reviewed_revision then
    return false;  -- stale / not the submitted revision
  end if;

  select * into v_manifest from public.cashbook_submission_manifest
   where period_id = p_period_id
     and capture_generation = v_period.capture_generation
     and revision = p_reviewed_revision;
  if not found then
    return false;  -- submit RPC never froze a manifest for this revision
  end if;
  if not v_manifest.balanced then
    return false;  -- Submitted != Review_Ready
  end if;

  -- Every proof-required line of this period must have at least one attachment.
  if exists (
    select 1 from public.cashbook_line_item li
    where li.period_id = p_period_id
      and li.item_type in ('EFT','DirectDebit','Burial','Expense','CashBanked')
      and not exists (
        select 1 from public.cashbook_attachment a where a.line_item_id = li.id
      )
  ) then
    return false;
  end if;

  return true;
end $$;

-- ---------------------------------------------------------------------------
-- 6. Submitted bypass guard (mirrors 20261105120000's trg_guard_audit_approved for
--    AuditApproved). `GRANT ALL ON cashbook_period TO authenticated` lets any in-scope
--    user UPDATE status directly; this trigger rejects any transition INTO Submitted
--    unless the submit RPC set the transaction-local GUC first, so a Submitted row ALWAYS
--    carries a frozen manifest + a bumped server_revision. It only ever fires on
--    new.status = 'Submitted'; Rejected / SubmittedToOverseer / SubmittedToHO / HOReviewed
--    and the Draft creation path are untouched.
-- ---------------------------------------------------------------------------
create or replace function public.cashbook_guard_submitted()
returns trigger language plpgsql as $$
begin
  if new.status = 'Submitted'
     and coalesce(old.status, '') <> 'Submitted'
     and current_setting('cashbook.submit_rpc', true) is distinct from '1' then
    raise exception 'Submitted may only be set via cashbook_submit_period'
      using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists trg_guard_submitted on public.cashbook_period;
create trigger trg_guard_submitted
  before update on public.cashbook_period
  for each row execute function public.cashbook_guard_submitted();

-- ---------------------------------------------------------------------------
-- 7. cashbook_submit_period(...) - the minimal correct submit/manifest path. One
--    transaction: freeze the manifest, bump server_revision, record the submitter, write
--    a SUBMIT audit row, record the op-ledger result. SECURITY DEFINER (owner), so it
--    bypasses RLS and drives the guarded Submitted transition under the GUC.
--
--    Fail-closed ORDER: auth.uid() present -> op-ledger replay -> lock period FOR UPDATE
--    -> active, time-valid, in-scope access with a capture role
--    (Treasurer/Chairperson/Elder) via get_my_hierarchy_ids() -> status Draft/Rejected ->
--    set GUC -> UPDATE to Submitted -> upsert manifest -> SUBMIT audit -> op-ledger write.
--
--    submitted_by = auth.uid() and the SUBMIT audit row both feed the sign-off RPC's
--    involvement check, correctly disqualifying the submitter (no self-approval).
-- ---------------------------------------------------------------------------
create or replace function public.cashbook_submit_period(
  p_op_id                   uuid,
  p_period_id               uuid,
  p_payload_fingerprint     text,
  p_balanced                boolean,
  p_outstanding_proof_count int         default 0,
  p_manifest                jsonb       default '[]'::jsonb,
  p_submitted_at            timestamptz default null,
  p_requestor_comment       text        default null,
  p_elder_approval_comment  text        default null
) returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_uid        uuid := auth.uid();
  v_role       text;
  v_period     public.cashbook_period%rowtype;
  v_new_rev    integer;
  v_generation integer;
  v_prior      jsonb;
  v_result     jsonb;
begin
  if v_uid is null then
    raise exception 'not_authorised' using errcode = '42501';
  end if;

  -- (a) Idempotent replay: a matching op id + fingerprint returns the recorded result and
  --     never re-applies; a reused id with a different fingerprint is a conflict.
  select result into v_prior from public.cashbook_op_ledger where op_id = p_op_id;
  if found then
    if (v_prior ->> 'payload_fingerprint') is distinct from p_payload_fingerprint then
      raise exception 'op_id_fingerprint_conflict' using errcode = '40001';
    end if;
    return v_prior;
  end if;

  -- (b) Lock the period row for the whole submit.
  select * into v_period from public.cashbook_period where id = p_period_id for update;
  if not found then
    raise exception 'period_not_found' using errcode = 'P0002';
  end if;

  -- (c) Authority: active, time-valid, in-scope access with a CAPTURE role. Derived from
  --     the JWT + user_hierarchy_access, never from client-supplied ids.
  select uha.role into v_role
    from public.user_hierarchy_access uha
   where uha.user_id = v_uid
     and uha.status = 'active'
     and uha.start_date <= now()
     and (uha.end_date is null or uha.end_date >= now())
     and uha.role in ('Treasurer','Chairperson','Elder')
     and v_period.congregation_id in (select public.get_my_hierarchy_ids())
   order by case uha.role when 'Treasurer' then 0 when 'Chairperson' then 1 else 2 end
   limit 1;
  if v_role is null then
    raise exception 'not_authorised' using errcode = '42501';
  end if;

  -- (d) Only an editable period may be submitted.
  if v_period.status not in ('Draft','Rejected') then
    raise exception 'period_not_submittable' using errcode = '42501';
  end if;

  -- (e) Drive the guarded Submitted transition under the GUC; bump the revision.
  perform set_config('cashbook.submit_rpc', '1', true);
  update public.cashbook_period
     set status                 = 'Submitted',
         submitted_by           = v_uid,
         submitted_at           = coalesce(p_submitted_at, now()),
         requestor_comment      = p_requestor_comment,
         elder_approval_comment = p_elder_approval_comment,
         server_revision        = coalesce(server_revision, 0) + 1
   where id = p_period_id
   returning server_revision, capture_generation into v_new_rev, v_generation;

  -- (f) Freeze the submission manifest for the new revision (one row per revision).
  insert into public.cashbook_submission_manifest
    (period_id, capture_generation, revision, balanced, outstanding_proof_count, proofs, frozen_by)
  values
    (p_period_id, v_generation, v_new_rev, coalesce(p_balanced, false),
     coalesce(p_outstanding_proof_count, 0), coalesce(p_manifest, '[]'::jsonb), v_uid)
  on conflict (period_id, capture_generation, revision) do update
    set balanced                = excluded.balanced,
        outstanding_proof_count = excluded.outstanding_proof_count,
        proofs                  = excluded.proofs,
        frozen_by               = excluded.frozen_by,
        frozen_at               = now();

  -- (g) SUBMIT audit row (independence evidence for the sign-off involvement check).
  insert into public.audit_log (user_id, action_type, entity_type, entity_id, comment)
  values (v_uid, 'SUBMIT', 'cashbook_period', p_period_id,
          coalesce(p_requestor_comment, 'Period submitted for audit'));

  -- (h) Record the op-ledger result for lost-ack replay.
  v_result := jsonb_build_object(
    'status', 'Submitted',
    'server_revision', v_new_rev,
    'capture_generation', v_generation,
    'payload_fingerprint', p_payload_fingerprint
  );
  insert into public.cashbook_op_ledger (op_id, result) values (p_op_id, v_result);
  return v_result;
end $$;

-- ---------------------------------------------------------------------------
-- 8. RLS + grants (scoped, fail-closed) - foundation-design.md §2.7.
--    Read-only scoped SELECT on the two readable tables; the definer RPCs do all writes.
--    op_ledger is fully denied to clients (only the definer RPCs touch it).
-- ---------------------------------------------------------------------------
alter table public.cashbook_review_decision    enable row level security;
alter table public.cashbook_submission_manifest enable row level security;
alter table public.cashbook_op_ledger           enable row level security;

drop policy if exists "review_decision_select_scoped" on public.cashbook_review_decision;
create policy "review_decision_select_scoped" on public.cashbook_review_decision
  for select to authenticated
  using (
    exists (
      select 1 from public.cashbook_period cp
      where cp.id = cashbook_review_decision.period_id
        and cp.congregation_id in (select public.get_my_hierarchy_ids())
    )
  );

drop policy if exists "submission_manifest_select_scoped" on public.cashbook_submission_manifest;
create policy "submission_manifest_select_scoped" on public.cashbook_submission_manifest
  for select to authenticated
  using (
    exists (
      select 1 from public.cashbook_period cp
      where cp.id = cashbook_submission_manifest.period_id
        and cp.congregation_id in (select public.get_my_hierarchy_ids())
    )
  );

-- op_ledger: RLS enabled, NO policies => every client read/write is denied; only the
-- SECURITY DEFINER RPCs (owner) touch it.
revoke all on table public.cashbook_op_ledger from public, anon;

-- The client reads sign-off rows + manifest; writes are definer-only.
grant select on public.cashbook_review_decision    to authenticated;
grant select on public.cashbook_submission_manifest to authenticated;

revoke all on function public.cashbook_review_ready(uuid,int) from public, anon;
grant execute on function public.cashbook_review_ready(uuid,int) to authenticated;

revoke all on function public.cashbook_submit_period(uuid,uuid,text,boolean,int,jsonb,timestamptz,text,text) from public, anon;
grant execute on function public.cashbook_submit_period(uuid,uuid,text,boolean,int,jsonb,timestamptz,text,text) to authenticated;

-- ============================================================================
-- NEEDS DISPOSABLE-STACK TESTING (cannot execute locally - no Docker in this pass):
--  1. cashbook_submit_period on a Draft/Rejected period sets Submitted, bumps
--     server_revision, writes a manifest row + a SUBMIT audit row, records the op ledger.
--  2. A direct `update cashbook_period set status='Submitted'` is rejected by
--     trg_guard_submitted (42501); the RPC path succeeds.
--  3. cashbook_review_ready is false with no manifest / unbalanced / evidence-short, and
--     true only when balanced + fully evidenced for the EXACT server_revision.
--  4. 20261105120000_two_person_signoff.sql applies cleanly on top of this foundation.
-- See supabase/tests/two_person_signoff_rls.test.sql.
-- ============================================================================
