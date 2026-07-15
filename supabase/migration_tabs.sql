-- ═══════════════════════════════════════════════════════════════════════════════
-- MIGRATION: Tab isolation + Banking tab support
-- Run in Supabase SQL Editor BEFORE testing the new /capture page
-- ═══════════════════════════════════════════════════════════════════════════════

-- 1. Add transaction_date and bank_reference to attachments
ALTER TABLE public.cashbook_attachment ADD COLUMN IF NOT EXISTS transaction_date DATE;
ALTER TABLE public.cashbook_attachment ADD COLUMN IF NOT EXISTS bank_reference TEXT;

-- 2. Add receipt_number to line items (for Burial)
ALTER TABLE public.cashbook_line_item ADD COLUMN IF NOT EXISTS receipt_number TEXT;

-- 3. Add is_officer flag to line items (for tab filtering)
ALTER TABLE public.cashbook_line_item ADD COLUMN IF NOT EXISTS is_officer BOOLEAN NOT NULL DEFAULT false;

-- 4. Update existing seed data: mark Officers section as is_officer=true
UPDATE public.cashbook_line_item SET is_officer = true WHERE section = 'Officers';
UPDATE public.cashbook_line_item SET is_officer = false WHERE section = 'Members';

-- 5. Migrate manual_reference to receipt_number for Burial rows
UPDATE public.cashbook_line_item SET receipt_number = manual_reference WHERE section = 'Burial' AND manual_reference IS NOT NULL;

-- 6. Grants (ensure authenticated can use new columns)
GRANT SELECT, INSERT, UPDATE, DELETE ON public.cashbook_attachment TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.cashbook_line_item TO authenticated;

-- ═══════════════════════════════════════════════════════════════════════════════
-- DONE. New columns: cashbook_attachment.transaction_date, .bank_reference
--                    cashbook_line_item.receipt_number, .is_officer
-- ═══════════════════════════════════════════════════════════════════════════════
