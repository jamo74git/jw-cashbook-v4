-- ============================================================================
-- Widen cashbook_line_item.payment_type CHECK so banked cash can sync
--                                                           *** NOT APPLIED ***
--
-- Spec: .kiro/specs/expense-payment-source/ (design.md section 4.1, decision D8, task T13).
-- AUTHORED ONLY. Do NOT run against the dev/demo backend cwdyixafvylzgtpsfmwr.
-- Apply ONLY to a disposable local stack (`supabase start`, Docker) or an explicitly
-- identified disposable test project, and only after the effective-RLS + integrity suite
-- (supabase/tests/) passes. Applying to the dev/demo backend needs an explicit user
-- authorisation (steering: environment-context.md). Run `supabase db pull` first.
--
-- Sorts BEFORE 20261124100000_expense_payment_source.sql and AFTER
-- 20261105150000_fix_guard_enum.sql. It is the fix for finding F7: the client writes
-- payment_type = 'CashBanked' (src/db/captureRepo.ts markCashBanked) and the live CHECK
-- (EFT, DirectDebit, Cash, Burial, Expense) rejects it with 23514, so banked cash cannot
-- sync today. The balance function in 20261124100000 depends on CashBanked rows reaching
-- the server.
--
-- WIDENING ONLY. NULL stays allowed. Every existing row already satisfies the wider set.
-- The statement contains DROP CONSTRAINT: the USER runs this file in the Supabase SQL
-- Editor, not the agent (the IDE auto-cancels DROP-containing MCP statements, PROJECT-LOG.md).
-- ============================================================================

alter table public.cashbook_line_item
  drop constraint if exists cashbook_line_item_payment_type_check;
alter table public.cashbook_line_item
  add constraint cashbook_line_item_payment_type_check check (
    payment_type = any (array['EFT','DirectDebit','Cash','CashPending','CashBanked','Burial','Expense']::text[])
  );

-- END - NOT APPLIED.
-- ============================================================================
