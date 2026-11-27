-- ============================================================================
-- Burial proof exemption: cashbook_review_ready superseded IN PLACE.        *** NOT APPLIED ***
--
-- Spec: .kiro/specs/burial-notice-and-trend (requirement 7, design 6.2).
-- Authored only. Do NOT apply to project cwdyixafvylzgtpsfmwr (pre-production dev/demo backend)
-- without explicit user authorisation. Test first on a disposable stack (supabase start).
--
-- DEPENDS ON: 20261124095000_payment_type_cashbanked.sql and
--             20261124100000_expense_payment_source.sql BOTH APPLIED FIRST. This file is a
--             verbatim copy of that file's section 8 function body with exactly TWO identical
--             edits (the two places that list 'Burial': the balance_rule = 1 legacy branch and the
--             proof_mandatory = true block of the rule-2 path). If Spec 1's migration is not
--             applied, applying this file would replace the 20261105140000 function with a body
--             that references cashbook_period_balance and balance_rule, which would not exist.
--             Never apply this file alone.
--
-- Each edited block changes
--     and li.item_type in ('EFT','DirectDebit','Burial','Expense')
-- into
--     and li.section is distinct from 'Burial'
--     and li.item_type in ('EFT','DirectDebit','Expense')
-- Keyed on section because markCashBanked rewrites item_type to CashBanked on banked Burial
-- lines (src/db/captureRepo.ts), so an item_type-only filter is not stable. IS DISTINCT FROM
-- keeps a NULL section on the old behaviour (still checked).
-- Everything else (stale revision, manifest balanced, live balance re-check, forced Expense proof,
-- slip amount check, proof_mandatory short circuit, deposit-slip rules) is unchanged. Burial CASH
-- still needs the deposit slip; only the per-line attachment is waived.
-- Same signature, same security settings; CREATE OR REPLACE keeps the existing grants.
--
-- Check: scripts compare this body to Spec 1's body; the diff must show exactly two changed
-- blocks (tasks T13). Needs disposable-stack testing (design 16, integration cases 9 and 9b).
-- ============================================================================
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
  v_bal       jsonb;
begin
  select * into v_period from public.cashbook_period where id = p_period_id;
  if not found then
    return false;
  end if;
  if v_period.server_revision is distinct from p_reviewed_revision then
    return false;
  end if;

  select * into v_manifest from public.cashbook_submission_manifest
   where period_id = p_period_id
     and capture_generation = v_period.capture_generation
     and revision = p_reviewed_revision;
  if not found then
    return false;
  end if;
  if not v_manifest.balanced then
    return false;
  end if;

  -- (D17) A manifest frozen under the legacy rule (balance_rule = 1) keeps the exact
  -- 20261105140000 semantics: no live balance re-check, no always-on expense proof, no
  -- slip-amount comparison. Verbatim copy of that function's tail.
  if v_manifest.balance_rule = 1 then
    select coalesce(cs.proof_mandatory, false) into v_mandatory
      from public.congregation_settings cs
      where cs.congregation_id = v_period.congregation_id;
    if not coalesce(v_mandatory, false) then
      return true;
    end if;
    if exists (
      select 1 from public.cashbook_line_item li
      where li.period_id = p_period_id
        -- Burial exempt (Spec 2): key on section, never item_type (markCashBanked rewrites item_type)
        and li.section is distinct from 'Burial'
        and li.item_type in ('EFT','DirectDebit','Expense')
        and not exists (select 1 from public.cashbook_attachment a where a.line_item_id = li.id)
    ) then
      return false;
    end if;
    if exists (
      select 1 from public.cashbook_line_item li
      where li.period_id = p_period_id
        and li.item_type in ('Cash','CashPending','CashBanked')
    ) and not exists (
      select 1 from public.cashbook_deposit_slip_period dsp where dsp.period_id = p_period_id
    ) then
      return false;
    end if;
    return true;
  end if;

  -- (i) live re-check of the balance rule (balance_rule = 2 manifests only).
  v_bal := public.cashbook_period_balance(p_period_id);
  if not coalesce((v_bal ->> 'balanced')::boolean, false) then
    return false;
  end if;

  -- (ii) expense proof is always required.
  if exists (
    select 1 from public.cashbook_line_item li
    where li.period_id = p_period_id
      and li.section = 'Expenses'
      and not exists (select 1 from public.cashbook_attachment a where a.line_item_id = li.id)
  ) then
    return false;
  end if;

  -- (iv) slip amount, when recorded, must match the covered periods' net deposits.
  if exists (
    select 1
      from public.cashbook_deposit_slip_period dsp
      join public.cashbook_deposit_slip s on s.id = dsp.slip_id
     where dsp.period_id = p_period_id
       and s.amount is not null
       and round(s.amount, 2) <> round((
             select coalesce(sum((public.cashbook_period_balance(d2.period_id) ->> 'net_deposit')::numeric), 0)
               from public.cashbook_deposit_slip_period d2
              where d2.slip_id = s.id), 2)
  ) then
    return false;
  end if;

  select coalesce(cs.proof_mandatory, false) into v_mandatory
    from public.congregation_settings cs
    where cs.congregation_id = v_period.congregation_id;

  if not coalesce(v_mandatory, false) then
    return true;
  end if;

  -- proof_mandatory = true -------------------------------------------------------------
  if exists (
    select 1 from public.cashbook_line_item li
    where li.period_id = p_period_id
      -- Burial exempt (Spec 2): key on section, never item_type (markCashBanked rewrites item_type)
      and li.section is distinct from 'Burial'
      and li.item_type in ('EFT','DirectDebit','Expense')
      and not exists (select 1 from public.cashbook_attachment a where a.line_item_id = li.id)
  ) then
    return false;
  end if;

  -- (iii) deposit slip required only when something is actually deposited.
  if coalesce((v_bal ->> 'net_deposit')::numeric, 0) > 0
     and not exists (
       select 1 from public.cashbook_deposit_slip_period dsp where dsp.period_id = p_period_id
     ) then
    return false;
  end if;

  return true;
end $$;

-- END - NOT APPLIED.