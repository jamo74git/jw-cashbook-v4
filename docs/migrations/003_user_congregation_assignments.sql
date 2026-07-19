-- ═══════════════════════════════════════════════════════════════════════════════
-- MIGRATION 003: Multi-congregation user assignments
-- Run this in Supabase SQL Editor
-- ═══════════════════════════════════════════════════════════════════════════════

-- 1. Create the user_congregation_assignments table
CREATE TABLE IF NOT EXISTS public.user_congregation_assignments (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  congregation_id UUID NOT NULL REFERENCES public.congregations(id) ON DELETE CASCADE,
  assigned_by UUID REFERENCES auth.users(id),
  assigned_at TIMESTAMPTZ DEFAULT now(),
  status TEXT DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  UNIQUE(user_id, congregation_id)
);

-- 2. Grant permissions
GRANT ALL ON public.user_congregation_assignments TO service_role;
GRANT ALL ON public.user_congregation_assignments TO authenticated;
GRANT ALL ON public.user_congregation_assignments TO anon;

-- 3. Enable RLS
ALTER TABLE public.user_congregation_assignments ENABLE ROW LEVEL SECURITY;

-- 4. RLS Policies
-- Authenticated users can read their own assignments
CREATE POLICY "Users can read own assignments"
  ON public.user_congregation_assignments
  FOR SELECT
  TO authenticated
  USING (user_id = auth.uid());

-- Service role can do everything (for admin operations)
CREATE POLICY "Service role full access"
  ON public.user_congregation_assignments
  FOR ALL
  TO service_role
  USING (true)
  WITH CHECK (true);

-- HO users can manage all assignments (read)
CREATE POLICY "HO can read all assignments"
  ON public.user_congregation_assignments
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_hierarchy_access
      WHERE user_id = auth.uid() AND role = 'HO' AND status = 'active'
    )
  );

-- HO users can insert/update/delete assignments
CREATE POLICY "HO can manage assignments"
  ON public.user_congregation_assignments
  FOR ALL
  TO authenticated
  USING (
    EXISTS (
      SELECT 1 FROM public.user_hierarchy_access
      WHERE user_id = auth.uid() AND role = 'HO' AND status = 'active'
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM public.user_hierarchy_access
      WHERE user_id = auth.uid() AND role = 'HO' AND status = 'active'
    )
  );

-- 5. Create index for fast lookups
CREATE INDEX idx_user_cong_assignments_user ON public.user_congregation_assignments(user_id) WHERE status = 'active';
CREATE INDEX idx_user_cong_assignments_cong ON public.user_congregation_assignments(congregation_id) WHERE status = 'active';

-- 6. Seed existing Elder assignments from current eldership structure
-- This migrates elders: for each elder, find their eldership's congregations and create assignments
INSERT INTO public.user_congregation_assignments (user_id, congregation_id, assigned_by, status)
SELECT
  uha.user_id,
  c.id AS congregation_id,
  uha.user_id AS assigned_by, -- self-assigned during migration
  'active'
FROM public.user_hierarchy_access uha
JOIN public.congregations c ON c.eldership_id = uha.hierarchy_id
WHERE uha.role = 'Elder' AND uha.status = 'active'
ON CONFLICT (user_id, congregation_id) DO NOTHING;

-- 7. Also seed congregation-scoped users (Treasurer, Auditor, Chairperson, Secretary)
-- They get a single assignment matching their congregation_id
INSERT INTO public.user_congregation_assignments (user_id, congregation_id, assigned_by, status)
SELECT
  uha.user_id,
  uha.congregation_id,
  uha.user_id AS assigned_by,
  'active'
FROM public.user_hierarchy_access uha
WHERE uha.congregation_id IS NOT NULL AND uha.status = 'active'
ON CONFLICT (user_id, congregation_id) DO NOTHING;

-- Done! Verify:
-- SELECT u.email, c.name, uca.status
-- FROM user_congregation_assignments uca
-- JOIN auth.users u ON u.id = uca.user_id
-- JOIN congregations c ON c.id = uca.congregation_id
-- ORDER BY u.email, c.name;
