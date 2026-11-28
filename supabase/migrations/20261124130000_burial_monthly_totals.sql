-- ============================================================================
-- burial_monthly_totals: 24 monthly Burial totals for one congregation.     *** NOT APPLIED ***
--
-- Spec: .kiro/specs/burial-notice-and-trend (requirement 8; design 4.3).
-- Authored only. Do NOT apply to project cwdyixafvylzgtpsfmwr (pre-production dev/demo backend)
-- without explicit user authorisation. Test first on a disposable stack (supabase start).
-- This file has never been parsed by Postgres. UNVERIFIED until task T19.
--
-- Returns aggregates only: (yr, mo, total, period_ids). No line item, receipt number or proof.
-- (Output columns are yr and mo, not year and month, so they cannot clash with cp.year / cp.month
-- inside the plpgsql body; review 2026-11-26 NIT 5.)
-- Authority is ONE active, in-window user_hierarchy_access row, either:
--   (a) role Treasurer, Chairperson or Elder with congregation_id = p_congregation_id (the Tranche 4
--       role-and-congregation-on-one-row pattern), or
--   (b) role Elder, scope_level 'Eldership', hierarchy_id = the congregation's eldership_id. Verified
--       read-only on the dev/demo backend (2026-11-27): the Elder access row has congregation_id NULL
--       and hierarchy_id equal to congregations.eldership_id, so (b) is the branch that applies to a
--       real Elder. User decision 2026-11-27: the Elder sees the trend (totals only).
-- Secretary, Auditor and every other role get no rows.
-- Invalid arguments (NULL congregation, month outside 1-12, year outside 2000-2100) return NO ROWS and
-- raise nothing (design 10, integration case 8d).
-- Burial is identified by section = 'Burial' (never item_type: markCashBanked rewrites item_type).
-- Draft and Rejected periods are excluded.
--
-- VERIFIED read-only 2026-11-27: user_hierarchy_access.start_date is timestamptz; Elder rows use the
-- Eldership scope (see above). DEPENDS-ON-UNVERIFIED: end_date type; cashbook_line_item.amount and period_id column names; period_status enum literals.
-- No DROP statements in this file.
-- ============================================================================

create or replace function public.burial_monthly_totals(
  p_congregation_id uuid, p_end_year int, p_end_month int
)
returns table (yr int, mo int, total numeric, period_ids uuid[])
language plpgsql stable security definer set search_path to '' as $$
begin
  -- argument validation: return no rows (not an error) so the client simply hides the chart
  if p_congregation_id is null or p_end_year is null or p_end_month is null
     or p_end_month not between 1 and 12 or p_end_year not between 2000 and 2100 then
    return;
  end if;

  -- role and congregation (or Elder eldership) on the SAME access row (F22); no get_my_hierarchy_ids() dependency
  if not exists (select 1 from public.user_hierarchy_access uha
                  where uha.user_id = (select auth.uid())
                    and uha.status = 'active'
                    and uha.start_date <= now()
                    and (uha.end_date is null or uha.end_date >= now())
                    and (
                         (uha.congregation_id = p_congregation_id
                          and uha.role in ('Treasurer','Chairperson','Elder'))
                         or (uha.role = 'Elder' and uha.scope_level = 'Eldership'
                             and uha.hierarchy_id = (select c.eldership_id from public.congregations c
                                                      where c.id = p_congregation_id))
                        )) then
    return;
  end if;

  return query
  with win as (   -- 24 contiguous months: the 12 ending at (end_year, end_month) and the 12 before
    select extract(year from d)::int as y, extract(month from d)::int as m
      from generate_series(
             (make_date(p_end_year, p_end_month, 1) - interval '23 months')::date::timestamp,
             make_date(p_end_year, p_end_month, 1)::timestamp,
             interval '1 month') d
  )
  select cp.year::int, cp.month::int, coalesce(sum(li.amount), 0)::numeric, array_agg(distinct cp.id)
    from public.cashbook_period cp
    join win on win.y = cp.year and win.m = cp.month
    join public.cashbook_line_item li on li.period_id = cp.id and li.section = 'Burial'
   where cp.congregation_id = p_congregation_id
     and cp.status not in ('Draft','Rejected')
   group by cp.year, cp.month;
end $$;

revoke all on function public.burial_monthly_totals(uuid,int,int) from public, anon;
grant execute on function public.burial_monthly_totals(uuid,int,int) to authenticated;

-- ============================================================================
-- NEEDS DISPOSABLE-STACK TESTING (design 16 cases 8, 8b, 8c, 8d):
--  8.  period_ids lists exactly the periods making up total; banked Burial lines (item_type CashBanked)
--      are counted; Draft and Rejected excluded.
--  8b. Treasurer at A plus Auditor at B: call for B returns no rows; call for A returns rows.
--  8c. Elder with an Eldership row covering A (congregation_id NULL) gets rows for A and none for a
--      congregation under another eldership. Secretary and Auditor return no rows.
--  8d. month 0, month 13, year 1999, year 2101, NULL arguments: no rows and no error.
--  Output columns are already yr and mo; the body qualifies cp.year / cp.month / win.y / win.m.
--  Confirm the generate_series(timestamp, timestamp, interval) overload resolves.
-- END - NOT APPLIED.
-- ============================================================================
