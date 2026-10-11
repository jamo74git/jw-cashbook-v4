-- ═══════════════════════════════════════════════════════════════════════════════
-- MIGRATION 009: Phase B–D foundation (Census / Attendance / New Members)
-- Run this in Supabase SQL Editor
-- SCHEMA ONLY — stub tables + enums + private storage bucket. No app UI yet.
-- Idempotent (IF NOT EXISTS / ON CONFLICT) so it is safe to re-run.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ─── Enum types (Postgres has no CREATE TYPE IF NOT EXISTS) ────────────────────
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'attendance_type') THEN
    CREATE TYPE public.attendance_type AS ENUM (
      'normal', 'combined_eldership', 'combined_youth', 'combined_seniors', 'festival'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'census_bucket') THEN
    CREATE TYPE public.census_bucket AS ENUM (
      'child_0_15', 'unconfirmed_youth', 'confirmed_youth', 'adult', 'senior'
    );
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'new_member_type') THEN
    CREATE TYPE public.new_member_type AS ENUM ('AT', 'CT', 'CB');
  END IF;
END$$;

-- ─── census_congregation ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.census_congregation (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  congregation_id UUID NOT NULL REFERENCES public.congregations(id),
  year INTEGER NOT NULL,
  month INTEGER NOT NULL,
  total_members INTEGER,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_census_congregation_cong
  ON public.census_congregation(congregation_id, year, month);

-- ─── census_priestship (last_verified_at drives the 3mo/6mo staleness flag) ────
CREATE TABLE IF NOT EXISTS public.census_priestship (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  congregation_id UUID NOT NULL REFERENCES public.congregations(id),
  priest_id UUID REFERENCES public.officers(id),
  member_count INTEGER,
  last_verified_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_census_priestship_cong
  ON public.census_priestship(congregation_id);
COMMENT ON COLUMN public.census_priestship.last_verified_at
  IS 'Anchor for the 90-day (3mo) and 180-day (6mo) census verification staleness flags';

-- ─── attendance_monthly (visitors EXCLUDED from the % calc; signatures jsonb) ──
CREATE TABLE IF NOT EXISTS public.attendance_monthly (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  congregation_id UUID NOT NULL REFERENCES public.congregations(id),
  year INTEGER NOT NULL,
  month INTEGER NOT NULL,
  attendance_type public.attendance_type NOT NULL,
  attendance_count INTEGER,
  visitors INTEGER NOT NULL DEFAULT 0,
  signatures JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_attendance_monthly_cong
  ON public.attendance_monthly(congregation_id, year, month);
COMMENT ON COLUMN public.attendance_monthly.visitors
  IS 'Visitor count — EXCLUDED from the attendance percentage calculation';

-- ─── new_members_register (encrypted name fields; ciphertext only, NO plaintext PII) ──
CREATE TABLE IF NOT EXISTS public.new_members_register (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  congregation_id UUID NOT NULL REFERENCES public.congregations(id),
  type public.new_member_type NOT NULL,
  first_name_enc TEXT,
  last_name_enc TEXT,
  census_bucket public.census_bucket,
  photo_path TEXT,
  consent_path TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_new_members_register_cong
  ON public.new_members_register(congregation_id);
COMMENT ON COLUMN public.new_members_register.first_name_enc
  IS 'Ciphertext (field-encrypted); no plaintext PII is stored';
COMMENT ON COLUMN public.new_members_register.last_name_enc
  IS 'Ciphertext (field-encrypted); no plaintext PII is stored';
COMMENT ON COLUMN public.new_members_register.photo_path
  IS 'Path into the private member-docs storage bucket';
COMMENT ON COLUMN public.new_members_register.consent_path
  IS 'Path into the private member-docs storage bucket (consent document)';

-- ─── Grants + RLS (mirror the 006 pattern) ────────────────────────────────────
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'census_congregation', 'census_priestship', 'attendance_monthly', 'new_members_register'
  ]
  LOOP
    EXECUTE format('GRANT ALL ON public.%I TO service_role;', t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE ON public.%I TO authenticated;', t);
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY;', t);

    EXECUTE format($f$
      DROP POLICY IF EXISTS "Authenticated can read %1$s" ON public.%1$I;
      CREATE POLICY "Authenticated can read %1$s"
        ON public.%1$I FOR SELECT TO authenticated USING (true);
    $f$, t);
    EXECUTE format($f$
      DROP POLICY IF EXISTS "Authenticated can insert %1$s" ON public.%1$I;
      CREATE POLICY "Authenticated can insert %1$s"
        ON public.%1$I FOR INSERT TO authenticated WITH CHECK (true);
    $f$, t);
    EXECUTE format($f$
      DROP POLICY IF EXISTS "Authenticated can update %1$s" ON public.%1$I;
      CREATE POLICY "Authenticated can update %1$s"
        ON public.%1$I FOR UPDATE TO authenticated USING (true) WITH CHECK (true);
    $f$, t);
    EXECUTE format($f$
      DROP POLICY IF EXISTS "Service role full access %1$s" ON public.%1$I;
      CREATE POLICY "Service role full access %1$s"
        ON public.%1$I FOR ALL TO service_role USING (true) WITH CHECK (true);
    $f$, t);
  END LOOP;
END$$;

-- ─── Private storage bucket 'member-docs' + object RLS ────────────────────────
INSERT INTO storage.buckets (id, name, public)
VALUES ('member-docs', 'member-docs', false)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS "member-docs read" ON storage.objects;
CREATE POLICY "member-docs read"
  ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'member-docs');

DROP POLICY IF EXISTS "member-docs insert" ON storage.objects;
CREATE POLICY "member-docs insert"
  ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'member-docs');

DROP POLICY IF EXISTS "member-docs update" ON storage.objects;
CREATE POLICY "member-docs update"
  ON storage.objects FOR UPDATE TO authenticated
  USING (bucket_id = 'member-docs') WITH CHECK (bucket_id = 'member-docs');

DROP POLICY IF EXISTS "member-docs delete" ON storage.objects;
CREATE POLICY "member-docs delete"
  ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'member-docs');

-- Done! Verify:
-- SELECT table_name FROM information_schema.tables
--   WHERE table_name IN ('census_congregation','census_priestship','attendance_monthly','new_members_register');
-- SELECT id, public FROM storage.buckets WHERE id = 'member-docs';
