-- ═══════════════════════════════════════════════════════════════════════════════
-- OAC WEEK LOGIC + RPC (FINAL)
--
-- OAC WEEK RULES:
--   Week 1 = 2nd Sunday of the month
--   Week 2 = 3rd Sunday
--   Week 3 = 4th Sunday
--   Week 4 = 5th Sunday (or 1st Sunday of next month if only 4 Sundays)
--   Last Week = always 1st Sunday of NEXT month (belongs to current month)
--
-- week_key format: "2026-07-W1" through "2026-07-W5"
-- Lookup: congregation_id + week_key + service (AM/PM)
--
-- Run this ENTIRE script in Supabase SQL Editor.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ─── 1. Add week_key column ─────────────────────────────────────────────────

ALTER TABLE public.cashbook_period ADD COLUMN IF NOT EXISTS week_key TEXT;

-- Backfill existing rows
UPDATE public.cashbook_period
SET week_key = year || '-' || LPAD(month::text, 2, '0') || '-W' || week
WHERE week_key IS NULL;

-- ─── 2. Drop old RPC if exists (different signature) ────────────────────────

DROP FUNCTION IF EXISTS public.get_or_create_period(UUID, INT, INT, INT, TEXT, UUID);
DROP FUNCTION IF EXISTS public.get_or_create_period(UUID, TEXT, TEXT, UUID);

-- ─── 3. Create RPC ──────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION public.get_or_create_period(
  p_congregation_id UUID,
  p_week_key TEXT,
  p_service TEXT,
  p_user_id UUID
)
RETURNS public.cashbook_period
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  result public.cashbook_period;
  v_year INT;
  v_month INT;
  v_week INT;
BEGIN
  -- Parse week_key: "2026-07-W2" → year=2026, month=7, week=2
  v_year := SPLIT_PART(p_week_key, '-', 1)::INT;
  v_month := SPLIT_PART(p_week_key, '-', 2)::INT;
  v_week := REPLACE(SPLIT_PART(p_week_key, '-', 3), 'W', '')::INT;

  -- Try to find existing period
  SELECT * INTO result
  FROM public.cashbook_period
  WHERE congregation_id = p_congregation_id
    AND week_key = p_week_key
    AND service = p_service;

  -- If not found, create it
  IF NOT FOUND THEN
    INSERT INTO public.cashbook_period (
      congregation_id, year, month, week, week_key, service, status, submitted_by
    ) VALUES (
      p_congregation_id, v_year, v_month, v_week, p_week_key, p_service, 'Draft', p_user_id
    )
    RETURNING * INTO result;
  END IF;

  RETURN result;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_or_create_period(UUID, TEXT, TEXT, UUID) TO authenticated;

-- ─── 4. Service CHECK constraint ────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints 
    WHERE table_name = 'cashbook_period' AND constraint_name = 'cashbook_period_service_check'
  ) THEN
    ALTER TABLE public.cashbook_period ADD CONSTRAINT cashbook_period_service_check CHECK (service IN ('AM', 'PM'));
  END IF;
END $$;

-- ─── 5. Grants ──────────────────────────────────────────────────────────────

GRANT SELECT, INSERT, UPDATE, DELETE ON public.cashbook_period TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.cashbook_line_item TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.cashbook_attachment TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.officers TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.congregations TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.hierarchy_levels TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_hierarchy_access TO authenticated;

-- ─── 6. RLS policies (idempotent) ──────────────────────────────────────────

ALTER TABLE public.cashbook_period ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cashbook_line_item ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cashbook_attachment ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.officers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.congregations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hierarchy_levels ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='cashbook_period' AND policyname='Auth all periods') THEN
    EXECUTE 'CREATE POLICY "Auth all periods" ON public.cashbook_period FOR ALL TO authenticated USING (true) WITH CHECK (true)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='cashbook_line_item' AND policyname='Auth all line items') THEN
    EXECUTE 'CREATE POLICY "Auth all line items" ON public.cashbook_line_item FOR ALL TO authenticated USING (true) WITH CHECK (true)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='cashbook_attachment' AND policyname='Auth all attachments') THEN
    EXECUTE 'CREATE POLICY "Auth all attachments" ON public.cashbook_attachment FOR ALL TO authenticated USING (true) WITH CHECK (true)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='officers' AND policyname='Auth read officers') THEN
    EXECUTE 'CREATE POLICY "Auth read officers" ON public.officers FOR SELECT TO authenticated USING (true)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='congregations' AND policyname='Auth read congregations') THEN
    EXECUTE 'CREATE POLICY "Auth read congregations" ON public.congregations FOR SELECT TO authenticated USING (true)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='hierarchy_levels' AND policyname='Auth read hierarchy') THEN
    EXECUTE 'CREATE POLICY "Auth read hierarchy" ON public.hierarchy_levels FOR SELECT TO authenticated USING (true)';
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- DONE.
--
-- OAC Week Example — July 2026 (Sundays: 5, 12, 19, 26 + Aug 2):
--   1st Sun (5 Jul)  = Last week of JUNE    → 2026-06-W4 or W5
--   2nd Sun (12 Jul) = July Week 1          → 2026-07-W1
--   3rd Sun (19 Jul) = July Week 2          → 2026-07-W2
--   4th Sun (26 Jul) = July Week 3          → 2026-07-W3
--   1st Sun (2 Aug)  = July Week 4 (last)   → 2026-07-W4
--
-- Frontend calls:
--   supabase.rpc("get_or_create_period", {
--     p_congregation_id: "...",
--     p_week_key: "2026-07-W2",
--     p_service: "AM",
--     p_user_id: "..."
--   })
-- ═══════════════════════════════════════════════════════════════════════════════
