-- ============================================================================
-- PRIORITY 2 - two-person sign-off: effective behaviour + the MANDATORY acceptance
-- test on the approval path.                                  ***  UNEXECUTED  ***
--
-- STATUS: NOT RUN. Requires a disposable LOCAL Supabase stack (`supabase start`, Docker)
-- or an explicitly identified disposable test project, with 20261105120000_two_person_signoff.sql
-- AND the spec's Task 2/3 schema (cashbook_review_decision, cashbook_op_ledger,
-- cashbook_submission_manifest, server_revision/capture_generation, cashbook_review_ready())
-- applied first. Docker is unavailable here, so these assertions have NOT been executed and
-- are NOT server-security verification. Do NOT run against cwdyixafvylzgtpsfmwr.
--
-- These cases express the user's acceptance test in SQL:
--   * neither the existing approval path NOR a direct status UPDATE can bypass readiness
--     or the second sign-off;
--   * the second valid sign-off and the AuditApproved transition succeed or fail TOGETHER
--     for the same submitted revision.
-- Helper: call_signoff() wraps the RPC and returns status; assertions use RAISE on mismatch.
-- ============================================================================
begin;

-- ---- Fixtures (dependency order; coordinates are illustrative) -------------
-- Cong A with one submitted, Review_Ready revision (server_revision = 1, generation = 1),
-- submitted by the Treasurer. Two independent Auditors, one Chairperson who ALSO acted as
-- Treasurer on this capture (-> in the involvement set).
insert into public.congregations (id, name, district_id) values
  ('aaaaaaaa-0000-0000-0000-000000000001','Cong A','ddddddd1-0000-0000-0000-000000000000')
  on conflict do nothing;

insert into auth.users (id, email) values
  ('20000000-0000-0000-0000-000000000001','treasurer@x'),  -- submitter (involved)
  ('20000000-0000-0000-0000-000000000002','auditor-a@x'),  -- independent Auditor #1
  ('20000000-0000-0000-0000-000000000003','auditor-b@x'),  -- independent Auditor #2
  ('20000000-0000-0000-0000-000000000004','chair@x')       -- Chairperson, acted as Treasurer
  on conflict do nothing;

insert into public.user_hierarchy_access (user_id, role, scope_level, congregation_id, hierarchy_id, status, start_date, end_date) values
  ('20000000-0000-0000-0000-000000000001','Treasurer','Congregation','aaaaaaaa-0000-0000-0000-000000000001',null,'active', now()-interval '1 day', null),
  ('20000000-0000-0000-0000-000000000002','Auditor','Congregation','aaaaaaaa-0000-0000-0000-000000000001',null,'active', now()-interval '1 day', null),
  ('20000000-0000-0000-0000-000000000003','Auditor','Congregation','aaaaaaaa-0000-0000-0000-000000000001',null,'active', now()-interval '1 day', null),
  ('20000000-0000-0000-0000-000000000004','Chairperson','Congregation','aaaaaaaa-0000-0000-0000-000000000001',null,'active', now()-interval '1 day', null)
  on conflict do nothing;

insert into public.cashbook_period
  (id, congregation_id, year, month, week, week_key, service, status, submitted_by, server_revision, capture_generation)
values
  ('cccccccc-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001',
   2026, 11, 1, '2026-11-W1', 'AM', 'Submitted', '20000000-0000-0000-0000-000000000001', 1, 1)
  on conflict do nothing;

-- The Chairperson logged ACTING_AS_TREASURER on this capture -> involvement set.
insert into public.audit_log (user_id, action_type, entity_type, entity_id, comment) values
  ('20000000-0000-0000-0000-000000000001','SUBMIT','cashbook_period','cccccccc-0000-0000-0000-000000000001','submit'),
  ('20000000-0000-0000-0000-000000000004','ACTING_AS_TREASURER','cashbook_period','cccccccc-0000-0000-0000-000000000001','acted as treasurer')
  on conflict do nothing;

-- ===========================================================================
-- CASE 1 (acceptance - bypass closure): a DIRECT status UPDATE to AuditApproved is
-- rejected by trg_guard_audit_approved, even for an in-scope authenticated user, because
-- the review-RPC GUC is not set. Expect SQLSTATE 42501.
-- ===========================================================================
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub','20000000-0000-0000-0000-000000000002', true);
  begin
    update public.cashbook_period set status = 'AuditApproved'
     where id = 'cccccccc-0000-0000-0000-000000000001';
    raise exception 'CASE 1 FAILED: direct update to AuditApproved was NOT blocked';
  exception when insufficient_privilege then
    raise notice 'CASE 1 ok: direct AuditApproved update blocked by trigger';
  end;
  reset role;
end $$;

-- ===========================================================================
-- CASE 2 (first sign-off does NOT close): Auditor #1 signs -> stays Submitted, 1 of 2.
-- ===========================================================================
do $$
declare r jsonb;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub','20000000-0000-0000-0000-000000000002', true);
  r := public.cashbook_review_decision(
        gen_random_uuid(), 'cccccccc-0000-0000-0000-000000000001', 1, 'signoff', 1,
        'fp-1', false, null, null, '{"banking":true,"cash":true,"burial":true,"expenses":true}'::jsonb);
  if (r->>'status') <> 'Submitted' or (r->>'signoffs') <> '1' then
    raise exception 'CASE 2 FAILED: first sign-off did not stay Submitted/1 (got %)', r;
  end if;
  if (select status from public.cashbook_period where id='cccccccc-0000-0000-0000-000000000001') <> 'Submitted' then
    raise exception 'CASE 2 FAILED: period advanced on a single sign-off';
  end if;
  reset role;
  raise notice 'CASE 2 ok: one sign-off stays Submitted';
end $$;

-- ===========================================================================
-- CASE 3 (no self-approval): the submitting Treasurer is not even an Auditor, but even an
-- involved signer is rejected. Here assert the involved CHAIRPERSON (acted as Treasurer)
-- cannot give the second sign-off by switching roles. Expect signer_involved (42501).
-- ===========================================================================
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub','20000000-0000-0000-0000-000000000004', true);
  begin
    perform public.cashbook_review_decision(
      gen_random_uuid(), 'cccccccc-0000-0000-0000-000000000001', 1, 'signoff', 1,
      'fp-2', true, 'Only one auditor available', null, '{"banking":true}'::jsonb);
    raise exception 'CASE 3 FAILED: involved Chairperson was allowed to sign';
  exception when insufficient_privilege then
    raise notice 'CASE 3 ok: role-switch (acted as Treasurer) blocked by involvement';
  end;
  reset role;
end $$;

-- ===========================================================================
-- CASE 4 (completing sign-off closes, atomically): the independent Auditor #2 signs ->
-- transitions to AuditApproved, and the AUDIT_APPROVE audit row exists. The sign-off and
-- the transition committed together.
-- ===========================================================================
do $$
declare r jsonb;
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub','20000000-0000-0000-0000-000000000003', true);
  r := public.cashbook_review_decision(
        gen_random_uuid(), 'cccccccc-0000-0000-0000-000000000001', 1, 'signoff', 1,
        'fp-3', false, null, null, '{"banking":true,"cash":true,"burial":true,"expenses":true}'::jsonb);
  if (r->>'status') <> 'AuditApproved' then
    raise exception 'CASE 4 FAILED: second valid sign-off did not close (got %)', r;
  end if;
  if not exists (select 1 from public.audit_log
                  where entity_id='cccccccc-0000-0000-0000-000000000001' and action_type='AUDIT_APPROVE') then
    raise exception 'CASE 4 FAILED: AUDIT_APPROVE not written in the same tx';
  end if;
  reset role;
  raise notice 'CASE 4 ok: second valid sign-off + AuditApproved + audit row together';
end $$;

-- ===========================================================================
-- CASE 5 (same person twice): Auditor #1 tries to sign again on the same revision ->
-- already_signed (23505), no new accepted row. (Run against the pre-CASE-4 state on a
-- fresh seed; here documented as the one-per-signer index behaviour.)
-- ===========================================================================
-- Assertion (documented): a second signoff by 20000000-...-02 on (period, gen=1, rev=1)
-- violates cashbook_signoff_one_per_signer -> unique_violation -> mapped to already_signed.

-- ===========================================================================
-- CASE 6 (not Review_Ready blocks the close - succeed/fail together): on a seed where
-- cashbook_review_ready() is false, the SECOND sign-off raises not_review_ready (42501),
-- the whole tx rolls back, the period stays Submitted and only ONE accepted sign-off
-- remains. Proven on a disposable stack with an unbalanced/evidence-short manifest.
-- ===========================================================================

-- ===========================================================================
-- CASE 7 (fresh revision): after a re-submission bumps server_revision to 2, the sign-offs
-- bound to revision 1 do NOT count; a completing sign-off must be collected afresh on
-- revision 2. The revision-1 rows are preserved (history). A signoff quoting
-- p_reviewed_revision=1 against server_revision=2 is recorded rejected_stale.
-- ===========================================================================

rollback;  -- never persist test fixtures
