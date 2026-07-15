-- ═══════════════════════════════════════════════════════════════════════════════
-- MIGRATION: Add service_type to cashbook_period
-- Run in Supabase SQL Editor
-- ═══════════════════════════════════════════════════════════════════════════════

-- Note: The column 'service' already exists as TEXT on cashbook_period.
-- We just need to ensure it allows 'AM' and 'PM' values (it already does from seed).
-- No ALTER needed if the column is already TEXT. If you want to add a CHECK constraint:

DO $$
BEGIN
  -- Add check constraint if it doesn't exist
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints 
    WHERE table_name = 'cashbook_period' AND constraint_name = 'cashbook_period_service_check'
  ) THEN
    ALTER TABLE public.cashbook_period ADD CONSTRAINT cashbook_period_service_check CHECK (service IN ('AM', 'PM'));
  END IF;
END $$;

-- Update existing seed data if needed
UPDATE public.cashbook_period SET service = 'AM' WHERE service IS NULL;

-- ═══════════════════════════════════════════════════════════════════════════════
-- DONE. Column 'service' on cashbook_period now enforces AM/PM.
-- ═══════════════════════════════════════════════════════════════════════════════
