-- ═══════════════════════════════════════════════════════════════════════════════
-- MIGRATION 007: Expand officers table with additional fields
-- Run this in Supabase SQL Editor
-- ═══════════════════════════════════════════════════════════════════════════════

-- Add new columns
ALTER TABLE public.officers
  ADD COLUMN IF NOT EXISTS initials TEXT,
  ADD COLUMN IF NOT EXISTS mobile_number TEXT,
  ADD COLUMN IF NOT EXISTS start_date DATE DEFAULT CURRENT_DATE,
  ADD COLUMN IF NOT EXISTS end_date DATE;

-- Make surname (last_name) NOT NULL for new inserts going forward
-- (Can't easily make existing NULLs fail, so we set a default for existing)
UPDATE public.officers SET last_name = first_name WHERE last_name IS NULL;

-- Auto-populate initials for existing officers
UPDATE public.officers
SET initials = UPPER(LEFT(first_name, 1)) || '.' || CASE WHEN last_name IS NOT NULL THEN UPPER(LEFT(last_name, 1)) || '.' ELSE '' END
WHERE initials IS NULL;

-- Grants (in case missing)
GRANT ALL ON public.officers TO service_role;
GRANT ALL ON public.officers TO authenticated;

-- Done! Verify:
-- SELECT officer_code, initials, first_name, last_name, mobile_number, start_date, end_date FROM officers LIMIT 10;
