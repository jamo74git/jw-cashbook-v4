-- ═══════════════════════════════════════════════════════════════════════════════
-- MIGRATION 008: Treasurer/Chair dashboard flags on congregation_settings
-- Run this in Supabase SQL Editor
-- Additive only — the congregation_settings table already exists (keyed by
-- congregation_id). We only ADD columns; no CREATE TABLE, no RLS changes.
-- ═══════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.congregation_settings
  ADD COLUMN IF NOT EXISTS hall_capacity INTEGER,
  ADD COLUMN IF NOT EXISTS allow_treasurer_census BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS allow_treasurer_new_members BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS allow_treasurer_baptisms BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS last_census_verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

COMMENT ON COLUMN public.congregation_settings.hall_capacity
  IS 'Nullable hall seating capacity (used for future attendance % calculations)';
COMMENT ON COLUMN public.congregation_settings.allow_treasurer_census
  IS 'When true, the Treasurer may capture Census; otherwise it is Chairperson-managed';
COMMENT ON COLUMN public.congregation_settings.allow_treasurer_new_members
  IS 'When true, the Treasurer may capture New Members; otherwise Chairperson-managed';
COMMENT ON COLUMN public.congregation_settings.allow_treasurer_baptisms
  IS 'When true, the Treasurer may capture First Sunday Stats/baptisms; otherwise Chairperson-managed';

-- Grants (in case missing) — RLS policies already exist (see migration_settings_rls.sql).
GRANT SELECT, INSERT, UPDATE ON public.congregation_settings TO authenticated;
GRANT ALL ON public.congregation_settings TO service_role;

-- Done! Verify:
-- SELECT congregation_id, hall_capacity, allow_treasurer_census, allow_treasurer_new_members,
--        allow_treasurer_baptisms, last_census_verified_at FROM congregation_settings LIMIT 10;
