-- ============================================================================
-- Expense categories: per-line category columns + DHO/HO-managed category configuration.
--                                                           *** NOT APPLIED ***
--
-- Spec: .kiro/specs/expense-payment-source (requirement 10; design 27).
-- AUTHORED ONLY. Do NOT run against the dev/demo backend cwdyixafvylzgtpsfmwr. Apply only to a
-- disposable stack or an explicitly named disposable project, after the SQL tests pass.
-- This file has never been parsed by Postgres. UNVERIFIED until task T27.
--
-- ORDER: sorts AFTER 20261124100000_expense_payment_source.sql (the line table changes) and AFTER
-- 20261124110000_scope_notice.sql, whose shared helpers it REUSES and does not copy:
--   public.scope_resolve_district(level, id, allowed[])   (scope shape, 22023)
--   public.scope_assert_ho(actor, district)                (HO authority, 42501)
--   public.scope_district_readable(district)               (read rule, any role)
-- It must not be applied unless 20261124110000 has been applied first. No DROP of any table;
-- section 2 uses DROP CONSTRAINT IF EXISTS on a constraint this file creates (the USER runs it in
-- the SQL Editor if the IDE cancels it; see PROJECT-LOG.md).
--
-- Model: a category list is a set of 1 to 8 named categories at ONE scope (District or Apostleship).
-- 'Other' is built in: it is never stored in the configuration, cannot be renamed or removed, and the
-- client always offers it last. When 'Other' is chosen a short description is required.
-- Each expense line stores the category LABEL as a snapshot (expense_category), so renaming or
-- retiring a configured category later never changes a past line. The server checks the label's
-- FORMAT, not its membership in the current list, because an offline device may capture a line against
-- a list that was replaced before the line syncs.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. cashbook_line_item: category columns. NULL on every existing row ("Uncategorised") and on every
--    non-Expenses row. Old clients that do not send them keep working.
-- ---------------------------------------------------------------------------
alter table public.cashbook_line_item
  add column if not exists expense_category       text,
  add column if not exists expense_category_other text;

-- ---------------------------------------------------------------------------
-- 2. CHECK. Either both NULL, or an Expenses row with a trimmed label (1-40 characters, no control
--    characters). The label 'Other' (exact) needs a trimmed description of 1-60 characters with no
--    control characters; any other label needs the description to be NULL. Trim set: space, tab, CR, LF.
--    "is not null" guards stop a NULL inside the expression from letting a bad row pass.
-- ---------------------------------------------------------------------------
alter table public.cashbook_line_item
  drop constraint if exists cashbook_line_item_expense_category_check;
alter table public.cashbook_line_item
  add constraint cashbook_line_item_expense_category_check check (
    (expense_category is null and expense_category_other is null)
    or (
      section = 'Expenses'
      and expense_category is not null
      and expense_category = btrim(expense_category, E' \t\r\n')
      and char_length(expense_category) between 1 and 40
      and expense_category !~ '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]'
      and (
        (expense_category = 'Other'
           and expense_category_other is not null
           and expense_category_other = btrim(expense_category_other, E' \t\r\n')
           and char_length(expense_category_other) between 1 and 60
           and expense_category_other !~ '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]')
        or (expense_category <> 'Other' and expense_category_other is null)
      )
    )
  );

-- ---------------------------------------------------------------------------
-- 3. Configuration table. One row per category per scope. Writes only through the two
--    service_role-only functions below (called from admin-write after its HO gate).
-- ---------------------------------------------------------------------------
create table if not exists public.expense_category_config (
  id          uuid primary key default gen_random_uuid(),
  scope_level text not null check (scope_level in ('District','Apostleship')),
  scope_id    uuid not null references public.hierarchy_levels(id),
  district_id uuid not null references public.hierarchy_levels(id),
  label       text not null,
  sort_order  smallint not null check (sort_order between 1 and 8),
  is_active   boolean not null default true,
  retired_at  timestamptz,
  retired_by  uuid references auth.users(id),
  created_by  uuid not null references auth.users(id),
  created_at  timestamptz not null default now(),
  constraint expense_category_config_label_ck
    check (label = btrim(label, E' \t\r\n') and char_length(label) between 1 and 40
           and label !~ '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]' and lower(label) <> 'other'),
  constraint expense_category_config_retired_ck
    check ((is_active and retired_at is null) or (not is_active and retired_at is not null))
);

create unique index if not exists expense_category_config_label_uidx
  on public.expense_category_config (scope_level, scope_id, lower(label)) where is_active;
create unique index if not exists expense_category_config_order_uidx
  on public.expense_category_config (scope_level, scope_id, sort_order) where is_active;
create index if not exists expense_category_config_district_idx
  on public.expense_category_config (district_id) where is_active;

alter table public.expense_category_config enable row level security;
revoke all on public.expense_category_config from anon, authenticated;
grant select on public.expense_category_config to authenticated;

do $$
begin
  if not exists (select 1 from pg_policies
                  where schemaname = 'public' and tablename = 'expense_category_config'
                    and policyname = 'expense_category_config_select') then
    create policy expense_category_config_select on public.expense_category_config
      for select to authenticated
      using (is_active and public.scope_district_readable(district_id));   -- every role, same rule as notices
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 4. expense_category_publish: replace the list at one scope, atomically.
--    p_labels is a JSON array of 1 to 8 strings in display order. The scope's current active rows are
--    retired (history kept) and the new rows inserted in one transaction. There is no date range and
--    no conflict prompt: the HO screen loads the current list and edits it.
--    Errors: 42501 forbidden (403), 22023 validation (400).
-- ---------------------------------------------------------------------------
create or replace function public.expense_category_publish(
  p_actor uuid, p_scope_level text, p_scope_id uuid, p_labels jsonb
) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare
  v_district uuid;
  v_n        int;
  v_item     record;
  v_label    text;
  v_seen     text[] := '{}';
  v_retired  int;
begin
  perform public.scope_assert_ho(p_actor, null);

  if p_labels is null or jsonb_typeof(p_labels) <> 'array' then
    raise exception 'validation: labels' using errcode = '22023'; end if;
  v_n := jsonb_array_length(p_labels);
  if v_n not between 1 and 8 then
    raise exception 'validation: between 1 and 8 categories' using errcode = '22023'; end if;
  for v_item in select e, ord from jsonb_array_elements(p_labels) with ordinality as t(e, ord) loop
    if jsonb_typeof(v_item.e) <> 'string' then
      raise exception 'validation: label type' using errcode = '22023'; end if;
    v_label := btrim(v_item.e #>> '{}', E' \t\r\n');
    if char_length(v_label) not between 1 and 40 then
      raise exception 'validation: label length' using errcode = '22023'; end if;
    if v_label ~ '[\x01-\x08\x0B\x0C\x0E-\x1F\x7F]' then
      raise exception 'validation: label control characters' using errcode = '22023'; end if;
    if lower(v_label) = 'other' then
      raise exception 'validation: Other is built in' using errcode = '22023'; end if;
    if lower(v_label) = any (v_seen) then
      raise exception 'validation: duplicate label' using errcode = '22023'; end if;
    v_seen := v_seen || lower(v_label);
  end loop;

  v_district := public.scope_resolve_district(p_scope_level, p_scope_id, array['District','Apostleship']);
  perform public.scope_assert_ho(p_actor, v_district);
  perform pg_advisory_xact_lock(hashtext('expense_category:' || p_scope_level || ':' || p_scope_id::text));

  update public.expense_category_config
     set is_active = false, retired_at = now(), retired_by = p_actor
   where scope_level = p_scope_level and scope_id = p_scope_id and is_active;
  get diagnostics v_retired = row_count;

  insert into public.expense_category_config
    (scope_level, scope_id, district_id, label, sort_order, created_by)
  select p_scope_level, p_scope_id, v_district, btrim(t.e #>> '{}', E' \t\r\n'), t.ord::smallint, p_actor
    from jsonb_array_elements(p_labels) with ordinality as t(e, ord);

  return jsonb_build_object('ok', true, 'count', v_n, 'retired', v_retired);
end $$;

revoke all on function public.expense_category_publish(uuid,text,uuid,jsonb) from public, anon, authenticated;
grant execute on function public.expense_category_publish(uuid,text,uuid,jsonb) to service_role;

-- ---------------------------------------------------------------------------
-- 5. expense_category_clear: retire the list at one scope, so congregations fall back to the next
--    broader list or to the built-in default. Idempotent (nothing active returns retired = 0).
-- ---------------------------------------------------------------------------
create or replace function public.expense_category_clear(
  p_actor uuid, p_scope_level text, p_scope_id uuid
) returns jsonb
language plpgsql security definer set search_path to '' as $$
declare
  v_district uuid;
  v_retired  int;
begin
  perform public.scope_assert_ho(p_actor, null);
  v_district := public.scope_resolve_district(p_scope_level, p_scope_id, array['District','Apostleship']);
  perform public.scope_assert_ho(p_actor, v_district);
  perform pg_advisory_xact_lock(hashtext('expense_category:' || p_scope_level || ':' || p_scope_id::text));
  update public.expense_category_config
     set is_active = false, retired_at = now(), retired_by = p_actor
   where scope_level = p_scope_level and scope_id = p_scope_id and is_active;
  get diagnostics v_retired = row_count;
  return jsonb_build_object('ok', true, 'retired', v_retired);
end $$;

revoke all on function public.expense_category_clear(uuid,text,uuid) from public, anon, authenticated;
grant execute on function public.expense_category_clear(uuid,text,uuid) to service_role;

-- ============================================================================
-- NEEDS DISPOSABLE-STACK TESTING (supabase/tests/expense_category.test.sql, design 27.8):
--  1. authenticated cannot INSERT/UPDATE/DELETE expense_category_config, cannot execute either function.
--  2. Line CHECK: ('Other', NULL) rejected; ('Other','  ') rejected; ('Other', 61 chars) rejected;
--     ('Other', E'a\x01b') rejected; ('Maintenance', 'x') rejected; (NULL,'x') rejected; a Members row
--     with a category rejected; ('Maintenance', NULL) and ('Other','Gas bottle') accepted; an existing
--     Expenses row with both NULL still updates.
--  3. Publish: 0 labels, 9 labels, 'other' / 'OTHER', duplicate (case-insensitive), 41 characters,
--     control character, non-string element each raise 22023 and write nothing; 6 labels succeed;
--     a second publish retires the first six (is_active false) and inserts the new list.
--  4. 400 versus 403: Overseership scope raises 22023 (not allowed for categories); a district outside
--     the actor's assignments raises 42501; a non-HO raises 42501.
--  5. Read: a Treasurer, an Elder (Eldership row), a Secretary and an Auditor in the district read the
--     active rows; a user of another district reads none; retired rows are invisible.
--  6. Concurrent publishes at one scope serialise (advisory lock): final state is exactly one list.
-- END - NOT APPLIED.
-- ============================================================================
