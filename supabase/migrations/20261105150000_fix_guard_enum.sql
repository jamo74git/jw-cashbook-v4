-- ============================================================================
-- Corrective migration: enum-safe status guard triggers.
--
-- Bug (found by authenticated UAT): the guard functions in 20261105110000
-- (cashbook_guard_submitted) and 20261105120000 (cashbook_guard_audit_approved)
-- used `coalesce(old.status, '')`, which coerces the '' literal to the
-- public.period_status enum -> "invalid input value for enum public.period_status:
-- \"\"" on EVERY update to cashbook_period, blocking submit / approve / reject.
--
-- Fix: compare with `is distinct from <enum literal>` (no '' cast). Keeps the pinned
-- search_path. CREATE OR REPLACE only -- additive, no drops. Already applied live;
-- this file records the corrected source so a fresh apply is correct.
-- ============================================================================

create or replace function public.cashbook_guard_submitted()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.status = 'Submitted'
     and (old.status is distinct from 'Submitted'::public.period_status)
     and current_setting('cashbook.submit_rpc', true) is distinct from '1' then
    raise exception 'Submitted may only be set via cashbook_submit_period'
      using errcode = '42501';
  end if;
  return new;
end $$;

create or replace function public.cashbook_guard_audit_approved()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.status = 'AuditApproved'
     and (old.status is distinct from 'AuditApproved'::public.period_status)
     and current_setting('cashbook.review_rpc', true) is distinct from '1' then
    raise exception 'AuditApproved may only be set via cashbook_review_decision'
      using errcode = '42501';
  end if;
  return new;
end $$;
