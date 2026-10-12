-- ═══════════════════════════════════════════════════════════════════════════════
-- MIGRATION 010: Census breakdown fields (Phase B)
-- Run this in Supabase SQL Editor
-- ADDITIVE ONLY — adds breakdown columns to the census stub tables created in 009.
-- No CREATE TABLE, no RLS change. Idempotent (ADD COLUMN IF NOT EXISTS); safe to re-run.
-- NOTE: Phase B census writes are Dexie-local; these columns exist for schema parity.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ─── census_congregation: souls breakdown + provenance ────────────────────────
ALTER TABLE public.census_congregation
  ADD COLUMN IF NOT EXISTS families INTEGER,
  ADD COLUMN IF NOT EXISTS contact_points INTEGER,
  ADD COLUMN IF NOT EXISTS total_souls INTEGER,
  ADD COLUMN IF NOT EXISTS adults INTEGER,
  ADD COLUMN IF NOT EXISTS children_0_15 INTEGER,
  ADD COLUMN IF NOT EXISTS unconfirmed_youth INTEGER,
  ADD COLUMN IF NOT EXISTS confirmed_youth INTEGER,
  ADD COLUMN IF NOT EXISTS seniors INTEGER,
  ADD COLUMN IF NOT EXISTS mem_breakdown JSONB,
  ADD COLUMN IF NOT EXISTS source TEXT;

COMMENT ON COLUMN public.census_congregation.total_souls
  IS 'Total souls; must equal adults + children_0_15 + unconfirmed_youth + confirmed_youth + seniors (balancing rule)';
COMMENT ON COLUMN public.census_congregation.mem_breakdown
  IS 'Free-form MEM breakdown payload captured from the overseership upload';
COMMENT ON COLUMN public.census_congregation.source
  IS 'Provenance of the row: ''upload'' (overseership CSV/Excel) or ''manual'' (chair edit)';

-- ─── census_priestship: per-priestship split metrics ──────────────────────────
ALTER TABLE public.census_priestship
  ADD COLUMN IF NOT EXISTS families INTEGER,
  ADD COLUMN IF NOT EXISTS contact_points INTEGER,
  ADD COLUMN IF NOT EXISTS souls INTEGER;

COMMENT ON COLUMN public.census_priestship.souls
  IS 'Souls allocated to this priestship; the sum across priestships must equal the congregation total (balancing rule)';

-- Done! Verify:
-- SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'census_congregation'
--   AND column_name IN ('families','contact_points','total_souls','adults','children_0_15',
--                        'unconfirmed_youth','confirmed_youth','seniors','mem_breakdown','source');
-- SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'census_priestship'
--   AND column_name IN ('families','contact_points','souls');
