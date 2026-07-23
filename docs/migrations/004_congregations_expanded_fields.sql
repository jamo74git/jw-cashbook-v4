-- ═══════════════════════════════════════════════════════════════════════════════
-- MIGRATION 004: Expand congregations table with property and admin fields
-- Run this in Supabase SQL Editor
-- ═══════════════════════════════════════════════════════════════════════════════

-- Add new columns to congregations table
ALTER TABLE public.congregations
  ADD COLUMN IF NOT EXISTS property_status TEXT DEFAULT 'unknown' CHECK (property_status IN ('owned', 'leased', 'unknown')),
  ADD COLUMN IF NOT EXISTS water_meter_number TEXT,
  ADD COLUMN IF NOT EXISTS electricity_meter_number TEXT,
  ADD COLUMN IF NOT EXISTS admin_elder_id UUID REFERENCES public.officers(id),
  ADD COLUMN IF NOT EXISTS physical_address TEXT,
  ADD COLUMN IF NOT EXISTS contact_number TEXT,
  ADD COLUMN IF NOT EXISTS gps_location TEXT,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_by UUID REFERENCES auth.users(id);

-- Grant permissions (in case they're missing)
GRANT ALL ON public.congregations TO service_role;
GRANT ALL ON public.congregations TO authenticated;

-- Done! Verify:
-- SELECT id, name, code, property_status, water_meter_number, electricity_meter_number, admin_elder_id
-- FROM congregations LIMIT 5;
