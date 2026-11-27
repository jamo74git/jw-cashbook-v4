-- ============================================================================
-- burial_monthly_totals: 24 monthly Burial totals for one congregation.     *** NOT APPLIED ***
--
-- Spec: .kiro/specs/burial-notice-and-trend (requirement 8; design 4.3).
-- Authored only. Do NOT apply to project cwdyixafvylzgtpsfmwr (pre-production dev/demo backend)
-- without explicit user authorisation. Test first on a disposable stack (supabase start).
-- This file has never been parsed by Postgres. UNVERIFIED until task T19.
--
-- Returns aggregates only: (year, month, total, period_ids). No line item, receipt number or proof.
-- Caller must hold an active, in-window Treasurer or Chairperson access row AT THE SAME congregation
-- (role and congregation on ONE user_hierarchy_access row, the Tranche 4 pattern). Elder, Secretary,
-- Auditor and every other role get no rows.
-- Invalid arguments (NULL congregation, month outside 1-12, year outside 2000-2100) return NO ROWS and
-- raise nothing (design 10, integration case 8d).
-- Burial is identified by section = 'Burial' (never item_type: markCashBanked rewrites item_type).
-- Draft and Rejected periods are excluded.
--
-- DEPENDS-ON-UNVERIFIED: user_hierarchy_access.start_date/end_date types and congregation_id on every
-- row; cashbook_line_item.amount and period_id column names; period_status enum literals.
-- No DROP statements in this file.
-- ============================================================================

create or replace function public.burial_monthly_totals(
  p_congregation_id uuid, p_end_year int, p_end_month int
)
returns table (year int, month int, total numeric, period_ids uuid[])
language plpgsql stable security definer set search_path to '' as $$
begin
  -- argument validation: return no rows (not an error) so the client simply hides the chart
  if p_congregation_id is null or p_end_year is null or p_end_month is null
     or p_end_month not between 1 and 12 or p_end_year not between 2000 and 2100 then
    return;
  end if;

  -- role and congregation on the SAME access row (F22); no get_my_hierarchy_ids() dependency
  if not exists (select 1 from public.user_hierarchy_access uha
                  where uha.user_id = (select auth.uid())
                    and uha.status = 'active'
                    and uha.start_date <= now()
                    and (uha.end_date is null or uha.end_date >= now())
                    and uha.congregation_id = p_congregation_id
                    and uha.role in ('Treasurer','Chairperson')) then   -- Elder deliberately excluded
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
--  8c. Elder-only row at A returns no rows. Secretary and Auditor return no rows.
--  8d. month 0, month 13, year 1999, year 2101, NULL arguments: no rows and no error.
--  Also confirm: plpgsql output column names year/month do not clash with the qualified column
--  references (cp.year, cp.month); if they do, alias the output columns (yr, mo) and adjust the client.
--  Confirm the generate_series(timestamp, timestamp, interval) overload resolves.
-- END - NOT APPLIED.
-- ============================================================================
