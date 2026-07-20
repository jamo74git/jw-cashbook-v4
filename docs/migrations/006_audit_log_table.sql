-- ═══════════════════════════════════════════════════════════════════════════════
-- MIGRATION 006: Create audit_log table
-- Run this in Supabase SQL Editor
-- ═══════════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS public.audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id),
  action_type TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id UUID NOT NULL,
  assumed_role TEXT,
  comment TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_audit_log_user ON public.audit_log(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_entity ON public.audit_log(entity_type, entity_id);
CREATE INDEX IF NOT EXISTS idx_audit_log_type ON public.audit_log(action_type);

-- Grants
GRANT ALL ON public.audit_log TO service_role;
GRANT ALL ON public.audit_log TO authenticated;

-- RLS
ALTER TABLE public.audit_log ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Authenticated can read audit_log"
  ON public.audit_log FOR SELECT TO authenticated USING (true);

CREATE POLICY "Authenticated can insert audit_log"
  ON public.audit_log FOR INSERT TO authenticated WITH CHECK (true);

CREATE POLICY "Service role full access audit_log"
  ON public.audit_log FOR ALL TO service_role USING (true) WITH CHECK (true);
