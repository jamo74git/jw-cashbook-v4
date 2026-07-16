-- ═══════════════════════════════════════════════════════════════════════════════
-- RLS + Grants for congregation_settings
-- Run after the CREATE TABLE statement
-- ═══════════════════════════════════════════════════════════════════════════════

GRANT SELECT, INSERT, UPDATE ON public.congregation_settings TO authenticated;

-- Anyone can read settings for their congregation
CREATE POLICY "Read own congregation settings"
  ON public.congregation_settings FOR SELECT TO authenticated
  USING (true);

-- Only Elder/Chair/HO can update
CREATE POLICY "Update settings (Elder/Chair/HO)"
  ON public.congregation_settings FOR UPDATE TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_hierarchy_access uha
      WHERE uha.user_id = auth.uid()
        AND uha.status = 'active'
        AND uha.role IN ('Elder', 'Chairperson', 'HO')
    )
  );

-- Insert (for first-time setup)
CREATE POLICY "Insert settings (Elder/Chair/HO)"
  ON public.congregation_settings FOR INSERT TO authenticated
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.user_hierarchy_access uha
      WHERE uha.user_id = auth.uid()
        AND uha.status = 'active'
        AND uha.role IN ('Elder', 'Chairperson', 'HO')
    )
  );

-- Seed default settings for Bosmont (if not exists)
INSERT INTO public.congregation_settings (congregation_id, proof_mandatory, allow_chair_submit, theme_default)
SELECT id, false, true, 'light' FROM public.congregations WHERE code = '020700'
  AND NOT EXISTS (SELECT 1 FROM public.congregation_settings cs WHERE cs.congregation_id = (SELECT id FROM public.congregations WHERE code = '020700'));
