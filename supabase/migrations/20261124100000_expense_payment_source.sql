-- ============================================================================
-- Expense payment source + multi-proof metadata + server-authoritative balance
--                                                           *** NOT APPLIED ***
--
-- Spec: .kiro/specs/expense-payment-source/ (requirements.md, design.md, tasks.md).
-- AUTHORED ONLY. Do NOT run against the dev/demo backend cwdyixafvylzgtpsfmwr.
-- Apply ONLY to a disposable local stack (`supabase start`, Docker) or an explicitly
-- identified disposable test project, and only after the effective-RLS + integrity suite
-- (supabase/tests/) passes. Applying to the dev/demo backend needs an explicit user
-- authorisation (steering: environment-context.md). Run `supabase db pull` first.
--
-- Sorts AFTER 20261124095000_payment_type_cashbanked.sql (apply that file first). ADDITIVE and backward compatible with
-- clients that do not know the new columns (the guard trigger fills defaults).
--
-- The IDE auto-cancels DROP-containing MCP statements (PROJECT-LOG.md). Sections 3, 7 and 7a
-- contain DROP CONSTRAINT / DROP TRIGGER IF EXISTS: the USER runs this file in the
-- Supabase SQL Editor, not the agent.
--
-- DEPENDS-ON-UNVERIFIED (reconcile on the disposable stack before any apply):
--  * Other triggers that may already exist on cashbook_line_item (none are in the repo
--    migrations; the live trigger list was not read). The new trigger name sorts after
--    trg_guard_*; confirm firing order on the stack.
--  * RLS on cashbook_line_item for UPDATE of the new column on locked periods (governed by
--    the existing policies; not changed here).
--  * cashbook_line_item.amount precision (live type is plain numeric). Comparisons below
--    use round(...,2).
-- Live facts read 2026-11-24 (read-only): cashbook_line_item has 10 Expense rows, all with
-- officer_id NULL (8 with payment_type 'Expense', 2 with NULL); zero CashBanked rows;
-- payment_type CHECK allows only EFT, DirectDebit, Cash, Burial, Expense; section CHECK
-- allows Members, Officers, Burial, Banking, Expenses; item_type has NO check;
-- cashbook_attachment has no unique constraint on line_item_id but has the unique index
-- cashbook_attachment_line_item_objectkey_uidx (line_item_id, proof_ref_key(file_url)).
--
-- PRE-APPLY IMPACT CHECK (read-only; run it immediately before applying, in the SQL Editor).
-- It lists every period that has Expenses rows, its stored manifest.balanced and what the NEW
-- rule would say. Any row with stored_balanced = true AND new_rule_balanced = false would flip
-- if review_ready used the new rule; section 7a below makes such a manifest keep its
-- old-rule result (decision D17). Result on the dev/demo backend, read-only, 2026-11-24:
-- 7 periods have Expenses (4 Draft, 2 AuditApproved, 1 SubmittedToHO); cashbook_submission_manifest
-- has 0 rows (periods: 14), so no period flips today. Re-run before applying: new manifests may
-- have been created by then.
--
--   with t as (
--     select p.id, p.status, p.capture_generation, p.server_revision,
--       coalesce(sum(li.amount) filter (where li.section in ('Members','Officers','Burial')),0) income,
--       coalesce(sum(li.amount) filter (where li.item_type in ('EFT','DirectDebit')),0)         elec,
--       coalesce(sum(li.amount) filter (where li.item_type = 'CashBanked'),0)                   cb,
--       coalesce(sum(li.amount) filter (where li.item_type = 'CashBanked'
--                                         and li.section in ('Members','Officers')),0)          tcb,
--       coalesce(sum(li.amount) filter (where li.section = 'Expenses'),0)                       exp
--     from public.cashbook_period p join public.cashbook_line_item li on li.period_id = p.id
--     group by p.id, p.status, p.capture_generation, p.server_revision
--     having bool_or(li.section = 'Expenses'))
--   select t.id, t.status::text, m.balanced as stored_balanced,
--          (round(income,2) = round(elec+cb,2) and round(exp,2) <= round(tcb,2)) as new_rule_balanced
--   from t left join public.cashbook_submission_manifest m
--     on m.period_id = t.id and m.capture_generation = t.capture_generation
--    and m.revision = t.server_revision
--   order by 2, 1;
-- (Before this migration every expense is a cash expense, so the inline test above equals the
--  new rule.) The query was run read-only in aggregate form; the id-level form above is [UNVERIFIED].
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. cashbook_line_item.expense_payment_source
--    'CongregationCash' = paid from the congregation's cash collections
--    'OfficerPrepaid'   = pre-paid by an officer (officer_id IS the prepaid officer)
--    NULL for every non-Expenses row. Reuses officer_id (no new FK).
-- ---------------------------------------------------------------------------
alter table public.cashbook_line_item
  add column if not exists expense_payment_source text;

-- Backfill: every existing Expenses row was paid from congregation cash (none has an
-- officer_id; verified read-only 2026-11-24).
update public.cashbook_line_item
   set expense_payment_source = 'CongregationCash'
 where section = 'Expenses' and expense_payment_source is null;

-- ---------------------------------------------------------------------------
-- 2. Guard/normalise trigger. Keeps OLD clients working (null source on an Expenses row
--    becomes 'CongregationCash'; any non-Expenses row is forced to NULL) and enforces that
--    a prepaid officer belongs to the period's congregation and is active. The officer
--    check runs on INSERT, or when officer_id / source change, so later proof-status
--    updates on an old line never fail because an officer was deactivated afterwards.
-- ---------------------------------------------------------------------------
create or replace function public.cashbook_line_item_expense_guard()
returns trigger language plpgsql security definer set search_path to '' as $$
declare
  v_cong uuid;
  v_off  record;
begin
  if new.section = 'Expenses' then
    if new.expense_payment_source is null then
      new.expense_payment_source := 'CongregationCash';
    end if;
    if new.expense_payment_source = 'OfficerPrepaid'
       and (tg_op = 'INSERT'
            or new.officer_id is distinct from old.officer_id
            or new.expense_payment_source is distinct from old.expense_payment_source) then
      if new.officer_id is null then
        raise exception 'a pre-paid expense requires an officer' using errcode = '23514';
      end if;
      select congregation_id into v_cong from public.cashbook_period where id = new.period_id;
      select congregation_id, is_active into v_off from public.officers where id = new.officer_id;
      if v_off is null
         or v_off.congregation_id is distinct from v_cong
         or coalesce(v_off.is_active, false) = false then
        raise exception 'pre-paid officer must be an active officer of the period congregation'
          using errcode = '23514';
      end if;
    end if;
  else
    new.expense_payment_source := null;
  end if;
  return new;
end $$;

revoke all on function public.cashbook_line_item_expense_guard() from public, anon, authenticated;

drop trigger if exists trg_line_item_expense_guard on public.cashbook_line_item;
create trigger trg_line_item_expense_guard
  before insert or update on public.cashbook_line_item
  for each row execute function public.cashbook_line_item_expense_guard();

-- ---------------------------------------------------------------------------
-- 3. Constraint. Exactly one valid source on an Expenses row; prepaid <=> officer present;
--    NULL elsewhere. Added AFTER the backfill and the trigger so it validates immediately.
-- ---------------------------------------------------------------------------
alter table public.cashbook_line_item
  drop constraint if exists cashbook_line_item_expense_source_check;
alter table public.cashbook_line_item
  add constraint cashbook_line_item_expense_source_check check (
    (section = 'Expenses'
       and expense_payment_source in ('CongregationCash','OfficerPrepaid')
       and ((expense_payment_source = 'OfficerPrepaid') = (officer_id is not null)))
    or (section <> 'Expenses' and expense_payment_source is null)
  );

-- ---------------------------------------------------------------------------
-- 4. cashbook_attachment: OCR-ready, optional proof metadata for multi-proof expenses.
--    bank_reference is UNCHANGED and carries the Invoice No. for Expense proofs (label-only
--    change in the client). entry_source lets a later OCR step mark machine-filled fields.
-- ---------------------------------------------------------------------------
alter table public.cashbook_attachment
  add column if not exists supplier_name   text,
  add column if not exists document_amount numeric(12,2),
  add column if not exists entry_source    text not null default 'manual';

alter table public.cashbook_attachment
  drop constraint if exists cashbook_attachment_entry_source_check;
alter table public.cashbook_attachment
  add constraint cashbook_attachment_entry_source_check check (entry_source in ('manual','ocr'));
alter table public.cashbook_attachment
  drop constraint if exists cashbook_attachment_document_amount_check;
alter table public.cashbook_attachment
  add constraint cashbook_attachment_document_amount_check check (document_amount is null or document_amount >= 0);

-- ---------------------------------------------------------------------------
-- 5. (moved) The payment_type CHECK widening (CashPending, CashBanked) now lives in the
--    separate file 20261124095000_payment_type_cashbanked.sql (decision D8). It MUST be
--    applied before this file, because cashbook_period_balance below depends on CashBanked
--    rows reaching the server (finding F7).
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- 6. cashbook_period_balance(period) -> jsonb. THE server-side authority for the balance
--    rule (mirrors src/lib/captureTotals.ts balanceBreakdown). INTERNAL ONLY: executed by
--    other SECURITY DEFINER functions; NOT granted to authenticated (a definer function
--    reading any period would leak cross-congregation totals).
--
--    income_collected  = Members + Officers + Burial lines
--    electronic        = item_type EFT or DirectDebit
--    cash_banked       = item_type CashBanked (gross)
--    tithe_cash_banked = CashBanked in Members/Officers (burial cash excluded: decision D2)
--    cash_pending      = Cash/CashPending/Burial (unbanked) in income sections
--    cash_expenses     = Expenses paid from congregation cash (NULL source = legacy cash)
--    prepaid           = Expenses pre-paid by an officer (never reduces the deposit)
--    net_deposit       = cash_banked - cash_expenses
--    balanced          = income = electronic + cash_banked  AND  cash_expenses <= tithe_cash_banked
-- ---------------------------------------------------------------------------
create or replace function public.cashbook_period_balance(p_period_id uuid)
returns jsonb
language sql
security definer
set search_path to ''
stable
as $$
  with t as (
    select
      coalesce(sum(li.amount) filter (where li.section in ('Members','Officers','Burial')), 0) as income,
      coalesce(sum(li.amount) filter (where li.item_type in ('EFT','DirectDebit')), 0)          as electronic,
      coalesce(sum(li.amount) filter (where li.item_type = 'CashBanked'), 0)                    as cash_banked,
      coalesce(sum(li.amount) filter (where li.item_type = 'CashBanked'
                                        and li.section in ('Members','Officers')), 0)           as tithe_cash_banked,
      coalesce(sum(li.amount) filter (where li.section in ('Members','Officers','Burial')
                                        and li.item_type in ('Cash','CashPending','Burial')), 0) as cash_pending,
      coalesce(sum(li.amount) filter (where li.section = 'Expenses'
                                        and coalesce(li.expense_payment_source,'CongregationCash') = 'CongregationCash'), 0) as cash_expenses,
      coalesce(sum(li.amount) filter (where li.section = 'Expenses'
                                        and li.expense_payment_source = 'OfficerPrepaid'), 0)   as prepaid
    from public.cashbook_line_item li
    where li.period_id = p_period_id
  )
  select jsonb_build_object(
    'income_collected',  round(income, 2),
    'electronic',        round(electronic, 2),
    'cash_banked',       round(cash_banked, 2),
    'tithe_cash_banked', round(tithe_cash_banked, 2),
    'cash_pending',      round(cash_pending, 2),
    'cash_expenses',     round(cash_expenses, 2),
    'prepaid',           round(prepaid, 2),
    'net_deposit',       round(cash_banked - cash_expenses, 2),
    'balanced',          (round(income, 2) = round(electronic + cash_banked, 2)
                          and round(cash_expenses, 2) <= round(tithe_cash_banked, 2))
  ) from t
$$;

revoke all on function public.cashbook_period_balance(uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 7a. cashbook_submission_manifest.balance_rule (decision D17). Which balance rule produced
--     manifest.balanced: 1 = legacy (client flag, old rule income = banked + expenses),
--     2 = this migration (server-computed). Existing rows take the column default 1 at
--     ADD COLUMN time; the default is then set to 2 for new rows (cashbook_submit_period
--     also writes 2 explicitly). cashbook_review_ready (section 8) evaluates a rule-1
--     manifest exactly as 20261105140000 did, so no already-frozen period flips state.
--     A re-submitted period (Rejected -> Submitted) gets a new rule-2 manifest.
--     [UNVERIFIED] any immutability trigger or column grant on the manifest table.
-- ---------------------------------------------------------------------------
alter table public.cashbook_submission_manifest
  add column if not exists balance_rule smallint not null default 1;
alter table public.cashbook_submission_manifest
  alter column balance_rule set default 2;
alter table public.cashbook_submission_manifest
  drop constraint if exists cashbook_submission_manifest_balance_rule_chk;
alter table public.cashbook_submission_manifest
  add constraint cashbook_submission_manifest_balance_rule_chk check (balance_rule in (1, 2));

-- ---------------------------------------------------------------------------
-- 7. cashbook_submit_period: the manifest.balanced flag is now computed SERVER-side from
--    the synced line items. The client p_balanced is kept for the contract (same signature,
--    same grants) and echoed back as client_balanced for diagnostics, but it no longer
--    decides the manifest. Everything else is identical to 20261105110000 section 7.
-- ---------------------------------------------------------------------------
create or replace function public.cashbook_submit_period(
  p_op_id                   uuid,
  p_period_id               uuid,
  p_payload_fingerprint     text,
  p_balanced                boolean,
  p_outstanding_proof_count int         default 0,
  p_manifest                jsonb       default '[]'::jsonb,
  p_submitted_at            timestamptz default null,
  p_requestor_comment       text        default null,
  p_elder_approval_comment  text        default null
) returns jsonb
language plpgsql
security definer
set search_path to ''
as $$
declare
  v_uid        uuid := auth.uid();
  v_role       text;
  v_period     public.cashbook_period%rowtype;
  v_new_rev    integer;
  v_generation integer;
  v_prior      jsonb;
  v_result     jsonb;
  v_balanced   boolean;
begin
  if v_uid is null then
    raise exception 'not_authorised' using errcode = '42501';
  end if;

  select result into v_prior from public.cashbook_op_ledger where op_id = p_op_id;
  if found then
    if (v_prior ->> 'payload_fingerprint') is distinct from p_payload_fingerprint then
      raise exception 'op_id_fingerprint_conflict' using errcode = '40001';
    end if;
    return v_prior;
  end if;

  select * into v_period from public.cashbook_period where id = p_period_id for update;
  if not found then
    raise exception 'period_not_found' using errcode = 'P0002';
  end if;

  select uha.role into v_role
    from public.user_hierarchy_access uha
   where uha.user_id = v_uid
     and uha.status = 'active'
     and uha.start_date <= now()
     and (uha.end_date is null or uha.end_date >= now())
     and uha.role in ('Treasurer','Chairperson','Elder')
     and v_period.congregation_id in (select public.get_my_hierarchy_ids())
   order by case uha.role when 'Treasurer' then 0 when 'Chairperson' then 1 else 2 end
   limit 1;
  if v_role is null then
    raise exception 'not_authorised' using errcode = '42501';
  end if;

  if v_period.status not in ('Draft','Rejected') then
    raise exception 'period_not_submittable' using errcode = '42501';
  end if;

  -- NEW: server-authoritative balance over the SYNCED line items.
  v_balanced := coalesce((public.cashbook_period_balance(p_period_id) ->> 'balanced')::boolean, false);

  perform set_config('cashbook.submit_rpc', '1', true);
  update public.cashbook_period
     set status                 = 'Submitted',
         submitted_by           = v_uid,
         submitted_at           = coalesce(p_submitted_at, now()),
         requestor_comment      = p_requestor_comment,
         elder_approval_comment = p_elder_approval_comment,
         server_revision        = coalesce(server_revision, 0) + 1
   where id = p_period_id
   returning server_revision, capture_generation into v_new_rev, v_generation;

  insert into public.cashbook_submission_manifest
    (period_id, capture_generation, revision, balanced, balance_rule, outstanding_proof_count, proofs, frozen_by)
  values
    (p_period_id, v_generation, v_new_rev, v_balanced, 2,
     coalesce(p_outstanding_proof_count, 0), coalesce(p_manifest, '[]'::jsonb), v_uid)
  on conflict (period_id, capture_generation, revision) do update
    set balanced                = excluded.balanced,
        balance_rule            = excluded.balance_rule,
        outstanding_proof_count = excluded.outstanding_proof_count,
        proofs                  = excluded.proofs,
        frozen_by               = excluded.frozen_by,
        frozen_at               = now();

  insert into public.audit_log (user_id, action_type, entity_type, entity_id, comment)
  values (v_uid, 'SUBMIT', 'cashbook_period', p_period_id,
          coalesce(p_requestor_comment, 'Period submitted for audit'));

  v_result := jsonb_build_object(
    'status', 'Submitted',
    'server_revision', v_new_rev,
    'capture_generation', v_generation,
    'payload_fingerprint', p_payload_fingerprint,
    'balanced', v_balanced,
    'client_balanced', coalesce(p_balanced, false)
  );
  insert into public.cashbook_op_ledger (op_id, result) values (p_op_id, v_result);
  return v_result;
end $$;

-- ---------------------------------------------------------------------------
-- 8. cashbook_review_ready(uuid,int) superseded IN PLACE (same signature/grants). Adds:
--    (i)   live server re-check of the balance rule (defence in depth over manifest.balanced);
--    (ii)  EXPENSE PROOF IS ALWAYS REQUIRED (>= 1 attachment per Expenses line) regardless of
--          proof_mandatory (decision D1);
--    (iii) a deposit slip is required only when the period's net deposit is > 0 (cash fully
--          consumed by cash expenses means nothing to deposit);
--    (iv)  slip.amount, when present, must equal the sum of net deposits of the periods it
--          covers (to the cent).
--    The proof_mandatory gate for EFT/DirectDebit/Burial and the cash-slip rule are
--    otherwise unchanged from 20261105140000.
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
        and li.item_type in ('EFT','DirectDebit','Burial','Expense')
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
      and li.item_type in ('EFT','DirectDebit','Burial','Expense')
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

-- ============================================================================
-- NEEDS DISPOSABLE-STACK TESTING (cannot execute in this pass; see design.md section 18):
--  1. Backfill + CHECK: existing Expenses rows validate; a non-Expenses row cannot carry a
--     source; prepaid requires officer_id; cash expense rejects officer_id.
--  2. Trigger: old-client insert (null source) normalises; prepaid officer from another
--     congregation / inactive officer rejected (23514); proof-status UPDATE on a line whose
--     officer was later deactivated still succeeds.
--  3. cashbook_period_balance golden vectors (design.md Appendix A) match the TypeScript
--     balanceBreakdown vectors.
--  4. cashbook_submit_period stores the SERVER balance (client p_balanced=true on an
--     unbalanced period -> manifest.balanced=false); idempotent replay unchanged.
--  5. cashbook_review_ready: expense with no attachment -> false even when
--     proof_mandatory=false; net_deposit=0 -> no slip needed; slip.amount mismatch -> false.
--  6. cashbook_period_balance is NOT executable by authenticated.
--  6a. (D17) A manifest row with balance_rule = 1 and balanced = true, on a period with a cash
--     expense that the new rule calls unbalanced, is still review-ready (legacy path); the
--     same period re-submitted gets balance_rule = 2 and is judged by the new rule. ADD COLUMN
--     gives existing rows 1 and new rows 2. Seed the check with the PRE-APPLY IMPACT CHECK.
--  7. 20261105150000 guard triggers and the sign-off RPC still compile and pass
--     supabase/tests/two_person_signoff_rls.test.sql.
-- END - NOT APPLIED.
-- ============================================================================
