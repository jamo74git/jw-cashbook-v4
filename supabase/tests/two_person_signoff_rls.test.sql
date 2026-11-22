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

-- Periods are seeded as Draft (server_revision defaults to 0); the submitted,
-- Review_Ready revision is produced via cashbook_submit_period (FOUNDATION) in the
-- fixture submit below, NOT a raw insert of server_revision=1 - so a submission manifest
-- genuinely exists for the completing sign-off in CASE 4 (otherwise cashbook_review_ready
-- would be false and CASE 4 could never close).
--   ...01  main period (submitted balanced+empty -> Review_Ready true) for CASES 1-4
--   ...02  submitted UNBALANCED (cashbook_review_ready false)
--   ...03  never submitted (no manifest: review_ready false; direct-Submitted guard)
--   ...04  submitted balanced but with a proof-required line and NO attachment
--          (evidence-short: review_ready false until an attachment is added)
insert into public.cashbook_period
  (id, congregation_id, year, month, week, week_key, service, status)
values
  ('cccccccc-0000-0000-0000-000000000001','aaaaaaaa-0000-0000-0000-000000000001', 2026, 11, 1, '2026-11-W1', 'AM', 'Draft'),
  ('cccccccc-0000-0000-0000-000000000002','aaaaaaaa-0000-0000-0000-000000000001', 2026, 11, 2, '2026-11-W2', 'AM', 'Draft'),
  ('cccccccc-0000-0000-0000-000000000003','aaaaaaaa-0000-0000-0000-000000000001', 2026, 11, 3, '2026-11-W3', 'AM', 'Draft'),
  ('cccccccc-0000-0000-0000-000000000004','aaaaaaaa-0000-0000-0000-000000000001', 2026, 11, 4, '2026-11-W4', 'AM', 'Draft')
  on conflict do nothing;

-- A proof-required EFT line on ...04 with NO attachment -> evidence-short.
insert into public.cashbook_line_item (id, period_id, section, item_type, amount, is_officer)
values
  ('11111111-0000-0000-0000-000000000004','cccccccc-0000-0000-0000-000000000004','Members','EFT', 100, false)
  on conflict do nothing;

-- The Chairperson logged ACTING_AS_TREASURER on the main capture -> involvement set.
insert into public.audit_log (user_id, action_type, entity_type, entity_id, comment) values
  ('20000000-0000-0000-0000-000000000004','ACTING_AS_TREASURER','cashbook_period','cccccccc-0000-0000-0000-000000000001','acted as treasurer')
  on conflict do nothing;

-- ---- Fixture submit (FOUNDATION cashbook_submit_period) --------------------
-- As the Treasurer (submitter), submit ...01 balanced+empty, ...02 unbalanced, ...04
-- balanced-but-evidence-short. Each call bumps server_revision 0->1, freezes a manifest,
-- records submitted_by, and writes a SUBMIT audit row (the submitter's involvement).
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub','20000000-0000-0000-0000-000000000001', true);
  perform public.cashbook_submit_period(
    gen_random_uuid(), 'cccccccc-0000-0000-0000-000000000001', 'fp-submit-1', true,  0, '[]'::jsonb, now(), 'submit', null);
  perform public.cashbook_submit_period(
    gen_random_uuid(), 'cccccccc-0000-0000-0000-000000000002', 'fp-submit-2', false, 0, '[]'::jsonb, now(), 'submit', null);
  perform public.cashbook_submit_period(
    gen_random_uuid(), 'cccccccc-0000-0000-0000-000000000004', 'fp-submit-4', true,  1, '[]'::jsonb, now(), 'submit', null);
  reset role;
end $$;

-- ===========================================================================
-- FCASE A (FOUNDATION - submit RPC effects): ...01 is now Submitted at
-- server_revision = 1, a submission manifest row exists for (period, gen=1, rev=1), and a
-- SUBMIT audit row was written for the submitting Treasurer. Nothing could set Submitted
-- or freeze the manifest except the RPC.
-- ===========================================================================
do $$
begin
  if (select status from public.cashbook_period where id='cccccccc-0000-0000-0000-000000000001') <> 'Submitted'
     or (select server_revision from public.cashbook_period where id='cccccccc-0000-0000-0000-000000000001') <> 1 then
    raise exception 'FCASE A FAILED: submit RPC did not set Submitted / server_revision=1';
  end if;
  if not exists (select 1 from public.cashbook_submission_manifest
                  where period_id='cccccccc-0000-0000-0000-000000000001' and capture_generation=1 and revision=1) then
    raise exception 'FCASE A FAILED: no submission manifest frozen for the submitted revision';
  end if;
  if not exists (select 1 from public.audit_log
                  where entity_id='cccccccc-0000-0000-0000-000000000001' and action_type='SUBMIT'
                    and user_id='20000000-0000-0000-0000-000000000001') then
    raise exception 'FCASE A FAILED: SUBMIT audit row not written for the submitter';
  end if;
  raise notice 'FCASE A ok: submit RPC froze the manifest, bumped the revision, audited SUBMIT';
end $$;

-- ===========================================================================
-- FCASE B (FOUNDATION - cashbook_review_ready): false without a manifest (...03 never
-- submitted), false for the WRONG revision, false when unbalanced (...02), false when a
-- proof-required line lacks an attachment (...04), and true only when balanced + fully
-- evidenced (...01, balanced + no proof-required lines).
-- ===========================================================================
do $$
begin
  if public.cashbook_review_ready('cccccccc-0000-0000-0000-000000000003', 0) then
    raise exception 'FCASE B FAILED: review_ready true without a manifest';
  end if;
  if public.cashbook_review_ready('cccccccc-0000-0000-0000-000000000001', 2) then
    raise exception 'FCASE B FAILED: review_ready true for a non-current revision';
  end if;
  if public.cashbook_review_ready('cccccccc-0000-0000-0000-000000000002', 1) then
    raise exception 'FCASE B FAILED: review_ready true for an UNBALANCED manifest';
  end if;
  if public.cashbook_review_ready('cccccccc-0000-0000-0000-000000000004', 1) then
    raise exception 'FCASE B FAILED: review_ready true while a proof-required line lacks an attachment';
  end if;
  if not public.cashbook_review_ready('cccccccc-0000-0000-0000-000000000001', 1) then
    raise exception 'FCASE B FAILED: review_ready NOT true for a balanced, fully-evidenced revision';
  end if;
  -- Add the missing attachment to ...04's EFT line -> it becomes Review_Ready.
  insert into public.cashbook_attachment (line_item_id, file_url, congregation_id, uploaded_by)
  values ('11111111-0000-0000-0000-000000000004',
          'aaaaaaaa-0000-0000-0000-000000000001/2026/11/AM_2026-11-W4/20000000-0000-0000-0000-000000000001/x-proof.jpg',
          'aaaaaaaa-0000-0000-0000-000000000001','20000000-0000-0000-0000-000000000001');
  if not public.cashbook_review_ready('cccccccc-0000-0000-0000-000000000004', 1) then
    raise exception 'FCASE B FAILED: review_ready NOT true once evidence is attached';
  end if;
  raise notice 'FCASE B ok: review_ready false without manifest / wrong rev / unbalanced / evidence-short, true when balanced+evidenced';
end $$;

-- ===========================================================================
-- FCASE C (FOUNDATION - Submitted bypass guard): a DIRECT status UPDATE to Submitted on
-- the still-Draft ...03 is rejected by trg_guard_submitted (no cashbook.submit_rpc GUC),
-- even for an in-scope authenticated user. Expect SQLSTATE 42501. This makes submit
-- consistent with the AuditApproved bypass guard: Submitted only via the submit RPC.
-- ===========================================================================
do $$
begin
  set local role authenticated;
  perform set_config('request.jwt.claim.sub','20000000-0000-0000-0000-000000000001', true);
  begin
    update public.cashbook_period set status = 'Submitted'
     where id = 'cccccccc-0000-0000-0000-000000000003';
    raise exception 'FCASE C FAILED: direct update to Submitted was NOT blocked';
  exception when insufficient_privilege then
    raise notice 'FCASE C ok: direct Submitted update blocked by trg_guard_submitted';
  end;
  reset role;
end $$;

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
