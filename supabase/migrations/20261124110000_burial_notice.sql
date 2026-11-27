-- ============================================================================
-- Burial notice: table, RLS, publish and retire functions.                  *** NOT APPLIED ***
--
-- Spec: .kiro/specs/burial-notice-and-trend (requirements 1, 2, 5, 6; design 4.1, 4.2).
-- Authored only. Do NOT apply to project cwdyixafvylzgtpsfmwr (pre-production dev/demo backend)
-- without explicit user authorisation. Test first on a disposable stack (supabase start).
-- This file has never been parsed by Postgres. UNVERIFIED until task T19.
--
-- DEPENDS-ON-UNVERIFIED (confirm on the stack):
--   * hierarchy_levels.level_type value casing (compared with lower()).
--   * user_hierarchy_access.start_date / end_date column types (compared with now()).
--   * public.get_my_hierarchy_ids() returns congregation ids (verified from migrations) and its
--     role coverage (Overseer, Apostle) is unverified.
--   * hierarchy_levels, congregations(id, district_id), ho_district_assignments(user_id, district_id).
--
-- Writes: ONLY through the two service_role-only functions below, called from the admin-write
-- Edge Function after its HO gate. authenticated has SELECT only (RLS, district scoped).
-- Messages use no real banking details; the default notice text lives in the client.
-- No DROP statements in this file.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Table. Message rules are enforced here as well as in the function:
--    trim set is space, tab, CR, LF (btrim(text) alone trims spaces only), and control
--    characters other than tab, CR and LF are rejected.
-- ---------------------------------------------------------------------------
create table if not exists public.burial_notice (
  id           uuid primary key default gen_random_uuid(),
  scope_level  text not null check (scope_level in ('District','Apostleship','Overseership')),
  scope_id     uuid not null references public.hierarchy_levels(id),
  district_id  uuid not null references public.hierarchy_levels(id),
  message      text not null,
  starts_on    date not null,
  expires_on   date,
  is_active    boolean not null default true,
  retired_at   timestamptz,
  retired_by   uuid references auth.users(id),
  replaced_by  uuid references public.burial_notice(id),
  created_by   uuid not null references auth.users(id),
  updated_by   uuid not null references auth.users(id),
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint burial_notice_message_len_ck
    check (char_length(btrim(message, E' \t\r\n')) between 1 and 1000),
  constraint burial_notice_message_ctrl_ck
    check (message !~ '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]'),
  constraint burial_notice_dates_ck
    check (expires_on is null or expires_on >= starts_on),
  constraint burial_notice_retired_ck
    check ((is_active and retired_at is null) or (not is_active and retired_at is not null))
);

create index if not exists burial_notice_scope_idx
  on public.burial_notice (scope_level, scope_id) where is_active;
create index if not exists burial_notice_district_idx
  on public.burial_notice (district_id) where is_active;

-- ---------------------------------------------------------------------------
-- 2. RLS and grants. No INSERT/UPDATE/DELETE grant or policy exists for authenticated,
--    so the browser cannot write. service_role bypasses RLS.
-- ---------------------------------------------------------------------------
alter table public.burial_notice enable row level security;
revoke all on public.burial_notice from anon, authenticated;
grant select on public.burial_notice to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies
                  where schemaname = 'public' and tablename = 'burial_notice'
                    and policyname = 'burial_notice_select_district') then
    create policy burial_notice_select_district on public.burial_notice
      for select to authenticated
      using (
        is_active
        and (
          district_id in (select c.district_id from public.congregations c
                           where c.id in (select public.get_my_hierarchy_ids()))
          or district_id in (select hda.district_id from public.ho_district_assignments hda
                              where hda.user_id = (select auth.uid()))
        )
      );
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 3. burial_notice_publish: create or edit one notice, atomically.
--    Returns {"conflict": true, "conflicts": [...]} (nothing written) or {"conflict": false, "id": ...}.
--    Errors: 42501 forbidden (HTTP 403), 22023 validation (HTTP 400).
--    p_replace: 'none' | 'retire_conflicts' | 'keep_both'.
-- ---------------------------------------------------------------------------
create or replace function public.burial_notice_publish(
  p_actor uuid, p_id uuid, p_scope_level text, p_scope_id uuid, p_message text,
  p_starts_on date, p_expires_on date, p_replace text
) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare
  v_msg      text := btrim(coalesce(p_message, ''), E' \t\r\n');
  v_node     record;
  v_district uuid;
  v_old      public.burial_notice%rowtype;
  v_changed  boolean := true;
  v_conf     jsonb := '[]'::jsonb;
  v_new_id   uuid;
begin
  -- 1. actor: active, in-window HO District access row
  if p_actor is null or not exists (
       select 1 from public.user_hierarchy_access uha
        where uha.user_id = p_actor and uha.status = 'active'
          and uha.start_date <= now() and (uha.end_date is null or uha.end_date >= now())
          and uha.role = 'HO' and uha.scope_level = 'District') then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- 2. validation (22023 -> HTTP 400)
  if p_replace is null or p_replace not in ('none','retire_conflicts','keep_both') then
    raise exception 'validation: replace' using errcode = '22023'; end if;
  if p_scope_level is null or p_scope_level not in ('District','Apostleship','Overseership') then
    raise exception 'validation: scope_level' using errcode = '22023'; end if;
  if char_length(v_msg) not between 1 and 1000 then
    raise exception 'validation: message length' using errcode = '22023'; end if;
  if v_msg ~ '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]' then
    raise exception 'validation: message control characters' using errcode = '22023'; end if;
  if p_starts_on is null then
    raise exception 'validation: starts_on' using errcode = '22023'; end if;
  if p_expires_on is not null and p_expires_on < p_starts_on then
    raise exception 'validation: expires_on' using errcode = '22023'; end if;
  -- one-day leniency on create (server date is UTC, display date is the device's; requirement 1.3)
  if p_id is null and p_expires_on is not null and p_expires_on < current_date - 1 then
    raise exception 'validation: expires_on in the past' using errcode = '22023'; end if;

  -- 3. scope shape: node exists, level matches, parent chain reaches a District
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
  else   -- Overseership -> Apostleship -> District
    select d.id into v_district
      from public.hierarchy_levels a join public.hierarchy_levels d on d.id = a.parent_id
     where a.id = v_node.parent_id and lower(a.level_type) = 'apostleship'
       and lower(d.level_type) = 'district';
  end if;
  if v_district is null then
    raise exception 'validation: scope chain' using errcode = '22023'; end if;

  -- 4. district authority: assignment row AND in-window HO access row for THIS district (403)
  if not exists (select 1 from public.ho_district_assignments hda
                  where hda.user_id = p_actor and hda.district_id = v_district)
     or not exists (select 1 from public.user_hierarchy_access uha
                     where uha.user_id = p_actor and uha.status = 'active'
                       and uha.start_date <= now() and (uha.end_date is null or uha.end_date >= now())
                       and uha.role = 'HO' and uha.scope_level = 'District'
                       and uha.hierarchy_id = v_district) then
    raise exception 'forbidden' using errcode = '42501';
  end if;

  -- 4b. serialise publishes at one scope for the rest of this transaction so two concurrent
  --     publishes cannot both pass the conflict check (review finding 9). Hash collisions only
  --     cause harmless extra waiting.
  perform pg_advisory_xact_lock(hashtext('burial_notice:' || p_scope_level || ':' || p_scope_id::text));

  -- 5. edit: row exists and is active, same district and same scope
  if p_id is not null then
    select * into v_old from public.burial_notice where id = p_id for update;
    if not found or not v_old.is_active then
      raise exception 'validation: notice not found or retired' using errcode = '22023'; end if;
    if v_old.district_id <> v_district then
      raise exception 'forbidden' using errcode = '42501'; end if;
    if v_old.scope_level <> p_scope_level or v_old.scope_id <> p_scope_id then
      raise exception 'validation: scope cannot change' using errcode = '22023'; end if;
    v_changed := v_old.starts_on is distinct from p_starts_on
              or v_old.expires_on is distinct from p_expires_on;
  end if;

  -- 6. conflicts: overlapping active rows at the same scope (excluding the edited row)
  if v_changed then
    select coalesce(jsonb_agg(jsonb_build_object('id', n.id, 'message', n.message,
             'starts_on', n.starts_on, 'expires_on', n.expires_on) order by n.starts_on, n.id), '[]'::jsonb)
      into v_conf
      from public.burial_notice n
     where n.is_active and n.scope_level = p_scope_level and n.scope_id = p_scope_id
       and (p_id is null or n.id <> p_id)
       and n.starts_on <= coalesce(p_expires_on, 'infinity'::date)
       and coalesce(n.expires_on, 'infinity'::date) >= p_starts_on;
    if jsonb_array_length(v_conf) > 0 and p_replace = 'none' then
      return jsonb_build_object('conflict', true, 'conflicts', v_conf);   -- nothing written
    end if;
  end if;

  -- 7. write (one transaction: a failure anywhere rolls back insert/update and retirements)
  if p_id is null then
    insert into public.burial_notice
      (scope_level, scope_id, district_id, message, starts_on, expires_on, created_by, updated_by)
    values
      (p_scope_level, p_scope_id, v_district, v_msg, p_starts_on, p_expires_on, p_actor, p_actor)
    returning id into v_new_id;
  else
    update public.burial_notice
       set message = v_msg, starts_on = p_starts_on, expires_on = p_expires_on,
           updated_by = p_actor, updated_at = now()
     where id = p_id;
    v_new_id := p_id;
  end if;
  if p_replace = 'retire_conflicts' and jsonb_array_length(v_conf) > 0 then
    update public.burial_notice
       set is_active = false, retired_at = now(), retired_by = p_actor,
           replaced_by = v_new_id, updated_by = p_actor, updated_at = now()
     where id in (select (e ->> 'id')::uuid from jsonb_array_elements(v_conf) e);
  end if;
  return jsonb_build_object('conflict', false, 'id', v_new_id);
end $$;

revoke all on function public.burial_notice_publish(uuid,uuid,text,uuid,text,date,date,text)
  from public, anon, authenticated;
grant execute on function public.burial_notice_publish(uuid,uuid,text,uuid,text,date,date,text)
  to service_role;

-- ---------------------------------------------------------------------------
-- 4. burial_notice_retire: retire one notice. Idempotent: an already-retired id returns
--    {"conflict": false, "id": ..., "already_retired": true} with no write and no error.
-- ---------------------------------------------------------------------------
create or replace function public.burial_notice_retire(p_actor uuid, p_id uuid)
returns jsonb
language plpgsql security definer set search_path to '' as $$
declare v_row public.burial_notice%rowtype;
begin
  if p_actor is null or not exists (
       select 1 from public.user_hierarchy_access uha
        where uha.user_id = p_actor and uha.status = 'active'
          and uha.start_date <= now() and (uha.end_date is null or uha.end_date >= now())
          and uha.role = 'HO' and uha.scope_level = 'District') then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  select * into v_row from public.burial_notice where id = p_id for update;
  if not found then
    raise exception 'validation: notice not found' using errcode = '22023'; end if;
  if not exists (select 1 from public.ho_district_assignments hda
                  where hda.user_id = p_actor and hda.district_id = v_row.district_id)
     or not exists (select 1 from public.user_hierarchy_access uha
                     where uha.user_id = p_actor and uha.status = 'active'
                       and uha.start_date <= now() and (uha.end_date is null or uha.end_date >= now())
                       and uha.role = 'HO' and uha.scope_level = 'District'
                       and uha.hierarchy_id = v_row.district_id) then
    raise exception 'forbidden' using errcode = '42501';
  end if;
  if not v_row.is_active then
    return jsonb_build_object('conflict', false, 'id', p_id, 'already_retired', true);
  end if;
  update public.burial_notice
     set is_active = false, retired_at = now(), retired_by = p_actor,
         updated_by = p_actor, updated_at = now()
   where id = p_id;
  return jsonb_build_object('conflict', false, 'id', p_id);
end $$;

revoke all on function public.burial_notice_retire(uuid,uuid) from public, anon, authenticated;
grant execute on function public.burial_notice_retire(uuid,uuid) to service_role;

-- ============================================================================
-- NEEDS DISPOSABLE-STACK TESTING (supabase/tests/burial_notice_rls.test.sql, design 16 cases 1-7b):
--  1. authenticated cannot INSERT/UPDATE/DELETE burial_notice; cannot execute either function.
--  2. 400 versus 403 split: nonexistent node 22023, other district 42501.
--  3. Message rules: E'\n', E'\t', E'\r\n', spaces only, E'a\x01b' (control char), 1001 chars -> 22023
--     (and the table CHECKs reject the same values on a direct service_role insert).
--  4. Overlap / replace / keep_both / edit rules; retire idempotent.
--  5. Two concurrent publishes at one scope: the second sees the first's row (advisory lock).
-- END - NOT APPLIED.
-- ============================================================================
