-- ============================================================================
-- PRIORITY 2 - Two-person audit sign-off + acting-auditor + bypass guard
--                                                        *** NOT APPLIED ***
--
-- Authored for review and for application ONLY in a disposable LOCAL stack
-- (`supabase start`, needs Docker) or an explicitly identified disposable test project.
-- NOT run against the dev/demo backend cwdyixafvylzgtpsfmwr; nothing is deployed in this
-- pass. The effective-RLS / behaviour tests (supabase/tests/two_person_signoff_rls.test.sql)
-- MUST pass on a disposable stack before this is applied even to the dev/demo backend.
--
-- EXTENDS (does NOT replace) the spec's single `cashbook_review_decision` authority
-- (design 6.1/6.3): a reviewed revision now needs TWO accepted `signoff` rows (at least
-- one from a real Auditor). The transition to AuditApproved is produced by, and only by,
-- the operation that records the SECOND valid sign-off, inside ONE transaction - so the
-- second sign-off and the status change succeed or fail together.
--
-- DEPENDS-ON-UNVERIFIED: every object below assumes the spec's prior schema
-- (`cashbook_review_decision`, `cashbook_op_ledger`, `cashbook_submission_manifest`,
-- `server_revision` / `capture_generation` on `cashbook_period`, `get_my_hierarchy_ids()`).
-- Those are themselves authored-not-applied (Task 2/3). Reconcile names/types to the
-- deployed schema (design 12) on a disposable stack BEFORE any apply. Guarded with
-- IF NOT EXISTS / IF EXISTS so a partial prior state does not hard-fail the reconcile run.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Extend `cashbook_review_decision` into a sign-off ledger (additive only).
--    One ledger row per decision; nothing is deleted, so the full sign-off history
--    for every revision is preserved.
-- ---------------------------------------------------------------------------
alter table public.cashbook_review_decision
  add column if not exists signoff_slot       smallint,            -- 1 = first, 2 = completing
  add column if not exists signoff_perm_code  text,                -- 'A' Auditor | 'O' Chairperson acting
  add column if not exists acting_as_auditor  boolean not null default false,
  add column if not exists acting_reason      text,                -- mandatory when acting_as_auditor
  add column if not exists completes_approval boolean not null default false; -- the row that drove AuditApproved

-- Widen the decision CHECK to admit 'signoff' alongside the existing approve/reject/reopen.
-- (approve is retired for the two-person flow; reject/reopen keep their meaning.)
do $$
begin
  if exists (select 1 from pg_constraint where conname = 'cashbook_review_decision_decision_check') then
    alter table public.cashbook_review_decision drop constraint cashbook_review_decision_decision_check;
  end if;
  alter table public.cashbook_review_decision
    add constraint cashbook_review_decision_decision_check
    check (decision in ('signoff','approve','reject','reopen'));
end $$;

-- The acting code must only ever be an acting ('O') row, and a reason is mandatory for it.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'cashbook_signoff_perm_code_check') then
    alter table public.cashbook_review_decision
      add constraint cashbook_signoff_perm_code_check
      check (signoff_perm_code is null or signoff_perm_code in ('A','O'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'cashbook_signoff_acting_reason_check') then
    alter table public.cashbook_review_decision
      add constraint cashbook_signoff_acting_reason_check
      check (not acting_as_auditor or (acting_reason is not null and length(btrim(acting_reason)) > 0));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Index swap: the single-accepted index is incompatible with needing TWO sign-offs.
--    Replace it with the server-enforced "same person cannot sign twice" + "only one
--    completing row" + reject-terminal guards.
-- ---------------------------------------------------------------------------
drop index if exists public.cashbook_review_decision_one_accepted;

-- One accepted sign-off per DISTINCT signer per reviewed revision => no same person twice.
create unique index if not exists cashbook_signoff_one_per_signer
  on public.cashbook_review_decision (period_id, capture_generation, reviewed_revision, actor_user_id)
  where (outcome = 'accepted' and decision = 'signoff');

-- Exactly one completing row per reviewed revision => two racing seconds cannot both drive it.
create unique index if not exists cashbook_signoff_one_completer
  on public.cashbook_review_decision (period_id, capture_generation, reviewed_revision)
  where (completes_approval);

-- Reject keeps at most one accepted terminal reject per reviewed revision.
create unique index if not exists cashbook_reject_one_accepted
  on public.cashbook_review_decision (period_id, capture_generation, reviewed_revision)
  where (outcome = 'accepted' and decision = 'reject');

-- ---------------------------------------------------------------------------
-- 3. Bypass guard (design 3.6): AuditApproved may ONLY be set by the review RPC.
--    `GRANT ALL ON cashbook_period TO authenticated` means any in-scope user can UPDATE
--    status directly today - the exact bypass the acceptance test targets. A BEFORE UPDATE
--    trigger rejects any transition INTO AuditApproved unless the RPC set a transaction-
--    local GUC first. This is surgical: it does not disturb the submit / month writers.
-- ---------------------------------------------------------------------------
create or replace function public.cashbook_guard_audit_approved()
returns trigger language plpgsql as $$
begin
  if new.status = 'AuditApproved'
     and coalesce(old.status, '') <> 'AuditApproved'
     and current_setting('cashbook.review_rpc', true) is distinct from '1' then
    raise exception 'AuditApproved may only be set via cashbook_review_decision'
      using errcode = '42501';
  end if;
  return new;
end $$;

drop trigger if exists trg_guard_audit_approved on public.cashbook_period;
create trigger trg_guard_audit_approved
  before update on public.cashbook_period
  for each row execute function public.cashbook_guard_audit_approved();

-- ---------------------------------------------------------------------------
-- 4. The extended review RPC. SECURITY DEFINER, owner postgres. Serves `signoff` and
--    `reject`; the existing HO `reopen` is unchanged and not re-declared here.
--
--    One transaction, one SELECT ... FOR UPDATE on the period, so concurrent seconds
--    serialise: the first commits the transition and bumps server_revision; the next sees
--    the advanced revision and is recorded rejected_stale.
--
--    Fail-closed ORDER (every failure raises or records a definitive failure; none falls
--    through to an approval):
--      ledger idempotency -> authority+role -> involvement -> acting rules -> insert
--      sign-off -> count -> (1 of 2 | completing pair) -> transition (completing only).
-- ---------------------------------------------------------------------------
create or replace function public.cashbook_review_decision(
  p_decision_op_id     uuid,
  p_period_id          uuid,
  p_capture_generation int,
  p_decision           text,            -- 'signoff' | 'reject'
  p_reviewed_revision  int,
  p_payload_fingerprint text,
  p_acting_as_auditor  boolean default false,
  p_acting_reason      text    default null,
  p_reason             text    default null,
  p_verification       jsonb   default null
) returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_uid         uuid := auth.uid();
  v_role        text;
  v_perm        text;          -- resolved sign-off code: 'A' (Auditor) | 'O' (Chairperson)
  v_period      public.cashbook_period%rowtype;
  v_involved    boolean;
  v_accepted    int;
  v_slot        smallint;
  v_has_auditor boolean;
  v_ready       boolean;
  v_prior       jsonb;
begin
  if v_uid is null then
    raise exception 'not_authorised' using errcode = '42501';
  end if;

  -- (a) Idempotent replay: a matching op id + fingerprint returns the recorded result and
  --     never re-applies; a reused id with a different fingerprint is a conflict.
  select result into v_prior from public.cashbook_op_ledger
   where op_id = p_decision_op_id;
  if found then
    if (v_prior ->> 'payload_fingerprint') is distinct from p_payload_fingerprint then
      raise exception 'op_id_fingerprint_conflict' using errcode = '40001';
    end if;
    return v_prior;
  end if;

  -- (b) Lock the period row for the whole decision.
  select * into v_period from public.cashbook_period
   where id = p_period_id for update;
  if not found then
    raise exception 'period_not_found' using errcode = 'P0002';
  end if;

  -- (c) Authority: active, time-valid, in-scope access to this congregation. Derived from
  --     the JWT + user_hierarchy_access, NEVER from client-supplied ids. Mirrors
  --     get_my_hierarchy_ids() scope semantics (design 3.4).
  select uha.role into v_role
    from public.user_hierarchy_access uha
   where uha.user_id = v_uid
     and uha.status = 'active'
     and uha.start_date <= now()
     and (uha.end_date is null or uha.end_date >= now())
     and v_period.congregation_id in (select public.get_my_hierarchy_ids())
   order by case uha.role when 'Auditor' then 0 when 'Chairperson' then 1 else 2 end
   limit 1;
  if v_role is null then
    raise exception 'not_authorised' using errcode = '42501';
  end if;

  -- Fresh-revision binding (both decisions reference the reviewed revision).
  if v_period.server_revision is distinct from p_reviewed_revision
     or v_period.capture_generation is distinct from p_capture_generation then
    insert into public.cashbook_review_decision
      (period_id, actor_user_id, capture_generation, reviewed_revision, decision, outcome, reason)
    values
      (p_period_id, v_uid, p_capture_generation, p_reviewed_revision, p_decision, 'rejected_stale', p_reason);
    raise exception 'rejected_stale' using errcode = '40001';
  end if;

  -- ----- REJECT (narrow prerequisites: authority + reason + revision only) -----
  if p_decision = 'reject' then
    if v_role not in ('Auditor','Chairperson','Elder') then        -- audit.reject holders
      raise exception 'signer_role_not_eligible' using errcode = '42501';
    end if;
    if p_reason is null or length(btrim(p_reason)) = 0 then
      raise exception 'reason_required' using errcode = '22023';
    end if;
    update public.cashbook_period
       set status = 'Rejected',
           server_revision = server_revision + 1,
           audit_comment = p_reason
     where id = p_period_id;
    insert into public.cashbook_review_decision
      (period_id, actor_user_id, capture_generation, reviewed_revision, decision, outcome, reason)
    values
      (p_period_id, v_uid, p_capture_generation, p_reviewed_revision, 'reject', 'accepted', p_reason);
    insert into public.audit_log (user_id, action_type, entity_type, entity_id, comment)
    values (v_uid, 'AUDIT_REJECT', 'cashbook_period', p_period_id, p_reason);
    return jsonb_build_object('status','Rejected','payload_fingerprint',p_payload_fingerprint);
  end if;

  if p_decision <> 'signoff' then
    raise exception 'unsupported_decision' using errcode = '22023';
  end if;

  -- ----- SIGNOFF -----
  -- Role resolution: Auditor -> 'A'; Chairperson -> 'O' (acting). Elder is NOT eligible
  -- (its 'O' on audit.approve is the separate drill-in override, not a signature).
  if v_role = 'Auditor' then
    v_perm := 'A';
  elsif v_role = 'Chairperson' then
    v_perm := 'O';
  else
    raise exception 'signer_role_not_eligible' using errcode = '42501';
  end if;

  -- Involvement (independence, not just role): the submitter, or any CAPTURE / SUBMIT /
  -- ACTING_AS_TREASURER / SELF_REVIEW_EXCEPTION participant, is disqualified.
  select (v_period.submitted_by = v_uid)
      or exists (
        select 1 from public.audit_log al
         where al.entity_type = 'cashbook_period'
           and al.entity_id = p_period_id
           and al.user_id = v_uid
           and al.action_type in ('CAPTURE','SUBMIT','ACTING_AS_TREASURER','SELF_REVIEW_EXCEPTION')
      )
    into v_involved;
  if v_involved then
    raise exception 'signer_involved' using errcode = '42501';
  end if;

  -- Count accepted sign-offs already on THIS revision (fresh-revision scoped).
  select count(*) into v_accepted
    from public.cashbook_review_decision d
   where d.period_id = p_period_id
     and d.capture_generation = p_capture_generation
     and d.reviewed_revision = p_reviewed_revision
     and d.decision = 'signoff'
     and d.outcome = 'accepted';

  if v_accepted >= 2 then
    raise exception 'rejected_stale' using errcode = '40001'; -- already completed
  end if;
  v_slot := (v_accepted + 1)::smallint;

  -- Acting-auditor (Chairperson) rules: recorded reason + completing slot only.
  if v_perm = 'O' then
    if p_acting_reason is null or length(btrim(p_acting_reason)) = 0 then
      raise exception 'reason_required' using errcode = '22023';
    end if;
    if v_slot <> 2 then
      raise exception 'acting_not_second_slot' using errcode = '42501';
    end if;
  end if;

  -- Insert the sign-off. cashbook_signoff_one_per_signer raises on a repeat signer
  -- (mapped to already_signed); the whole tx then rolls back.
  begin
    insert into public.cashbook_review_decision
      (period_id, actor_user_id, capture_generation, reviewed_revision, decision, outcome,
       signoff_slot, signoff_perm_code, acting_as_auditor, acting_reason)
    values
      (p_period_id, v_uid, p_capture_generation, p_reviewed_revision, 'signoff', 'accepted',
       v_slot, v_perm, (v_perm = 'O'), p_acting_reason);
  exception when unique_violation then
    raise exception 'already_signed' using errcode = '23505';
  end;

  -- First sign-off: stays Submitted, "1 of 2".
  if v_slot = 1 then
    insert into public.cashbook_op_ledger (op_id, result)
      values (p_decision_op_id,
              jsonb_build_object('status','Submitted','signoffs',1,'payload_fingerprint',p_payload_fingerprint));
    return jsonb_build_object('status','Submitted','signoffs',1,'payload_fingerprint',p_payload_fingerprint);
  end if;

  -- Completing (second) sign-off: the pair must include a real Auditor AND the revision
  -- must be Review_Ready (evidence + balance for THIS exact revision, from the submission
  -- manifest). If either fails, the whole tx rolls back - the second sign-off is NOT
  -- recorded and NO transition happens (succeed-or-fail-together).
  select exists (
      select 1 from public.cashbook_review_decision d
       where d.period_id = p_period_id
         and d.capture_generation = p_capture_generation
         and d.reviewed_revision = p_reviewed_revision
         and d.decision = 'signoff' and d.outcome = 'accepted'
         and d.signoff_perm_code = 'A'
    ) into v_has_auditor;
  if not v_has_auditor then
    raise exception 'needs_auditor_in_pair' using errcode = '42501';
  end if;

  v_ready := public.cashbook_review_ready(p_period_id, p_reviewed_revision);
  if not coalesce(v_ready, false) then
    raise exception 'not_review_ready' using errcode = '42501';
  end if;
  if p_verification is null then
    raise exception 'verification_required' using errcode = '22023';
  end if;

  -- Drive the transition under the GUC the trigger requires. Column-local to this tx.
  perform set_config('cashbook.review_rpc', '1', true);
  update public.cashbook_period
     set status = 'AuditApproved',
         server_revision = server_revision + 1,
         audit_comment = coalesce(p_reason, audit_comment)
   where id = p_period_id;

  update public.cashbook_review_decision
     set completes_approval = true
   where period_id = p_period_id
     and capture_generation = p_capture_generation
     and reviewed_revision = p_reviewed_revision
     and actor_user_id = v_uid
     and decision = 'signoff';

  insert into public.audit_log (user_id, action_type, entity_type, entity_id, comment)
  values (v_uid, 'AUDIT_APPROVE', 'cashbook_period', p_period_id,
          coalesce(p_reason, 'Second sign-off - approved'));

  -- A Chairperson acting-auditor sign-off is an audited self-review exception (steering #6).
  if v_perm = 'O' then
    insert into public.audit_log (user_id, action_type, entity_type, entity_id, assumed_role, comment)
    values (v_uid, 'SELF_REVIEW_EXCEPTION', 'cashbook_period', p_period_id, 'Auditor', p_acting_reason);
  end if;

  insert into public.cashbook_op_ledger (op_id, result)
    values (p_decision_op_id,
            jsonb_build_object('status','AuditApproved','signoffs',2,'payload_fingerprint',p_payload_fingerprint));
  return jsonb_build_object('status','AuditApproved','signoffs',2,'payload_fingerprint',p_payload_fingerprint);
end $$;

-- Authority stays with the owner-defined RPC; expose it to authenticated callers only.
revoke all on function public.cashbook_review_decision(uuid,uuid,int,text,int,text,boolean,text,text,jsonb) from public;
grant execute on function public.cashbook_review_decision(uuid,uuid,int,text,int,text,boolean,text,text,jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- NEEDS AUTHENTICATED/HOSTED TESTING (cannot be executed locally in this pass):
--  1. Bypass closure: a direct Data-API UPDATE status='AuditApproved' is rejected by
--     trg_guard_audit_approved under a real JWT, while this RPC path succeeds.
--  2. Succeed-or-fail-together: forcing the audit/transition write to fail rolls back the
--     second sign-off too (one transaction).
--  3. No self-approval / no same person twice / involvement: submitter and any
--     CAPTURE/SUBMIT/ACTING_AS_TREASURER/SELF_REVIEW_EXCEPTION participant rejected;
--     the one-per-signer index blocks a repeat signer.
--  4. Chairperson-acted-as-Treasurer role switch is blocked (involvement), acting is
--     Chairperson-only, reason-mandatory, second-slot-only.
--  5. Fresh-revision binding: superseded revision/generation sign-offs do not count after
--     re-submission or HO reopen; history rows are preserved.
--  6. RLS/scope + idempotency: in-scope-only; op_id replay returns the recorded result;
--     competing/stale outcomes recorded.
-- These depend on the spec's Task 2/3 schema (op ledger, submission manifest, revision
-- columns, cashbook_review_ready()) which are themselves authored-not-applied.
-- ============================================================================
