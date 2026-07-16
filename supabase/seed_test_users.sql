-- ═══════════════════════════════════════════════════════════════════════════════
-- SEED: Test Users for Elder, HO, Chairperson
--
-- STEP 1: Create auth users via Supabase Dashboard (Auth > Users > Add User):
--   - elder@bosmont.test / password123
--   - ho@gauteng.test / password123
--   - chairperson@bosmont.test / password123
--
-- STEP 2: After creating them, get their UUIDs from the Dashboard and paste below.
--         OR run this query to find them:
--
--   SELECT id, email FROM auth.users WHERE email IN ('elder@bosmont.test','ho@gauteng.test','chairperson@bosmont.test');
--
-- STEP 3: Replace the UUIDs below with the real ones, then run this script.
-- ═══════════════════════════════════════════════════════════════════════════════

-- ─── PASTE YOUR REAL UUIDs HERE ─────────────────────────────────────────────
-- Run: SELECT id, email FROM auth.users WHERE email IN ('elder@bosmont.test','ho@gauteng.test','chairperson@bosmont.test');
-- Then replace these placeholders:

DO $$
DECLARE
  v_elder_uid UUID;
  v_ho_uid UUID;
  v_chair_uid UUID;
  v_bosmont_cong_id UUID;
BEGIN
  -- Get auth user IDs
  SELECT id INTO v_elder_uid FROM auth.users WHERE email = 'elder@bosmont.test';
  SELECT id INTO v_ho_uid FROM auth.users WHERE email = 'ho@gauteng.test';
  SELECT id INTO v_chair_uid FROM auth.users WHERE email = 'chairperson@bosmont.test';

  -- Get Bosmont congregation ID
  SELECT id INTO v_bosmont_cong_id FROM public.congregations WHERE code = '020700';

  -- ─── ELDER: scope = Eldership (sees all congregations under Eldership) ────
  IF v_elder_uid IS NOT NULL THEN
    DELETE FROM public.user_hierarchy_access WHERE user_id = v_elder_uid;
    INSERT INTO public.user_hierarchy_access (user_id, role, hierarchy_id, congregation_id, scope_level, status, start_date)
    VALUES (
      v_elder_uid,
      'Elder',
      '10000000-0000-0000-0000-000000000006',  -- Eldership Bosmont-Newclare
      NULL,  -- Elder sees all congregations under eldership, not scoped to one
      'Eldership',
      'active',
      now()
    );
    RAISE NOTICE 'Elder access created for %', v_elder_uid;
  ELSE
    RAISE NOTICE 'elder@bosmont.test not found in auth.users. Create it first.';
  END IF;

  -- ─── HO: scope = District (sees everything in assigned district) ──────────
  IF v_ho_uid IS NOT NULL THEN
    DELETE FROM public.user_hierarchy_access WHERE user_id = v_ho_uid;
    INSERT INTO public.user_hierarchy_access (user_id, role, hierarchy_id, congregation_id, scope_level, status, start_date)
    VALUES (
      v_ho_uid,
      'HO',
      '10000000-0000-0000-0000-000000000003',  -- Gauteng District
      NULL,  -- HO is district-scoped, not congregation-scoped
      'District',
      'active',
      now()
    );
    -- Also add HO district assignment (required by LoginForm.tsx Step 4)
    DELETE FROM public.ho_district_assignments WHERE user_id = v_ho_uid;
    INSERT INTO public.ho_district_assignments (user_id, district_id, assigned_by)
    VALUES (v_ho_uid, '10000000-0000-0000-0000-000000000003', v_ho_uid);
    RAISE NOTICE 'HO access + district assignment created for %', v_ho_uid;
  ELSE
    RAISE NOTICE 'ho@gauteng.test not found in auth.users. Create it first.';
  END IF;

  -- ─── CHAIRPERSON: scope = Congregation (Bosmont only) ─────────────────────
  IF v_chair_uid IS NOT NULL AND v_bosmont_cong_id IS NOT NULL THEN
    DELETE FROM public.user_hierarchy_access WHERE user_id = v_chair_uid;
    INSERT INTO public.user_hierarchy_access (user_id, role, hierarchy_id, congregation_id, scope_level, status, start_date)
    VALUES (
      v_chair_uid,
      'Chairperson',
      '10000000-0000-0000-0000-000000000007',  -- Bosmont hierarchy node
      v_bosmont_cong_id,                        -- Bosmont congregation
      'Congregation',
      'active',
      now()
    );
    RAISE NOTICE 'Chairperson access created for %', v_chair_uid;
  ELSE
    RAISE NOTICE 'chairperson@bosmont.test not found OR Bosmont congregation missing.';
  END IF;
END $$;

-- ─── VERIFY ─────────────────────────────────────────────────────────────────
SELECT u.email, uha.role, uha.scope_level, uha.congregation_id, uha.status
FROM public.user_hierarchy_access uha
JOIN auth.users u ON u.id = uha.user_id
WHERE u.email IN ('elder@bosmont.test', 'ho@gauteng.test', 'chairperson@bosmont.test', 'treasurer@bosmont.test');

-- ═══════════════════════════════════════════════════════════════════════════════
-- AFTER RUNNING:
--
-- Login as elder@bosmont.test → routes to /dashboard (Elder Dashboard)
-- Login as ho@gauteng.test → routes to /admin (HO Admin)
-- Login as chairperson@bosmont.test → routes to /chairperson (Chair Dashboard)
-- Login as treasurer@bosmont.test → routes to /treasurer (Treasurer Dashboard)
--
-- If still getting "Access restricted" error:
--   1. Check the VERIFY query above shows 'active' status for each user
--   2. For HO: ensure ho_district_assignments has a row
--   3. Check browser console for the actual error message
-- ═══════════════════════════════════════════════════════════════════════════════
