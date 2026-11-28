-- ============================================================================
-- Scope notice (notice types Burial and Expenses): table, RLS, shared scope helpers,
-- publish and retire functions.                                               *** NOT APPLIED ***
--
-- Spec: .kiro/specs/burial-notice-and-trend (requirements 1, 2, 5, 6, 11; design 3.11, 4.1, 4.2).
-- ONE generalised mechanism: one table, one notice type key, one publish function, one retire
-- function. The Expenses notice (Spec 1, expense-payment-source) is a second notice_type value, not
-- a second table. The expense category configuration (Spec 1, migration 20261124115000) reuses the
-- read rule (scope_district_readable, section 2) and the two scope helpers (section 3) instead of
-- copying their logic.
--
-- Authored only. Do NOT apply to project cwdyixafvylzgtpsfmwr (pre-production dev/demo backend)
-- without explicit user authorisation. Test first on a disposable stack (supabase start).
-- This file has never been parsed by Postgres. UNVERIFIED until task T19.
-- Renamed from 20261124110000_burial_notice.sql (never applied, so no data or history is affected).
--
-- FACTS read-only on the dev/demo backend (SELECT only, 2026-11-27):
--   * hierarchy_levels.level_type values are title case: District, Apostleship, Overseership, ...
--     (lower() comparison is kept as a safety net).
--   * user_hierarchy_access.start_date is timestamptz (compared with now()).
--   * Congregation-scope access rows carry congregation_id = congregations.id and
--     hierarchy_id = congregations.hierarchy_id (not congregations.id).
--   * An Elder access row is scope_level 'Eldership' with congregation_id NULL and
--     hierarchy_id = congregations.eldership_id.
-- DEPENDS-ON-UNVERIFIED (confirm on the stack):
--   * public.get_my_hierarchy_ids() role coverage (Overseer, Apostle, Secretary, Elder).
--   * hierarchy_levels, congregations(id, district_id, hierarchy_id, eldership_id, overseership_id,
--     apostleship_id), ho_district_assignments(user_id, district_id).
--
-- Writes: ONLY through the service_role-only functions below, called from the admin-write Edge
-- Function after its HO gate. authenticated has SELECT only (RLS).
-- READ RULE (user decision 2026-11-27): every role reads notices, Secretary included. The policy has
-- NO role term; it admits any authenticated user whose access covers a congregation of the notice's
-- district, plus the HO assigned to that district.
-- Messages use no real banking details; the default texts live in the client.
-- No DROP statements in this file.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Table. Message rules are enforced here as well as in the function:
--    trim set is space, tab, CR, LF (btrim(text) alone trims spaces only), and control
--    characters other than tab, CR and LF are rejected.
-- ---------------------------------------------------------------------------
create table if not exists public.scope_notice (
  id           uuid primary key default gen_random_uuid(),
  notice_type  text not null check (notice_type in ('Burial','Expenses')),
  scope_level  text not null check (scope_level in ('District','Apostleship','Overseership')),
  scope_id     uuid not null references public.hierarchy_levels(id),
  district_id  uuid not null references public.hierarchy_levels(id),
  message      text not null,
  starts_on    date not null,
  expires_on   date,
  is_active    boolean not null default true,
  retired_at   timestamptz,
  retired_by   uuid references auth.users(id),
  replaced_by  uuid references public.scope_notice(id),
  created_by   uuid not null references auth.users(id),
  updated_by   uuid not null references auth.users(id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint scope_notice_message_len_ck
    check (char_length(btrim(message, E' \t\r\n')) between 1 and 1000),
  constraint scope_notice_message_ctrl_ck
    check (message !~ '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]'),
  constraint scope_notice_dates_ck
    check (expires_on is null or expires_on >= starts_on),
  constraint scope_notice_retired_ck
    check ((is_active and retired_at is null) or (not is_active and retired_at is not null))
);

create index if not exists scope_notice_scope_idx
  on public.scope_notice (notice_type, scope_level, scope_id) where is_active;
create index if not exists scope_notice_district_idx
  on public.scope_notice (district_id) where is_active;

-- ---------------------------------------------------------------------------
-- 2. RLS and grants. No INSERT/UPDATE/DELETE grant or policy exists for authenticated,
--    so the browser cannot write. service_role bypasses RLS.
--    Read: any role (no role term), through the shared function scope_district_readable. Three ways in,
--    all district based:
--      a. get_my_hierarchy_ids() congregations (existing pattern, verified to return congregation ids);
--      b. the HO assigned to the district;
--      c. any NON-HO active, in-window access row (an HO row with no assignment must see nothing,
--         steering invariant 3) that covers a congregation of the district: the row's
--         congregation_id equals the congregation, or its hierarchy_id equals the congregation's
--         hierarchy, eldership, overseership, apostleship or district id. This is what lets an Elder
--         (Eldership row) and a Secretary read without depending on get_my_hierarchy_ids() coverage.
-- ---------------------------------------------------------------------------
-- The read rule is one shared function, scope_district_readable(district), so the expense category
-- configuration (migration 20261124115000) uses the identical rule instead of a copy.
create or replace function public.scope_district_readable(p_district uuid)
returns boolean
language sql stable security definer set search_path to '' as $$
  select
    p_district in (select c.district_id from public.congregations c
                    where c.id in (select public.get_my_hierarchy_ids()))
    or p_district in (select hda.district_id from public.ho_district_assignments hda
                       where hda.user_id = (select auth.uid()))
    or p_district in (
         select c.district_id
           from public.congregations c
           join public.user_hierarchy_access u
             on u.user_id = (select auth.uid())
            and u.status = 'active'
            and u.start_date <= now()
            and (u.end_date is null or u.end_date >= now())
            and u.role <> 'HO'   -- HO is admitted by branch (b) only, which checks ho_district_assignments
            and (u.congregation_id = c.id
                 or u.hierarchy_id in (c.hierarchy_id, c.eldership_id, c.overseership_id,
                                       c.apostleship_id, c.district_id)))
$$;

revoke all on function public.scope_district_readable(uuid) from public, anon;
grant execute on function public.scope_district_readable(uuid) to authenticated, service_role;

alter table public.scope_notice enable row level security;
revoke all on public.scope_notice from anon, authenticated;
grant select on public.scope_notice to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies
                  where schemaname = 'public' and tablename = 'scope_notice'
                    and policyname = 'scope_notice_select') then
    create policy scope_notice_select on public.scope_notice
      for select to authenticated
      using (is_active and public.scope_district_readable(district_id));
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3. Shared scope helpers. Used by scope_notice_publish below AND by expense_category_publish
--    (migration 20261124115000). service_role only; both raise, so a failure rolls back the caller.
-- 3a. scope_resolve_district: node exists, level matches p_scope_level, p_scope_level is in
--     p_allowed, parent chain reaches a District by the fixed shape (Apostleship under District,
--     Overseership under Apostleship). Returns the district id. 22023 on any failure (HTTP 400).
-- 3b. scope_assert_ho: p_actor holds an active, in-window HO District access row. When p_district
--     is not null it also needs the ho_district_assignments row AND an in-window HO access row with
--     hierarchy_id = p_district (the Tranche 4 rule). 42501 on failure (HTTP 403).
-- ---------------------------------------------------------------------------
create or replace function public.scope_resolve_district(
  p_scope_level text, p_scope_id uuid, p_allowed text[]
) returns uuid
language plpgsql stable security definer set search_path to '' as $$
declare
  v_node     record;
  v_district uuid;
begin
  if p_scope_level is null or p_allowed is null or not (p_scope_level = any (p_allowed)) then
    raise exception 'validation: scope_level' using errcode = '22023'; end if;
  select hl.id, lower(hl.level_type) as lt, hl.parent_id into v_node
    from public.hierarchy_levels hl where hl.id = p_scope_id;
  if not found or v_node.lt <> lower(p_scope_level) then
    raise exception 'validation: scope node' using errcode = '22023'; end if;
  if p_scope_level = 'District' then
    if v_node.parent_id is not null then
      raise exception 'validation: scope chain' using errcode = '22023'; end if;
    v_district := v_node.id;
  elsif p_scope_level = 'Apostleship' then
    select d.id into v_district from public.hierarchy_levels d
     where d.id = v_node.parent_id and lower(d.level_type) = 'district';
  elsif p_scope_level = 'Overseership' then
    select d.id into v_district
      from public.hierarchy_levels a join public.hierarchy_levels d on d.id = a.parent_id
     where a.id = v_node.parent_id and lower(a.level_type) = 'apostleship'
       and lower(d.level_type) = 'district';
  end if;
  if v_district is null then
    raise exception 'validation: scope chain' using errcode = '22023'; end if;
  return v_district;
end $$;

revoke all on function public.scope_resolve_district(text,uuid,text[]) from public, anon, authenticated;
grant execute on function public.scope_resolve_district(text,uuid,text[]) to service_role;

create or replace function public.scope_assert_ho(p_actor uuid, p_district uuid)
returns void
language plpgsql stable security definer set search_path to '' as $$
begin
  if p_actor is null or not exists (
       select 1 from public.user_hierarchy_access uha
        where uha.user_id = p_actor and uha.status = 'active'
          and uha.start_date <= now() and (uha.end_date is null or uha.end_date >= now())
          and uha.role = 'HO' and uha.scope_level = 'District') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if p_district is not null and (
       not exists (select 1 from public.ho_district_assignments hda
                    where hda.user_id = p_actor and hda.district_id = p_district)
       or not exists (select 1 from public.user_hierarchy_access uha
                       where uha.user_id = p_actor and uha.status = 'active'
                         and uha.start_date <= now() and (uha.end_date is null or uha.end_date >= now())
                         and uha.role = 'HO' and uha.scope_level = 'District'
                         and uha.hierarchy_id = p_district)) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
end $$;

revoke all on function public.scope_assert_ho(uuid,uuid) from public, anon, authenticated;
grant execute on function public.scope_assert_ho(uuid,uuid) to service_role;

-- ---------------------------------------------------------------------------
-- 4. scope_notice_publish: create or edit one notice, atomically.
--    Returns {"conflict": true, "conflicts": [...]} (nothing written) or {"conflict": false, "id": ...}.
--    Errors: 42501 forbidden (HTTP 403), 22023 validation (HTTP 400).
--    p_notice_type: 'Burial' | 'Expenses'. A conflict is an overlap at the same TYPE, scope level and
--    scope node: a Burial notice never conflicts with an Expenses notice.
--    p_replace: 'none' | 'retire_conflicts' | 'keep_both'.
-- ---------------------------------------------------------------------------
create or replace function public.scope_notice_publish(
  p_actor uuid, p_id uuid, p_notice_type text, p_scope_level text, p_scope_id uuid, p_message text,
  p_starts_on date, p_expires_on date, p_replace text
) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare
  v_msg      text := btrim(coalesce(p_message, ''), E' \t\r\n');
  v_district uuid;
  v_old      public.scope_notice%rowtype;
  v_changed  boolean := true;
  v_conf     jsonb := '[]'::jsonb;
  v_new_id   uuid;
begin
  -- 1. actor: active, in-window HO District access row (403 first, so a non-HO learns nothing else)
  perform public.scope_assert_ho(p_actor, null);

  -- 2. validation (22023 -> HTTP 400)
  if p_notice_type is null or p_notice_type not in ('Burial','Expenses') then
    raise exception 'validation: notice_type' using errcode = '22023'; end if;
  if p_replace is null or p_replace not in ('none','retire_conflicts','keep_both') then
    raise exception 'validation: replace' using errcode = '22023'; end if;
  if char_length(v_msg) not between 1 and 1000 then
    raise exception 'validation: message length' using errcode = '22023'; end if;
  if v_msg ~ '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]' then
    raise exception 'validation: message control characters' using errcode = '22023'; end if;
  if p_starts_on is null then
    raise exception 'validation: starts_on' using errcode = '22023'; end if;
  if p_expires_on is not null and p_expires_on < p_starts_on then
    raise exception 'validation: expires_on' using errcode = '22023'; end if;
  -- one-day leniency on create (server date is UTC, display date is the device's; requirement 1.3):
  -- an expiry of UTC yesterday is accepted, the UTC day before yesterday is rejected
  if p_id is null and p_expires_on is not null and p_expires_on < current_date - 1 then
    raise exception 'validation: expires_on in the past' using errcode = '22023'; end if;

  -- 3. scope shape (shared helper): node exists, level matches, chain reaches a District
  v_district := public.scope_resolve_district(p_scope_level, p_scope_id,
                  array['District','Apostleship','Overseership']);

  -- 4. district authority (shared helper): assignment row AND in-window HO access row (403)
  perform public.scope_assert_ho(p_actor, v_district);

  -- 4b. serialise publishes at one type and scope for the rest of this transaction so two concurrent
  --     publishes cannot both pass the conflict check (review finding 9). Hash collisions only
  --     cause harmless extra waiting.
  perform pg_advisory_xact_lock(hashtext('scope_notice:' || p_notice_type || ':' || p_scope_level
                                         || ':' || p_scope_id::text));

  -- 5. edit: row exists and is active, same district, same type and same scope
  if p_id is not null then
    select * into v_old from public.scope_notice where id = p_id for update;
    if not found or not v_old.is_active then
      raise exception 'validation: notice not found or retired' using errcode = '22023'; end if;
    if v_old.district_id <> v_district then
      raise exception 'forbidden' using errcode = '42501'; end if;
    if v_old.notice_type <> p_notice_type
       or v_old.scope_level <> p_scope_level or v_old.scope_id <> p_scope_id then
      raise exception 'validation: type and scope cannot change' using errcode = '22023'; end if;
    v_changed := v_old.starts_on is distinct from p_starts_on
              or v_old.expires_on is distinct from p_expires_on;
  end if;

  -- 6. conflicts: overlapping active rows at the same type and scope (excluding the edited row)
  if v_changed then
    select coalesce(jsonb_agg(jsonb_build_object('id', n.id, 'message', n.message,
             'starts_on', n.starts_on, 'expires_on', n.expires_on) order by n.starts_on, n.id), '[]'::jsonb)
      into v_conf
      from public.scope_notice n
     where n.is_active and n.notice_type = p_notice_type
       and n.scope_level = p_scope_level and n.scope_id = p_scope_id
       and (p_id is null or n.id <> p_id)
       and n.starts_on <= coalesce(p_expires_on, 'infinity'::date)
       and coalesce(n.expires_on, 'infinity'::date) >= p_starts_on;
    if jsonb_array_length(v_conf) > 0 and p_replace = 'none' then
      return jsonb_build_object('conflict', true, 'conflicts', v_conf);   -- nothing written
    end if;
  end if;

  -- 7. write (one transaction: a failure anywhere rolls back insert/update and retirements)
  if p_id is null then
    insert into public.scope_notice
      (notice_type, scope_level, scope_id, district_id, message, starts_on, expires_on,
       created_by, updated_by)
    values
      (p_notice_type, p_scope_level, p_scope_id, v_district, v_msg, p_starts_on, p_expires_on,
       p_actor, p_actor)
    returning id into v_new_id;
  else
    update public.scope_notice
       set message = v_msg, starts_on = p_starts_on, expires_on = p_expires_on,
           updated_by = p_actor, updated_at = now()
     where id = p_id;
    v_new_id := p_id;
  end if;
  if p_replace = 'retire_conflicts' and jsonb_array_length(v_conf) > 0 then
    update public.scope_notice
       set is_active = false, retired_at = now(), retired_by = p_actor,
           replaced_by = v_new_id, updated_by = p_actor, updated_at = now()
     where id in (select (e ->> 'id')::uuid from jsonb_array_elements(v_conf) e);
  end if;
  return jsonb_build_object('conflict', false, 'id', v_new_id);
end $$;

revoke all on function public.scope_notice_publish(uuid,uuid,text,text,uuid,text,date,date,text)
  from public, anon, authenticated;
grant execute on function public.scope_notice_publish(uuid,uuid,text,text,uuid,text,date,date,text)
  to service_role;

-- ---------------------------------------------------------------------------
-- 5. scope_notice_retire: retire one notice (any type). Idempotent: an already-retired id returns
--    {"conflict": false, "id": ..., "already_retired": true} with no write and no error.
-- ---------------------------------------------------------------------------
create or replace function public.scope_notice_retire(p_actor uuid, p_id uuid)
returns jsonb
language plpgsql security definer set search_path to '' as $$
declare v_row public.scope_notice%rowtype;
begin
  perform public.scope_assert_ho(p_actor, null);
  select * into v_row from public.scope_notice where id = p_id for update;
  if not found then
    raise exception 'validation: notice not found' using errcode = '22023'; end if;
  perform public.scope_assert_ho(p_actor, v_row.district_id);
  if not v_row.is_active then
    return jsonb_build_object('conflict', false, 'id', p_id, 'already_retired', true);
  end if;
  update public.scope_notice
     set is_active = false, retired_at = now(), retired_by = p_actor,
         updated_by = p_actor, updated_at = now()
   where id = p_id;
  return jsonb_build_object('conflict', false, 'id', p_id);
end $$;

revoke all on function public.scope_notice_retire(uuid,uuid) from public, anon, authenticated;
grant execute on function public.scope_notice_retire(uuid,uuid) to service_role;

-- ============================================================================
-- NEEDS DISPOSABLE-STACK TESTING (supabase/tests/scope_notice_rls.test.sql, design 16 cases 1-7b, 11a-11d):
--  1. authenticated cannot INSERT/UPDATE/DELETE scope_notice; cannot execute any function here.
--  2. 400 versus 403 split: nonexistent node 22023, other district 42501.
--  3. Message rules: E'\n', E'\t', E'\r\n', spaces only, E'a\x01b' (control char), 1001 chars -> 22023
--     (and the table CHECKs reject the same values on a direct service_role insert).
--  4. Overlap / replace / keep_both / edit rules; retire idempotent.
--  5. Two concurrent publishes at one type and scope: the second sees the first's row (advisory lock).
--  6. notice_type: 'Other' raises 22023; a Burial and an Expenses notice at the same scope and dates do
--     not conflict; an edit that changes the type raises 22023.
--  7. Read rule: a Secretary, an Elder (Eldership row), a Treasurer, an Auditor in the district each read
--     the active notice; a user of another district reads none; retired rows are invisible.
--  7b. An HO access row for district D with NO ho_district_assignments row reads zero scope_notice rows
--      and zero expense_category_config rows (invariant 3); with the assignment it reads them.
--  8. Create-date boundary: expires_on = current_date - 1 accepted, current_date - 2 rejected (22023).
-- END - NOT APPLIED.
-- ============================================================================
