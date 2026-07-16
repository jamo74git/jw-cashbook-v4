-- ═══════════════════════════════════════════════════════════════════════════════
-- MIGRATION: Elder Dashboard features
-- Run in Supabase SQL Editor
-- ═══════════════════════════════════════════════════════════════════════════════

-- 1. Add expense threshold to settings
ALTER TABLE public.congregation_settings
  ADD COLUMN IF NOT EXISTS expense_approval_threshold NUMERIC DEFAULT 500;

COMMENT ON COLUMN public.congregation_settings.expense_approval_threshold
  IS 'Amount above which Elder must approve expenses';

-- 2. Add approved flag to line items (for expense approval workflow)
ALTER TABLE public.cashbook_line_item
  ADD COLUMN IF NOT EXISTS approved BOOLEAN DEFAULT false;

-- 3. Update existing settings row with default threshold
UPDATE public.congregation_settings SET expense_approval_threshold = 500 WHERE expense_approval_threshold IS NULL;

-- 4. Grants (ensure authenticated can read settings)
GRANT SELECT, INSERT, UPDATE ON public.congregation_settings TO authenticated;
