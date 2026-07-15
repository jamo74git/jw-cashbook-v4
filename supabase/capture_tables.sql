-- ═══════════════════════════════════════════════════════════════════════════════
-- TREASURER CAPTURE TABLES
-- Run this in Supabase SQL Editor to create the capture data model
-- ═══════════════════════════════════════════════════════════════════════════════

-- ─── Weekly Capture (parent record per service) ─────────────────────────────

CREATE TABLE IF NOT EXISTS public.weekly_capture (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  congregation_id UUID NOT NULL,
  year INT NOT NULL,
  month INT NOT NULL CHECK (month BETWEEN 1 AND 12),
  week INT NOT NULL CHECK (week BETWEEN 1 AND 5),
  service_type TEXT NOT NULL CHECK (service_type IN ('AM','PM')),
  service_date DATE NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','pending_audit','audit_approved','audit_rejected')),
  captured_by UUID REFERENCES auth.users(id),
  submitted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(congregation_id, year, month, week, service_type)
);

-- ─── Member Tithing Entries (Section 3.1) ───────────────────────────────────

CREATE TABLE IF NOT EXISTS public.member_tithing_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  weekly_capture_id UUID NOT NULL REFERENCES public.weekly_capture(id) ON DELETE CASCADE,
  officer_code TEXT NOT NULL,
  payment_type TEXT NOT NULL CHECK (payment_type IN ('EFT','Cash')),
  amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Officer Tithing Entries (Section 3.2) ──────────────────────────────────

CREATE TABLE IF NOT EXISTS public.officer_tithing_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  weekly_capture_id UUID NOT NULL REFERENCES public.weekly_capture(id) ON DELETE CASCADE,
  officer_code TEXT NOT NULL,
  payment_type TEXT NOT NULL CHECK (payment_type IN ('Cash','DirectDebit')),
  amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Burial Entries (Section 3.3) ───────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.burial_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  weekly_capture_id UUID NOT NULL REFERENCES public.weekly_capture(id) ON DELETE CASCADE,
  receipt_number TEXT NOT NULL,
  payment_type TEXT NOT NULL DEFAULT 'Cash' CHECK (payment_type IN ('Cash','EFT')),
  amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  proof_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Banking Entries (Right Panel) ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.banking_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  weekly_capture_id UUID NOT NULL REFERENCES public.weekly_capture(id) ON DELETE CASCADE,
  payment_date DATE NOT NULL,
  payment_type TEXT NOT NULL CHECK (payment_type IN ('EFT','Direct','Cash Pending')),
  amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Expense Entries (Right Panel) ──────────────────────────────────────────

CREATE TABLE IF NOT EXISTS public.expense_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  weekly_capture_id UUID NOT NULL REFERENCES public.weekly_capture(id) ON DELETE CASCADE,
  expense_date DATE NOT NULL,
  description TEXT NOT NULL,
  amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- GRANTS (fix the 403 issue)
-- ═══════════════════════════════════════════════════════════════════════════════

GRANT SELECT, INSERT, UPDATE, DELETE ON public.weekly_capture TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.member_tithing_entries TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.officer_tithing_entries TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.burial_entries TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.banking_entries TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.expense_entries TO authenticated;
GRANT SELECT ON public.weekly_capture TO anon;

-- ═══════════════════════════════════════════════════════════════════════════════
-- RLS POLICIES
-- ═══════════════════════════════════════════════════════════════════════════════

ALTER TABLE public.weekly_capture ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member_tithing_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.officer_tithing_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.burial_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.banking_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.expense_entries ENABLE ROW LEVEL SECURITY;

-- Weekly capture: scoped to congregation via user_hierarchy_access
CREATE POLICY "Congregation scoped capture" ON public.weekly_capture
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.user_hierarchy_access uha
      WHERE uha.user_id = auth.uid()
        AND uha.status = 'active'
        AND (uha.congregation_id = weekly_capture.congregation_id OR uha.scope_level != 'Congregation')
    )
  );

-- Child tables: inherit access from parent weekly_capture
CREATE POLICY "Inherit from weekly_capture" ON public.member_tithing_entries
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.weekly_capture wc
      JOIN public.user_hierarchy_access uha ON uha.user_id = auth.uid()
      WHERE wc.id = member_tithing_entries.weekly_capture_id
        AND uha.status = 'active'
        AND (uha.congregation_id = wc.congregation_id OR uha.scope_level != 'Congregation')
    )
  );

CREATE POLICY "Inherit from weekly_capture" ON public.officer_tithing_entries
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.weekly_capture wc
      JOIN public.user_hierarchy_access uha ON uha.user_id = auth.uid()
      WHERE wc.id = officer_tithing_entries.weekly_capture_id
        AND uha.status = 'active'
        AND (uha.congregation_id = wc.congregation_id OR uha.scope_level != 'Congregation')
    )
  );

CREATE POLICY "Inherit from weekly_capture" ON public.burial_entries
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.weekly_capture wc
      JOIN public.user_hierarchy_access uha ON uha.user_id = auth.uid()
      WHERE wc.id = burial_entries.weekly_capture_id
        AND uha.status = 'active'
        AND (uha.congregation_id = wc.congregation_id OR uha.scope_level != 'Congregation')
    )
  );

CREATE POLICY "Inherit from weekly_capture" ON public.banking_entries
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.weekly_capture wc
      JOIN public.user_hierarchy_access uha ON uha.user_id = auth.uid()
      WHERE wc.id = banking_entries.weekly_capture_id
        AND uha.status = 'active'
        AND (uha.congregation_id = wc.congregation_id OR uha.scope_level != 'Congregation')
    )
  );

CREATE POLICY "Inherit from weekly_capture" ON public.expense_entries
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM public.weekly_capture wc
      JOIN public.user_hierarchy_access uha ON uha.user_id = auth.uid()
      WHERE wc.id = expense_entries.weekly_capture_id
        AND uha.status = 'active'
        AND (uha.congregation_id = wc.congregation_id OR uha.scope_level != 'Congregation')
    )
  );

-- ═══════════════════════════════════════════════════════════════════════════════
-- STORAGE BUCKET for burial proofs
-- Run separately or via Supabase Dashboard > Storage > New Bucket
-- ═══════════════════════════════════════════════════════════════════════════════
-- INSERT INTO storage.buckets (id, name, public) VALUES ('burial_proofs', 'burial_proofs', true);
