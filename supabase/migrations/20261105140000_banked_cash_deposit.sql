-- ============================================================================
-- Banked-cash deposit slips (per-service + combined same-week)   *** NOT APPLIED ***
--
-- Authored for review and for application ONLY in a disposable LOCAL stack
-- (`supabase start`, needs Docker) or an explicitly identified disposable test project.
-- NOT run against the dev/demo backend cwdyixafvylzgtpsfmwr; nothing is deployed in this
-- pass. Run `supabase db pull` first. The effective-RLS + integrity suite (supabase/tests/)
-- MUST pass on a disposable stack before this is applied even to the dev/demo backend.
--
-- Sorts AFTER 20261105130000_tranche4_proof_access.sql. ADDITIVE / NON-DESTRUCTIVE:
-- create table if not exists, create or replace function, create trigger on NEW objects
-- only. It does NOT touch cashbook_attachment, the Tranche 4 path functions/policies, the
-- sign-off RPCs, or the revision columns. cashbook_review_ready(uuid,int) is superseded
-- IN PLACE via `create or replace` (same signature + grants), exactly as the brief asks.
--
-- GOAL: cash collected on a service is accounted for by a deposit slip; a slip may cover
-- ONE service's cash (AM or PM) or be a COMBINED slip covering the AM+PM cash of the SAME
-- week. A server-side same-week safeguard is the authority; the client mirrors it for UX.
-- When a congregation has proof_mandatory = true AND a period contains cash, Review_Ready
-- requires a covering deposit slip; the existing non-cash per-line proof rule is kept.
-- When proof_mandatory = false, ALL proof requirements are skipped (balanced + manifest).
--
-- DEPENDS-ON-UNVERIFIED (reconcile on a disposable stack before any apply, design 12):
-- cashbook_period(id, congregation_id, year, month, week, service, status, server_revision,
-- capture_generation), cashbook_line_item(period_id, item_type), cashbook_attachment,
-- cashbook_submission_manifest, congregation_settings(congregation_id, proof_mandatory),
-- congregations(id), get_my_hierarchy_ids(), user_hierarchy_access. Guarded with
-- IF NOT EXISTS / IF EXISTS so a partial prior state does not hard-fail the reconcile run.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Deposit-slip model (two additive tables).
--    cashbook_deposit_slip: one physical slip, bound to a single (congregation, year,
--    month, week). coverage distinguishes a single-service slip (AM | PM) from a combined
--    one. object_key is a NORMAL per-service proof path (buildProofPath output) so the
--    applied Tranche 4 storage upload/read policies are reused UNCHANGED (first path
--    segment is still the congregation uuid, so proof_path_congregation resolves).
-- ---------------------------------------------------------------------------
create table if not exists public.cashbook_deposit_slip (
  id              uuid primary key default gen_random_uuid(),
  congregation_id uuid    not null references public.congregations(id),
  year            int     not null,
  month           int     not null,
  week            int     not null,
  coverage        text    not null check (coverage in ('AM','PM','Combined')),
  object_key      text    not null,          -- bare object name in cashbook-proofs (per-service path)
  deposit_date    date,
  bank_reference  text,
  amount          numeric(12,2),             -- optional slip total (reconciliation aid)
  created_by      uuid    not null,
  created_at      timestamptz not null default now(),
  -- at most one AM, one PM and one Combined slip per congregation-week:
  constraint cashbook_deposit_slip_week_coverage_uq
    unique (congregation_id, year, month, week, coverage)
);

-- Which period(s) a slip covers. A single-service slip has one row; a Combined slip has
-- two (the AM and the PM period of the SAME week). The same-week safeguard is enforced by
-- the trigger below. on delete cascade keeps coverage consistent with its slip/period.
create table if not exists public.cashbook_deposit_slip_period (
  slip_id   uuid not null references public.cashbook_deposit_slip(id) on delete cascade,
  period_id uuid not null references public.cashbook_period(id)       on delete cascade,
  primary key (slip_id, period_id)
);

-- ---------------------------------------------------------------------------
-- 2. Same-week safeguard (server-side, authoritative). A before insert/update trigger on
--    the coverage table rejects any row whose period does not match the slip's
--    (congregation_id, year, month, week). It also backstops the combined-vs-separate
--    overlap: a Combined slip may not cover a week that already has an AM or PM slip (and
--    vice versa). The unique(congregation,year,month,week,coverage) constraint already
--    blocks duplicate AM/PM/Combined; this closes the overlap a stale/offline race could
--    otherwise create. The client never offers an overlapping option (§4), so this guard
--    is defence-in-depth.
-- ---------------------------------------------------------------------------
create or replace function public.cashbook_deposit_slip_same_week_guard()
returns trigger language plpgsql security definer set search_path to '' as $$
declare
  s record;
  p record;
  v_overlap int;
begin
  select congregation_id, year, month, week, coverage into s
    from public.cashbook_deposit_slip where id = new.slip_id;
  select congregation_id, year, month, week into p
    from public.cashbook_period      where id = new.period_id;

  if s is null or p is null
     or s.congregation_id <> p.congregation_id
     or s.year  <> p.year  or s.month <> p.month or s.week <> p.week then
    raise exception 'deposit slip coverage must stay within the same congregation-week'
      using errcode = '23514';
  end if;

  -- Overlap backstop: a combined slip cannot coexist with a per-service slip for the same
  -- congregation-week, and vice versa.
  if s.coverage = 'Combined' then
    select count(*) into v_overlap from public.cashbook_deposit_slip o
     where o.congregation_id = s.congregation_id and o.year = s.year
       and o.month = s.month and o.week = s.week and o.coverage in ('AM','PM');
  else
    select count(*) into v_overlap from public.cashbook_deposit_slip o
     where o.congregation_id = s.congregation_id and o.year = s.year
       and o.month = s.month and o.week = s.week and o.coverage = 'Combined';
  end if;
  if v_overlap > 0 then
    raise exception 'a week cannot have both a combined and a per-service deposit slip'
      using errcode = '23514';
  end if;

  return new;
end $$;

drop trigger if exists trg_deposit_slip_same_week on public.cashbook_deposit_slip_period;
create trigger trg_deposit_slip_same_week
  before insert or update on public.cashbook_deposit_slip_period
  for each row execute function public.cashbook_deposit_slip_same_week_guard();

-- ---------------------------------------------------------------------------
-- 3. cashbook_review_ready(uuid,int) — superseded IN PLACE. Contract preserved EXACTLY:
--    same name, same argument types (p_period_id uuid, p_reviewed_revision int), same
--    returns boolean, same `language plpgsql security definer set search_path to '' stable`.
--    create or replace keeps the existing grants (authenticated) and the sign-off RPC call
--    site (cashbook_review_decision -> cashbook_review_ready(...)) unchanged.
--
--    Preamble UNCHANGED from 20261105110000 (period exists; server_revision =
--    p_reviewed_revision; manifest row exists for the revision; manifest.balanced). The new
--    logic replaces the single unconditional per-line proof check with a proof_mandatory
--    gate. Fail-closed: any missing/false condition returns false.
-- ---------------------------------------------------------------------------
create or replace function public.cashbook_review_ready(p_period_id uuid, p_reviewed_revision int)
returns boolean
language plpgsql
security definer
set search_path to ''
stable
as $$
declare
  v_period    public.cashbook_period%rowtype;
  v_manifest  public.cashbook_submission_manifest%rowtype;
  v_mandatory boolean;
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

  -- Proof-mandatory gate. A missing congregation_settings row => false (matches the client
  -- captureRepo.getProofMandatory default and the owner intent: proofs optional for
  -- demo/UAT/training until a congregation is switched on). Making proofs mandatory is a
  -- SETTINGS change, not a code change. A reviewer preferring a fail-closed default should
  -- say so and both this COALESCE and the client default flip together (steering #4).
  select coalesce(cs.proof_mandatory, false) into v_mandatory
    from public.congregation_settings cs
    where cs.congregation_id = v_period.congregation_id;

  if not coalesce(v_mandatory, false) then
    return true;   -- proof not mandatory: balanced + manifest only; skip ALL proofs
  end if;

  -- proof_mandatory = true -------------------------------------------------------------

  -- (a) EXISTING non-cash per-line proof requirement, now scoped to the four non-cash
  --     types (CashBanked removed here; cash is handled by the deposit-slip rule in (b)).
  if exists (
    select 1 from public.cashbook_line_item li
    where li.period_id = p_period_id
      and li.item_type in ('EFT','DirectDebit','Burial','Expense')
      and not exists (
        select 1 from public.cashbook_attachment a where a.line_item_id = li.id
      )
  ) then
    return false;
  end if;

  -- (b) NEW: if the period contains cash, require a covering banked-cash deposit slip
  --     (its own single-service slip OR a shared same-week Combined slip). A covering slip
  --     is the EXISTENCE of a cashbook_deposit_slip_period row for this period; a combined
  --     slip has such a row for BOTH the AM and the PM period, so it satisfies both.
  if exists (
    select 1 from public.cashbook_line_item li
    where li.period_id = p_period_id
      and li.item_type in ('Cash','CashPending','CashBanked')
  ) and not exists (
    select 1 from public.cashbook_deposit_slip_period dsp
    where dsp.period_id = p_period_id
  ) then
    return false;
  end if;

  return true;
end $$;

-- ---------------------------------------------------------------------------
-- 4. Fail-closed RLS on the two new tables. Reconciled against the live foundation:
--    scope via get_my_hierarchy_ids() (same function the foundation RLS uses); editable
--    state via cashbook_period.status in ('Draft','Rejected') (same predicate as Tranche
--    4); capture roles via an active, time-valid user_hierarchy_access row with role in
--    ('Elder','Chairperson','Treasurer') (same capture-role set as cashbook_submit_period
--    and proofs_insert_capture). server_revision / capture_generation are read-only here.
-- ---------------------------------------------------------------------------
alter table public.cashbook_deposit_slip        enable row level security;
alter table public.cashbook_deposit_slip_period enable row level security;

-- cashbook_deposit_slip ------------------------------------------------------
-- SELECT: congregation-scoped metadata (image bytes stay governed by Tranche 4's
-- proofs_select_scoped storage policy).
drop policy if exists "deposit_slip_select_scoped" on public.cashbook_deposit_slip;
create policy "deposit_slip_select_scoped" on public.cashbook_deposit_slip
  for select to authenticated
  using ( cashbook_deposit_slip.congregation_id in (select public.get_my_hierarchy_ids()) );

-- INSERT: created_by = caller; the caller holds an active, time-valid capture role in the
-- slip's congregation; and object_key exists in cashbook-proofs owned by the caller
-- (mirrors Tranche 4's object-ownership check). Because object_key is a per-service path
-- for an editable period, reusing a foreign/locked object fails here.
drop policy if exists "deposit_slip_insert_capture" on public.cashbook_deposit_slip;
create policy "deposit_slip_insert_capture" on public.cashbook_deposit_slip
  for insert to authenticated
  with check (
    cashbook_deposit_slip.created_by = (select auth.uid())
    and cashbook_deposit_slip.congregation_id in (select public.get_my_hierarchy_ids())
    and exists (
      select 1 from public.user_hierarchy_access uha
      where uha.user_id = (select auth.uid()) and uha.status = 'active'
        and uha.start_date <= now() and (uha.end_date is null or uha.end_date >= now())
        and uha.congregation_id = cashbook_deposit_slip.congregation_id
        and uha.role in ('Elder','Chairperson','Treasurer')
    )
    and exists (
      select 1 from storage.objects o
      where o.bucket_id = 'cashbook-proofs'
        and o.name = cashbook_deposit_slip.object_key
        and o.owner = (select auth.uid())
    )
  );

-- UPDATE: no policy => denied (slips are immutable once written; a correction deletes +
-- re-creates while editable, matching Tranche 4's "overwrite denied").

-- DELETE: capture-role in the congregation AND no covered period is locked, so evidence for
-- a submitted/approved period can never be removed.
drop policy if exists "deposit_slip_delete_editable" on public.cashbook_deposit_slip;
create policy "deposit_slip_delete_editable" on public.cashbook_deposit_slip
  for delete to authenticated
  using (
    exists (
      select 1 from public.user_hierarchy_access uha
      where uha.user_id = (select auth.uid()) and uha.status = 'active'
        and uha.start_date <= now() and (uha.end_date is null or uha.end_date >= now())
        and uha.congregation_id = cashbook_deposit_slip.congregation_id
        and uha.role in ('Elder','Chairperson','Treasurer')
    )
    and not exists (
      select 1 from public.cashbook_deposit_slip_period dsp
      join public.cashbook_period cp on cp.id = dsp.period_id
      where dsp.slip_id = cashbook_deposit_slip.id
        and cp.status not in ('Draft','Rejected')
    )
  );

-- cashbook_deposit_slip_period ----------------------------------------------
-- SELECT: the parent slip is visible.
drop policy if exists "deposit_slip_period_select_scoped" on public.cashbook_deposit_slip_period;
create policy "deposit_slip_period_select_scoped" on public.cashbook_deposit_slip_period
  for select to authenticated
  using (
    exists (
      select 1 from public.cashbook_deposit_slip s
      where s.id = cashbook_deposit_slip_period.slip_id
        and s.congregation_id in (select public.get_my_hierarchy_ids())
    )
  );

-- INSERT: the parent slip is in a congregation the caller may write (active, time-valid
-- capture role) AND the covered period is editable. The same-week match is enforced by the
-- §2 trigger (defence-in-depth, independent of RLS).
drop policy if exists "deposit_slip_period_insert_capture" on public.cashbook_deposit_slip_period;
create policy "deposit_slip_period_insert_capture" on public.cashbook_deposit_slip_period
  for insert to authenticated
  with check (
    exists (
      select 1 from public.cashbook_deposit_slip s
      join public.user_hierarchy_access uha
        on uha.congregation_id = s.congregation_id
      where s.id = cashbook_deposit_slip_period.slip_id
        and uha.user_id = (select auth.uid()) and uha.status = 'active'
        and uha.start_date <= now() and (uha.end_date is null or uha.end_date >= now())
        and uha.role in ('Elder','Chairperson','Treasurer')
    )
    and exists (
      select 1 from public.cashbook_period cp
      where cp.id = cashbook_deposit_slip_period.period_id
        and cp.status in ('Draft','Rejected')
    )
  );

-- UPDATE: no policy => denied (coverage rows are immutable; delete + re-insert while editable).

-- DELETE: capture-role scoped (via the parent slip's congregation) and only while the
-- covered period is editable.
drop policy if exists "deposit_slip_period_delete_editable" on public.cashbook_deposit_slip_period;
create policy "deposit_slip_period_delete_editable" on public.cashbook_deposit_slip_period
  for delete to authenticated
  using (
    exists (
      select 1 from public.cashbook_deposit_slip s
      join public.user_hierarchy_access uha
        on uha.congregation_id = s.congregation_id
      where s.id = cashbook_deposit_slip_period.slip_id
        and uha.user_id = (select auth.uid()) and uha.status = 'active'
        and uha.start_date <= now() and (uha.end_date is null or uha.end_date >= now())
        and uha.role in ('Elder','Chairperson','Treasurer')
    )
    and exists (
      select 1 from public.cashbook_period cp
      where cp.id = cashbook_deposit_slip_period.period_id
        and cp.status in ('Draft','Rejected')
    )
  );

-- ---------------------------------------------------------------------------
-- 5. Grants. Writes are ordinary authenticated inserts under RLS (consistent with how
--    cashbook_attachment is written during sync) — no new SECURITY DEFINER write RPC. The
--    only definer function added is the same-week guard trigger (and cashbook_review_ready,
--    replaced in place with its grants preserved by create or replace).
-- ---------------------------------------------------------------------------
revoke all on table public.cashbook_deposit_slip        from public, anon;
revoke all on table public.cashbook_deposit_slip_period from public, anon;
grant select, insert, delete on public.cashbook_deposit_slip        to authenticated;
grant select, insert, delete on public.cashbook_deposit_slip_period to authenticated;

revoke all on function public.cashbook_deposit_slip_same_week_guard() from public, anon;

-- ============================================================================
-- NEEDS DISPOSABLE-STACK TESTING (cannot execute locally in this pass):
--  1. cashbook_review_ready: false with no manifest / unbalanced / (mandatory) non-cash
--     evidence-short / (mandatory) cash with no covering slip; true when covered; and
--     balanced-only (true) when proof_mandatory = false.
--  2. Same-week trigger rejects a cross-week coverage row; the unique
--     (congregation,year,month,week,coverage) constraint and the overlap backstop reject
--     combined-vs-service duplication.
--  3. Fail-closed RLS: non-capture / out-of-scope / wrong-congregation callers cannot
--     insert a slip or coverage row; SELECT is congregation-scoped; UPDATE denied; DELETE
--     blocked once a covered period is locked.
--  4. Signature/contract unchanged: cashbook_review_decision's completing sign-off still
--     calls cashbook_review_ready(uuid,int) and compiles on top of the applied foundation.
-- ============================================================================
-- END — NOT APPLIED. Apply only in a disposable local/test environment after
-- `supabase db pull`; gate on the supabase/tests/ effective-policy suite passing.
-- ============================================================================
