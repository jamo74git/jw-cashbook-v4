-- ═══════════════════════════════════════════════════════════════════════════════
-- MIGRATION 005: Expand officer ranks and add service_status
-- Run this in Supabase SQL Editor
-- ═══════════════════════════════════════════════════════════════════════════════

-- 1. Add new values to the officer_role enum
-- PostgreSQL doesn't allow removing enum values, only adding
ALTER TYPE officer_role ADD VALUE IF NOT EXISTS 'Elder';
ALTER TYPE officer_role ADD VALUE IF NOT EXISTS 'Overseer';
ALTER TYPE officer_role ADD VALUE IF NOT EXISTS 'Evangelist';
ALTER TYPE officer_role ADD VALUE IF NOT EXISTS 'Prophet';
ALTER TYPE officer_role ADD VALUE IF NOT EXISTS 'Apostle';

-- 2. Add service_status column to officers table
ALTER TABLE public.officers
  ADD COLUMN IF NOT EXISTS service_status TEXT DEFAULT 'serving'
    CHECK (service_status IN ('serving', 'resting', 'freedom_of_city'));

-- 3. Set all existing officers to 'serving' by default
UPDATE public.officers SET service_status = 'serving' WHERE service_status IS NULL;

-- 4. Grant service_role full access on officers table (needed for admin API)
GRANT ALL ON public.officers TO service_role;
GRANT ALL ON public.officers TO authenticated;

-- Done! Verify:
-- SELECT DISTINCT rank FROM officers;
-- SELECT service_status, COUNT(*) FROM officers GROUP BY service_status;
