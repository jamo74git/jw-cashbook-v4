-- Seed data: 1 test user per role (all active)
-- These UUIDs are deterministic for easy reference in development.
-- In production, users are created via Supabase Auth and the trigger auto-creates profiles.

INSERT INTO public.profiles (id, email, role, status, start_date, userend_date) VALUES
  ('00000000-0000-0000-0000-000000000001', 'ho@jwcashbook.test', 'HO', 'active', '2024-01-01', NULL),
  ('00000000-0000-0000-0000-000000000002', 'apostle@jwcashbook.test', 'Apostle', 'active', '2024-01-01', NULL),
  ('00000000-0000-0000-0000-000000000003', 'overseer@jwcashbook.test', 'Overseer', 'active', '2024-01-01', NULL),
  ('00000000-0000-0000-0000-000000000004', 'elder@jwcashbook.test', 'Elder', 'active', '2024-01-01', NULL),
  ('00000000-0000-0000-0000-000000000005', 'chairperson@jwcashbook.test', 'Chairperson', 'active', '2024-01-01', NULL),
  ('00000000-0000-0000-0000-000000000006', 'treasurer@jwcashbook.test', 'Treasurer', 'active', '2024-01-01', NULL),
  ('00000000-0000-0000-0000-000000000007', 'auditor@jwcashbook.test', 'Auditor', 'active', '2024-01-01', NULL),
  ('00000000-0000-0000-0000-000000000008', 'secretary@jwcashbook.test', 'Secretary', 'active', '2024-01-01', NULL);
