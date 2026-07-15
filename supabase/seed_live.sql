-- ═══════════════════════════════════════════════════════════════════════════════
-- OAC MANAGEMENT SYSTEM — CLEAN SEED (run AFTER seed_purge.sql)
-- All tables are empty. Straight inserts. No conflict handling needed.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ─── 1. HIERARCHY LEVELS ────────────────────────────────────────────────────

INSERT INTO public.hierarchy_levels (id, level_type, name, code, parent_id) VALUES
  ('10000000-0000-0000-0000-000000000001', 'Conference', 'Conference of Apostles', 'CONF01', NULL),
  ('10000000-0000-0000-0000-000000000002', 'Apostolate', 'Apostolate of Africa', 'APO01', '10000000-0000-0000-0000-000000000001'),
  ('10000000-0000-0000-0000-000000000003', 'District', 'Gauteng District', 'DIST01', '10000000-0000-0000-0000-000000000002'),
  ('10000000-0000-0000-0000-000000000004', 'Apostleship', 'Apostleship Johannesburg West', 'APOS01', '10000000-0000-0000-0000-000000000003'),
  ('10000000-0000-0000-0000-000000000005', 'Overseership', 'Overseership Westrand', 'OVER01', '10000000-0000-0000-0000-000000000004'),
  ('10000000-0000-0000-0000-000000000006', 'Eldership', 'Eldership Bosmont-Newclare', 'ELDER01', '10000000-0000-0000-0000-000000000005'),
  ('10000000-0000-0000-0000-000000000007', 'Congregation', 'Bosmont', '020700', '10000000-0000-0000-0000-000000000006'),
  ('10000000-0000-0000-0000-000000000008', 'Congregation', 'Newclare', '026040', '10000000-0000-0000-0000-000000000006');

-- ─── 2. CONGREGATIONS ───────────────────────────────────────────────────────

INSERT INTO public.congregations (id, hierarchy_id, name, code, eldership_id, overseership_id, apostleship_id, district_id) VALUES
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000007', 'Bosmont', '020700',
   '10000000-0000-0000-0000-000000000006', '10000000-0000-0000-0000-000000000005', '10000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000003'),
  ('20000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-000000000008', 'Newclare', '026040',
   '10000000-0000-0000-0000-000000000006', '10000000-0000-0000-0000-000000000005', '10000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-000000000003');

-- ─── 3. OFFICERS (Bosmont) ──────────────────────────────────────────────────

INSERT INTO public.officers (id, congregation_id, officer_code, first_name, last_name, rank, is_active) VALUES
  ('30000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'Priestship-001', 'John', 'Molefe', 'Priest', true),
  ('30000000-0000-0000-0000-000000000002', '20000000-0000-0000-0000-000000000001', 'Priestship-002', 'David', 'Khumalo', 'Priest', true),
  ('30000000-0000-0000-0000-000000000003', '20000000-0000-0000-0000-000000000001', 'Priestship-003', 'Peter', 'Nkosi', 'Priest', true),
  ('30000000-0000-0000-0000-000000000004', '20000000-0000-0000-0000-000000000001', 'Priestship-004', 'James', 'Sithole', 'Priest', true),
  ('30000000-0000-0000-0000-000000000005', '20000000-0000-0000-0000-000000000001', 'Priestship-005', 'Simon', 'Dlamini', 'Priest', true),
  ('30000000-0000-0000-0000-000000000006', '20000000-0000-0000-0000-000000000001', 'Priestship-006', 'Andrew', 'Mabena', 'Priest', true);

-- ─── 4. USER HIERARCHY ACCESS (treasurer@bosmont.test) ──────────────────────

INSERT INTO public.user_hierarchy_access (id, user_id, role, hierarchy_id, congregation_id, scope_level, status, start_date) VALUES
  ('40000000-0000-0000-0000-000000000001', '2d1c0c9a-b443-4b06-bda7-ee1341188312', 'Treasurer',
   '10000000-0000-0000-0000-000000000007', '20000000-0000-0000-0000-000000000001', 'Congregation', 'active', now());

-- ─── 5. CASHBOOK PERIOD (July 2026, Week 1, AM) ────────────────────────────

INSERT INTO public.cashbook_period (id, congregation_id, year, month, week, service, status, submitted_by) VALUES
  ('50000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 2026, 7, 1, 'AM', 'Draft', '2d1c0c9a-b443-4b06-bda7-ee1341188312');

-- ─── 6. MEMBERS TITHING (5 rows = R4,400.88) ───────────────────────────────

INSERT INTO public.cashbook_line_item (id, period_id, section, officer_id, item_type, item_count, amount, payment_type) VALUES
  ('60000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000001', 'Members', '30000000-0000-0000-0000-000000000001', 'EFT', 3, 1500.88, 'EFT'),
  ('60000000-0000-0000-0000-000000000002', '50000000-0000-0000-0000-000000000001', 'Members', '30000000-0000-0000-0000-000000000002', 'Cash', NULL, 350.00, 'Cash'),
  ('60000000-0000-0000-0000-000000000003', '50000000-0000-0000-0000-000000000001', 'Members', '30000000-0000-0000-0000-000000000003', 'EFT', 1, 1152.00, 'EFT'),
  ('60000000-0000-0000-0000-000000000004', '50000000-0000-0000-0000-000000000001', 'Members', '30000000-0000-0000-0000-000000000004', 'EFT', NULL, 500.00, 'EFT'),
  ('60000000-0000-0000-0000-000000000005', '50000000-0000-0000-0000-000000000001', 'Members', '30000000-0000-0000-0000-000000000006', 'Cash', NULL, 898.00, 'Cash');

-- ─── 7. OFFICERS TITHING (5 rows = R3,358.00) ──────────────────────────────

INSERT INTO public.cashbook_line_item (id, period_id, section, officer_id, item_type, item_count, amount, payment_type) VALUES
  ('60000000-0000-0000-0000-000000000011', '50000000-0000-0000-0000-000000000001', 'Officers', '30000000-0000-0000-0000-000000000001', 'Cash', NULL, 170.00, 'Cash'),
  ('60000000-0000-0000-0000-000000000012', '50000000-0000-0000-0000-000000000001', 'Officers', '30000000-0000-0000-0000-000000000002', 'Cash', NULL, 200.00, 'Cash'),
  ('60000000-0000-0000-0000-000000000013', '50000000-0000-0000-0000-000000000001', 'Officers', '30000000-0000-0000-0000-000000000003', 'Cash', NULL, 300.00, 'Cash'),
  ('60000000-0000-0000-0000-000000000014', '50000000-0000-0000-0000-000000000001', 'Officers', '30000000-0000-0000-0000-000000000005', 'Cash', NULL, 200.00, 'Cash'),
  ('60000000-0000-0000-0000-000000000015', '50000000-0000-0000-0000-000000000001', 'Officers', '30000000-0000-0000-0000-000000000004', 'DirectDebit', 1, 2488.00, 'DirectDebit');

-- ─── 8. BURIAL (1 row = R105.00) ───────────────────────────────────────────

INSERT INTO public.cashbook_line_item (id, period_id, section, officer_id, item_type, item_count, amount, payment_type, manual_reference) VALUES
  ('60000000-0000-0000-0000-000000000021', '50000000-0000-0000-0000-000000000001', 'Burial', NULL, 'Cash', NULL, 105.00, 'Cash', '287281');

-- ─── 9. EXPENSES (2 rows = R300.00) ────────────────────────────────────────

INSERT INTO public.cashbook_line_item (id, period_id, section, officer_id, item_type, item_count, amount, payment_type, manual_reference) VALUES
  ('60000000-0000-0000-0000-000000000031', '50000000-0000-0000-0000-000000000001', 'Expenses', NULL, 'Expense', NULL, 180.24, NULL, 'Coffee & Tea'),
  ('60000000-0000-0000-0000-000000000032', '50000000-0000-0000-0000-000000000001', 'Expenses', NULL, 'Expense', NULL, 119.76, NULL, 'Cleaning materials');

-- ─── 10. GRANTS + RLS ──────────────────────────────────────────────────────

GRANT SELECT, INSERT, UPDATE, DELETE ON public.congregations TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.hierarchy_levels TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.officers TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.cashbook_period TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.cashbook_line_item TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.cashbook_attachment TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.user_hierarchy_access TO authenticated;
GRANT SELECT ON public.ho_district_assignments TO authenticated;

ALTER TABLE public.congregations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hierarchy_levels ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.officers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cashbook_period ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cashbook_line_item ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='congregations' AND policyname='Auth read congregations') THEN
    EXECUTE 'CREATE POLICY "Auth read congregations" ON public.congregations FOR SELECT TO authenticated USING (true)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='hierarchy_levels' AND policyname='Auth read hierarchy') THEN
    EXECUTE 'CREATE POLICY "Auth read hierarchy" ON public.hierarchy_levels FOR SELECT TO authenticated USING (true)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='officers' AND policyname='Auth read officers') THEN
    EXECUTE 'CREATE POLICY "Auth read officers" ON public.officers FOR SELECT TO authenticated USING (true)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='cashbook_period' AND policyname='Auth all periods') THEN
    EXECUTE 'CREATE POLICY "Auth all periods" ON public.cashbook_period FOR ALL TO authenticated USING (true) WITH CHECK (true)';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE tablename='cashbook_line_item' AND policyname='Auth all line items') THEN
    EXECUTE 'CREATE POLICY "Auth all line items" ON public.cashbook_line_item FOR ALL TO authenticated USING (true) WITH CHECK (true)';
  END IF;
END $$;

-- ═══════════════════════════════════════════════════════════════════════════════
-- DONE. Refresh /capture.
-- Expected: 020700 | Bosmont | Members R4,400.88 | Officers R3,358.00 | Burial R105 | Expenses R300
-- ═══════════════════════════════════════════════════════════════════════════════
