-- ═══════════════════════════════════════════════════════════════════════════════
-- ALIGN: Proof uploads to new bucket "cashbook_proofs"
-- 
-- Bucket: cashbook_proofs (already created by you in Supabase Dashboard)
-- Path format: {congregation_id}/{year}/{month}/{service_id}/{user_id}/{timestamp}-{filename}
-- 
-- This script:
-- 1. Adds congregation_id to cashbook_attachment (if not already done by Supabase)
-- 2. Grants on cashbook_attachment
-- 3. RLS for cashbook_attachment (congregation-scoped)
-- ═══════════════════════════════════════════════════════════════════════════════

-- 1. Add congregation_id if not exists
ALTER TABLE public.cashbook_attachment ADD COLUMN IF NOT EXISTS congregation_id UUID;

-- 2. Backfill congregation_id for existing rows (from period → congregation)
UPDATE public.cashbook_attachment ca
SET congregation_id = cp.congregation_id
FROM public.cashbook_line_item cli
JOIN public.cashbook_period cp ON cp.id = cli.period_id
WHERE ca.line_item_id = cli.id
  AND ca.congregation_id IS NULL;

-- 3. Grants
GRANT SELECT, INSERT, UPDATE, DELETE ON public.cashbook_attachment TO authenticated;

-- 4. RLS (drop old if exists, create new)
ALTER TABLE public.cashbook_attachment ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  -- Drop old policies if they exist
  IF EXISTS (SELECT 1 FROM pg_policies WHERE tablename='cashbook_attachment' AND policyname='Auth all attachments') THEN
    EXECUTE 'DROP POLICY "Auth all attachments" ON public.cashbook_attachment';
  END IF;
END $$;

-- New scoped policies
CREATE POLICY "Select own congregation attachments"
  ON public.cashbook_attachment FOR SELECT TO authenticated
  USING (
    congregation_id IN (
      SELECT uha.congregation_id FROM public.user_hierarchy_access uha
      WHERE uha.user_id = auth.uid() AND uha.status = 'active'
    )
    OR
    EXISTS (
      SELECT 1 FROM public.user_hierarchy_access uha
      WHERE uha.user_id = auth.uid() AND uha.status = 'active' AND uha.scope_level != 'Congregation'
    )
  );

CREATE POLICY "Insert own congregation attachments"
  ON public.cashbook_attachment FOR INSERT TO authenticated
  WITH CHECK (
    congregation_id IN (
      SELECT uha.congregation_id FROM public.user_hierarchy_access uha
      WHERE uha.user_id = auth.uid() AND uha.status = 'active'
    )
    OR
    EXISTS (
      SELECT 1 FROM public.user_hierarchy_access uha
      WHERE uha.user_id = auth.uid() AND uha.status = 'active' AND uha.scope_level != 'Congregation'
    )
  );

-- ═══════════════════════════════════════════════════════════════════════════════
-- DONE. Frontend must now:
-- 1. Upload to bucket "cashbook_proofs" (not "burial_proofs")
-- 2. Use path: {congregation_id}/{year}/{month}/{period.service}_{period.week_key}/{user_id}/{timestamp}-proof.jpg
-- 3. Insert into cashbook_attachment with congregation_id set
-- ═══════════════════════════════════════════════════════════════════════════════
