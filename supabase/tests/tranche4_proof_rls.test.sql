-- ============================================================================
-- Tranche 4 (round 2) - EFFECTIVE proof-access RLS tests   ***  UNEXECUTED  ***
--
-- STATUS: NOT RUN. Requires a disposable LOCAL Supabase stack (`supabase start`, Docker)
-- or an explicitly identified disposable test project. Docker is unavailable here, so
-- these assertions have NOT been executed and are NOT server-security verification until
-- run with the Tranche 4 migration applied. Do NOT run against cwdyixafvylzgtpsfmwr.
--
-- Round-2 assertion repairs:
--  * A denied UPDATE/DELETE matches ZERO rows under RLS and completes WITHOUT an
--    exception. We therefore assert the AFFECTED ROW COUNT (do_write returns it), not the
--    absence of an error. INSERT WITH CHECK denial raises 42501 (returned as -1).
--  * POSITIVE CONTROLS: the same identity first performs a PERMITTED op (count > 0) so a
--    later 0/-1 is genuine RLS, not a missing grant (42501 is ambiguous on its own).
--  * Mismatch tests seed valid parents + role contexts (incl. a valid period in B for the
--    Auditor) so each case isolates the INTENDED denial.
--  * NOTE: raw storage.objects fixtures exercise DB metadata policies only; they do NOT
--    upload real bytes or prove Storage API integrity (R06 byte-verify needs the API).
--  * Fixtures are created in dependency order for the actual baseline schema. Confirm the
--    disposable env runs migrations (incl. this file) before this script (supabase db reset).
-- ============================================================================
begin;

-- ---- Fixtures (dependency order) -------------------------------------------
insert into public.congregations (id, name, district_id) values
  ('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa','Cong A','ddddddd1-0000-0000-0000-000000000000'),
  ('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb','Cong B','ddddddd2-0000-0000-0000-000000000000')
  on conflict do nothing;

insert into auth.users (id, email) values
  ('10000000-0000-0000-0000-000000000001','t@x'),   -- Treasurer@A + Auditor@B
  ('10000000-0000-0000-0000-000000000002','s@x'),   -- Secretary@B only
  ('10000000-0000-0000-0000-000000000004','h@x'),   -- HO: role + assignment (A district)
  ('10000000-0000-0000-0000-000000000006','hbad@x'),-- HO assignment, NO HO role
  ('10000000-0000-0000-0000-000000000007','hbad2@x')-- HO role, NO assignment
  on conflict do nothing;

insert into public.user_hierarchy_access (user_id, role, scope_level, congregation_id, hierarchy_id, status, start_date, end_date) values
  ('10000000-0000-0000-0000-000000000001','Treasurer','Congregation','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',null,'active', now()-interval '1 day', null),
  ('10000000-0000-0000-0000-000000000001','Auditor','Congregation','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',null,'active', now()-interval '1 day', null),
  ('10000000-0000-0000-0000-000000000002','Secretary','Congregation','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',null,'active', now()-interval '1 day', null),
  ('10000000-0000-0000-0000-000000000004','HO','District',null,'ddddddd1-0000-0000-0000-000000000000','active', now()-interval '1 day', null),
  ('10000000-0000-0000-0000-000000000007','HO','District',null,'ddddddd1-0000-0000-0000-000000000000','active', now()-interval '1 day', null)
  on conflict do nothing;

insert into public.ho_district_assignments (user_id, district_id) values
  ('10000000-0000-0000-0000-000000000004','ddddddd1-0000-0000-0000-000000000000'),
  ('10000000-0000-0000-0000-000000000006','ddddddd1-0000-0000-0000-000000000000')
  on conflict do nothing;

-- Periods: Draft+Submitted in A, and a valid Draft in B (Auditor positive-read control).
insert into public.cashbook_period (id, congregation_id, year, month, week, service, status, week_key) values
  ('cccccccc-0000-0000-0000-000000000001','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',2026,10,3,'AM','Draft','2026-10-W3'),
  ('cccccccc-0000-0000-0000-000000000002','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',2026,10,3,'PM','Submitted','2026-10-W3'),
  ('cccccccc-0000-0000-0000-00000000000b','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',2026,10,3,'AM','Draft','2026-10-W3')
  on conflict do nothing;

-- Line item + attachment on the Submitted (locked) A period.
insert into public.cashbook_line_item (id, period_id, section, item_type, amount) values
  ('11111111-aaaa-0000-0000-000000000001','cccccccc-0000-0000-0000-000000000002','Expenses','Expense',10),
  ('11111111-aaaa-0000-0000-000000000002','cccccccc-0000-0000-0000-000000000001','Expenses','Expense',5)
  on conflict do nothing;

-- storage.objects fixtures (metadata only). owner = the uploader (Treasurer@A).
insert into storage.objects (bucket_id, name, owner) values
  ('cashbook-proofs','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/2026/10/AM_2026-10-W3/10000000-0000-0000-0000-000000000001/seedA.jpg','10000000-0000-0000-0000-000000000001'),
  ('cashbook-proofs','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/2026/10/PM_2026-10-W3/10000000-0000-0000-0000-000000000001/seedSub.jpg','10000000-0000-0000-0000-000000000001')
  on conflict do nothing;
insert into public.cashbook_attachment (id, line_item_id, file_url, congregation_id) values
  ('22222222-aaaa-0000-0000-000000000001','11111111-aaaa-0000-0000-000000000001','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/2026/10/PM_2026-10-W3/10000000-0000-0000-0000-000000000001/seedSub.jpg','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
  on conflict do nothing;

-- ---- Impersonation + assertion helpers -------------------------------------
create or replace function pg_temp.as_user(uid uuid) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claims', json_build_object('sub', uid::text, 'role', 'authenticated')::text, true);
end $$;

create or replace function pg_temp.as_privileged() returns void language plpgsql as $$
begin perform set_config('role', 'postgres', true); perform set_config('request.jwt.claims', '', true); end $$;

-- Run a write and return the AFFECTED ROW COUNT. An RLS/privilege denial (42501) returns
-- -1. ANY OTHER sqlstate is re-raised so a bad fixture / unique violation / missing object
-- is never silently mistaken for an authorisation result (review requirement).
create or replace function pg_temp.do_write(stmt text) returns int language plpgsql as $$
declare n int;
begin
  execute stmt; get diagnostics n = row_count; return n;
exception when insufficient_privilege then return -1;
end $$;

-- Count rows visible to the CURRENT (authenticated) user under RLS.
create or replace function pg_temp.visible_objects(objname text) returns int language sql stable as $$
  select count(*)::int from storage.objects o where o.bucket_id = 'cashbook-proofs' and o.name = objname;
$$;

create or replace function pg_temp.expect_int(label text, got int, want int) returns void language plpgsql as $$
begin
  if got is distinct from want then raise exception 'FAIL %: got=% want=%', label, got, want; end if;
  raise notice 'PASS % (=%)', label, got;
end $$;

-- Legend for write results: >0 = allowed (n rows); 0 = RLS-filtered (no row changed, no
-- error); -1 = explicit privilege/RLS denial (42501). Positive controls below prove the
-- identity CAN perform a permitted op, so a later 0/-1 is genuine policy behaviour and not
-- a missing grant or invalid fixture.

-- Extra fixtures: a Cong-B object (for cross-congregation reads) and an EXPIRED Treasurer.
select pg_temp.as_privileged();
insert into auth.users (id, email) values ('10000000-0000-0000-0000-000000000008','exp@x') on conflict do nothing;
insert into public.user_hierarchy_access (user_id, role, scope_level, congregation_id, hierarchy_id, status, start_date, end_date) values
  ('10000000-0000-0000-0000-000000000008','Treasurer','Congregation','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',null,'active', now()-interval '60 day', now()-interval '1 day')
  on conflict do nothing;
insert into storage.objects (bucket_id, name, owner) values
  ('cashbook-proofs','bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb/2026/10/AM_2026-10-W3/10000000-0000-0000-0000-000000000001/seedB.jpg','10000000-0000-0000-0000-000000000001')
  on conflict do nothing;

-- ---- SELECT / read permission matrix (effective RLS) -----------------------
do $$
declare
  objA text := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/2026/10/AM_2026-10-W3/10000000-0000-0000-0000-000000000001/seedA.jpg';
  objB text := 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb/2026/10/AM_2026-10-W3/10000000-0000-0000-0000-000000000001/seedB.jpg';
begin
  perform pg_temp.as_user('10000000-0000-0000-0000-000000000001');
  perform pg_temp.expect_int('POS uT reads A', pg_temp.visible_objects(objA), 1);        -- positive control
  perform pg_temp.expect_int('uT (Auditor in B) reads B', pg_temp.visible_objects(objB), 1);

  perform pg_temp.as_user('10000000-0000-0000-0000-000000000002');
  perform pg_temp.expect_int('Secretary-only in B DENIED B', pg_temp.visible_objects(objB), 0);

  perform pg_temp.as_user('10000000-0000-0000-0000-000000000004');
  perform pg_temp.expect_int('POS HO (role+assignment) reads A', pg_temp.visible_objects(objA), 1);

  perform pg_temp.as_user('10000000-0000-0000-0000-000000000006');
  perform pg_temp.expect_int('HO assignment WITHOUT role DENIED A', pg_temp.visible_objects(objA), 0);

  perform pg_temp.as_user('10000000-0000-0000-0000-000000000007');
  perform pg_temp.expect_int('HO role WITHOUT assignment DENIED A', pg_temp.visible_objects(objA), 0);

  perform pg_temp.as_user('10000000-0000-0000-0000-000000000008');
  perform pg_temp.expect_int('EXPIRED access DENIED A', pg_temp.visible_objects(objA), 0);

  perform pg_temp.as_user('99999999-9999-9999-9999-999999999999');
  perform pg_temp.expect_int('Unknown/cross-hierarchy DENIED A', pg_temp.visible_objects(objA), 0);
end $$;

create or replace function pg_temp.expect_denied(label text, got int) returns void language plpgsql as $$
begin
  if got > 0 then raise exception 'FAIL % expected denial, got % row(s)', label, got; end if;
  raise notice 'PASS % (denied, n=%)', label, got;
end $$;

-- Extra objects: a no-reference deletable object, and a referenced object on an EDITABLE
-- period (to isolate the R05 shared-reference guard from the locked-state guard).
select pg_temp.as_privileged();
insert into storage.objects (bucket_id, name, owner) values
  ('cashbook-proofs','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/2026/10/AM_2026-10-W3/10000000-0000-0000-0000-000000000001/seedDel.jpg','10000000-0000-0000-0000-000000000001'),
  ('cashbook-proofs','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/2026/10/AM_2026-10-W3/10000000-0000-0000-0000-000000000001/seedRef.jpg','10000000-0000-0000-0000-000000000001')
  on conflict do nothing;
insert into public.cashbook_attachment (id, line_item_id, file_url, congregation_id) values
  ('22222222-aaaa-0000-0000-000000000002','11111111-aaaa-0000-0000-000000000002','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/2026/10/AM_2026-10-W3/10000000-0000-0000-0000-000000000001/seedRef.jpg','aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
  on conflict do nothing;

-- ---- INSERT (upload) matrix ------------------------------------------------
do $$
declare
  u1 text := '10000000-0000-0000-0000-000000000001';
  okPath text := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/2026/10/AM_2026-10-W3/10000000-0000-0000-0000-000000000001/ins-ok.jpg';
  forged text := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/2026/10/AM_2026-10-W3/99999999-9999-9999-9999-999999999999/ins-forged.jpg';
  malformed text := 'not-a-uuid/x/y/z-proof.jpg';
  wrongWeek text := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/2026/10/AM_2026-10-W4/10000000-0000-0000-0000-000000000001/ins-w4.jpg';
  locked text := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/2026/10/PM_2026-10-W3/10000000-0000-0000-0000-000000000001/ins-locked.jpg';
  toB text := 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb/2026/10/AM_2026-10-W3/10000000-0000-0000-0000-000000000001/ins-b.jpg';
  function_ins text := 'insert into storage.objects(bucket_id,name,owner) values (''cashbook-proofs'',';
begin
  perform pg_temp.as_user(u1);
  perform pg_temp.expect_int('POS uT upload valid Draft A', pg_temp.do_write(function_ins || quote_literal(okPath) || ',auth.uid())'), 1);
  perform pg_temp.expect_int('forged uploader DENY', pg_temp.do_write(function_ins || quote_literal(forged) || ',auth.uid())'), -1);
  perform pg_temp.expect_int('malformed path CONTROLLED deny (not cast crash)', pg_temp.do_write(function_ins || quote_literal(malformed) || ',auth.uid())'), -1);
  perform pg_temp.expect_int('wrong week (no such period) DENY', pg_temp.do_write(function_ins || quote_literal(wrongWeek) || ',auth.uid())'), -1);
  perform pg_temp.expect_int('locked period upload DENY', pg_temp.do_write(function_ins || quote_literal(locked) || ',auth.uid())'), -1);
  perform pg_temp.expect_int('cross-congregation / read-only-in-B upload DENY', pg_temp.do_write(function_ins || quote_literal(toB) || ',auth.uid())'), -1);
end $$;

-- ---- Overwrite + DELETE matrix ---------------------------------------------
do $$
declare
  u1 text := '10000000-0000-0000-0000-000000000001';
  ho text := '10000000-0000-0000-0000-000000000004';
  seedA text := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/2026/10/AM_2026-10-W3/10000000-0000-0000-0000-000000000001/seedA.jpg';
  seedDel text := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/2026/10/AM_2026-10-W3/10000000-0000-0000-0000-000000000001/seedDel.jpg';
  seedRef text := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/2026/10/AM_2026-10-W3/10000000-0000-0000-0000-000000000001/seedRef.jpg';
  seedSub text := 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/2026/10/PM_2026-10-W3/10000000-0000-0000-0000-000000000001/seedSub.jpg';
begin
  perform pg_temp.as_user(u1);
  -- overwrite via UPDATE and upsert are denied (no UPDATE policy on the hyphen bucket)
  perform pg_temp.expect_denied('overwrite via UPDATE', pg_temp.do_write('update storage.objects set owner=auth.uid() where bucket_id=''cashbook-proofs'' and name='|| quote_literal(seedA)));
  perform pg_temp.expect_denied('overwrite via upsert', pg_temp.do_write('insert into storage.objects(bucket_id,name,owner) values (''cashbook-proofs'','|| quote_literal(seedA) ||',auth.uid()) on conflict (bucket_id,name) do update set owner=excluded.owner'));
  -- DELETE: locked (Submitted) denied for capture role AND for HO
  perform pg_temp.expect_denied('uT delete locked proof', pg_temp.do_write('delete from storage.objects where bucket_id=''cashbook-proofs'' and name='|| quote_literal(seedSub)));
  perform pg_temp.as_user(ho);
  perform pg_temp.expect_denied('HO delete locked proof (no exception)', pg_temp.do_write('delete from storage.objects where bucket_id=''cashbook-proofs'' and name='|| quote_literal(seedSub)));
  -- DELETE: editable but still referenced by an attachment -> R05 guard denies
  perform pg_temp.as_user(u1);
  perform pg_temp.expect_denied('delete editable-but-referenced proof (R05)', pg_temp.do_write('delete from storage.objects where bucket_id=''cashbook-proofs'' and name='|| quote_literal(seedRef)));
  -- POS: editable, unreferenced -> ordinary correction allowed (run LAST; removes object)
  perform pg_temp.expect_int('POS uT delete editable unreferenced proof', pg_temp.do_write('delete from storage.objects where bucket_id=''cashbook-proofs'' and name='|| quote_literal(seedDel)), 1);
end $$;

-- ---- Attachment linkage matrix ---------------------------------------------
do $$
declare
  u1 text := '10000000-0000-0000-0000-000000000001';
  okIns text := 'insert into public.cashbook_attachment(line_item_id,file_url,congregation_id) values (''11111111-aaaa-0000-0000-000000000002'',''aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/2026/10/AM_2026-10-W3/10000000-0000-0000-0000-000000000001/seedA.jpg'',''aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'')';
  reparent text := 'insert into public.cashbook_attachment(line_item_id,file_url,congregation_id) values (''11111111-aaaa-0000-0000-000000000002'',''bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb/2026/10/AM_2026-10-W3/10000000-0000-0000-0000-000000000001/seedB.jpg'',''bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'')';
  ghost text := 'insert into public.cashbook_attachment(line_item_id,file_url,congregation_id) values (''11111111-aaaa-0000-0000-000000000002'',''aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/2026/10/AM_2026-10-W3/10000000-0000-0000-0000-000000000001/does-not-exist.jpg'',''aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'')';
begin
  perform pg_temp.as_user(u1);
  perform pg_temp.expect_int('POS linked attachment insert (editable, owned, exact parent)', pg_temp.do_write(okIns), 1);
  perform pg_temp.expect_int('attachment reparent to other congregation/period DENY', pg_temp.do_write(reparent), -1);
  perform pg_temp.expect_int('attachment to nonexistent object DENY', pg_temp.do_write(ghost), -1);
  -- locked-period attachment deletion denied by the restrictive lock
  perform pg_temp.expect_denied('delete attachment on locked period', pg_temp.do_write('delete from public.cashbook_attachment where id=''22222222-aaaa-0000-0000-000000000001'''));
end $$;

select pg_temp.as_privileged();
rollback;  -- tests mutate fixtures only; never commit.
-- ============================================================================
-- END - UNEXECUTED (no disposable Supabase stack / Docker at authoring time).
-- These are metadata-level SQL policy tests. They do NOT upload, retrieve or verify real
-- object BYTES through the Storage API; byte-level duplicate/integrity behaviour (R06) and
-- signed-URL reads must be exercised against a disposable Storage service separately.
-- ============================================================================
