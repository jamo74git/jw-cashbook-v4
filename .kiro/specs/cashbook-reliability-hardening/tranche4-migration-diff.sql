-- ============================================================================
-- TRANCHE 4 — PROOF-ACCESS MIGRATION DIFF  *** REVIEW ARTIFACT — NOT APPLIED ***
--
-- Purpose: an exact, reviewable BEFORE -> AFTER diff of the storage.objects
-- proof-access policies, scoped to the change Tranche 4 makes. It replaces the
-- broad `Authenticated_CRUD l4t6gw_*` exposure with per-congregation scoped
-- policies, and closes the legacy cross-bucket write leak on the underscore
-- bucket. Narrative access checks + fallback live in tranche4-access-checks.md.
--
-- SOURCES (read-only, no DB touched to produce this):
--   BEFORE = captured live baseline:
--     C:\Users\User\OneDrive - Morriscom Solutions\OAC\backups\
--       tranche4-precutover-20261104\policy-definitions.sql  (captured 2026-11-04)
--   AFTER  = the authored migration (the executable form, with helper functions,
--            attachment-row locks, and the dedupe index):
--     supabase/migrations/20261012010000_tranche4_proof_access.sql
--
-- This file is the DIFF/REVIEW view: it shows exactly which live policies are
-- dropped and what replaces them, with the predicates inline, so a reviewer can
-- compare without cross-referencing two files. The executable migration is the
-- source of truth for application; this diff MUST stay consistent with it.
--
-- HARD CONSTRAINTS (environment-context.md):
--   * NOT applied to cwdyixafvylzgtpsfmwr (dev/demo, labelled PRODUCTION, NOT launched).
--   * Apply ONLY on a disposable local stack (`supabase start`, Docker) or an
--     explicitly disposable test project, AFTER `supabase db pull`, and ONLY after
--     the effective-RLS suite (supabase/tests/tranche4_proof_rls.test.sql) passes.
--   * Docker/local Supabase is unavailable in this pass, so every access check in
--     tranche4-access-checks.md is reported as NEEDS AUTHENTICATED/HOSTED TESTING.
-- ============================================================================


-- ============================================================================
-- SECTION 1 — BEFORE (captured live storage.objects proof policies, verbatim shape)
-- 7 policies total: 4 unscoped hyphen-bucket + 3 underscore-bucket (leaky).
-- Shown here as DROP targets only; do NOT re-run the CREATEs — they are the
-- insecure baseline and are reproduced solely so the diff is self-contained.
-- ============================================================================
--
-- -- Hyphen bucket `cashbook-proofs` — authority = bucket id ONLY (any authenticated
-- -- user gets full CRUD; l4t6gw_2 in particular lets ANY authenticated user SELECT
-- -- (read / mint a signed url for) EVERY proof in the bucket, cross-congregation):
-- CREATE POLICY "Authenticated_CRUD l4t6gw_0" ON storage.objects FOR INSERT TO authenticated
--   WITH CHECK ((bucket_id = 'cashbook-proofs'));
-- CREATE POLICY "Authenticated_CRUD l4t6gw_1" ON storage.objects FOR UPDATE TO authenticated
--   USING ((bucket_id = 'cashbook-proofs'));            -- NOTE: no WITH CHECK (live bug)
-- CREATE POLICY "Authenticated_CRUD l4t6gw_2" ON storage.objects FOR SELECT TO authenticated
--   USING ((bucket_id = 'cashbook-proofs'));            -- broad read exposure (Tranche 4 target)
-- CREATE POLICY "Authenticated_CRUD l4t6gw_3" ON storage.objects FOR DELETE TO authenticated
--   USING ((bucket_id = 'cashbook-proofs'));
--
-- -- Underscore bucket `cashbook_proofs` — the OR branch sits OUTSIDE the bucket test.
-- -- Because PERMISSIVE predicates OR together, the `scope_level <> 'Congregation'`
-- -- EXISTS branch has NO bucket condition, so a non-Congregation-scoped user (Overseer/
-- -- Apostle/HO) satisfies INSERT/UPDATE/DELETE for a write to ANY bucket — including the
-- -- hyphen `cashbook-proofs` bucket. THIS IS THE LEGACY CROSS-BUCKET WRITE DEFECT:
-- CREATE POLICY "cashbook_proofs insert - active access" ON storage.objects FOR INSERT TO authenticated
--   WITH CHECK (((bucket_id = 'cashbook_proofs' AND folder[1]::uuid IN (my active congs))
--                OR (EXISTS active uha WHERE scope_level <> 'Congregation')));
-- CREATE POLICY "cashbook_proofs update - active access" ON storage.objects FOR UPDATE TO authenticated
--   USING (<same predicate>) WITH CHECK (<same predicate>);
-- CREATE POLICY "cashbook_proofs delete - active access" ON storage.objects FOR DELETE TO authenticated
--   USING (<same predicate>);
--
-- EFFECTIVE AUTHORITY BEFORE (hyphen bucket cashbook-proofs):
--   any authenticated user           -> SELECT + INSERT + UPDATE + DELETE (via l4t6gw_*)
--   any non-Congregation-scope user  -> additionally INSERT/UPDATE/DELETE via underscore leak
--   => cross-congregation read AND cross-bucket write. Making the bucket private only
--      removed anonymous public-URL reads; authenticated exposure is unchanged.


-- ============================================================================
-- SECTION 2 — AFTER (the diff, as executed by the authored migration)
-- Wrap in a transaction for the disposable-stack run. This file ends in ROLLBACK
-- as a drafting precaution: do NOT treat executing it as harmless. The real apply
-- path is the versioned migration under supabase/migrations/, not this diff.
-- ============================================================================
BEGIN;  -- NOT APPLIED — disposable-stack precaution only.

-- ----------------------------------------------------------------------------
-- 2.0  Helper functions the scoped policies depend on (AUTHORED in the migration;
-- summarised here so the diff is reviewable). Full bodies live in
-- supabase/migrations/20261012010000_tranche4_proof_access.sql. get_my_hierarchy_ids()
-- is NOT modified. New (all SECURITY DEFINER, search_path='', granted to authenticated
-- only; revoked from public/anon):
--   * proof_ref_key(text)             — normalise legacy public/sign url OR bare key -> object key.
--   * proof_path_period_id(text)      — validate-before-cast parser -> EXACT period id via the
--                                       full unique key (congregation_id, year, month, week, service)
--                                       with week_key = 'YYYY-MM-WN' consistency; NULL on malformed.
--   * proof_path_congregation(text)   — folder[1]::uuid from a validated key (NULL if malformed).
--   * proof_path_uploader(text)       — folder[5]::uuid from a validated key (NULL if malformed).
--   * proof_object_reference_count(text) — count ALL cashbook_attachment refs to a key
--                                       (bypasses caller RLS) so shared evidence is not
--                                       physically deleted while any reference remains.
--   * get_my_proof_congregations()    — congregations the caller may VIEW proofs in; Secretary
--                                       excluded on EVERY branch; HO/District requires BOTH an
--                                       active HO District role AND a matching ho_district_assignments
--                                       row (no generic District bypass).

-- ----------------------------------------------------------------------------
-- 2.1  LEGACY CROSS-BUCKET WRITE FIX — rewrite the three underscore-bucket policies
-- so the bucket test wraps EVERY authorising branch: bucket AND (A OR B).
--   BEFORE: (bucket='cashbook_proofs' AND A) OR B        <- B has no bucket test (LEAK)
--   AFTER : bucket='cashbook_proofs' AND (A OR B)        <- every branch is bucket-gated
-- This preserves the legitimate underscore-bucket function and removes the accidental
-- authority over any OTHER bucket. (Encoded as pure logic + asserted in
-- src/lib/storage/crossBucketPredicate.test.ts.)
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "cashbook_proofs insert - active access" ON storage.objects;
DROP POLICY IF EXISTS "cashbook_proofs update - active access" ON storage.objects;
DROP POLICY IF EXISTS "cashbook_proofs delete - active access" ON storage.objects;

CREATE POLICY "cashbook_proofs insert - active access" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'cashbook_proofs' AND (
      (storage.foldername(name))[1]::uuid IN (
        SELECT uha.congregation_id FROM public.user_hierarchy_access uha
        WHERE uha.user_id = (SELECT auth.uid()) AND uha.status = 'active')
      OR EXISTS (SELECT 1 FROM public.user_hierarchy_access uha
        WHERE uha.user_id = (SELECT auth.uid()) AND uha.status = 'active'
          AND uha.scope_level <> 'Congregation')
    )
  );
CREATE POLICY "cashbook_proofs update - active access" ON storage.objects
  FOR UPDATE TO authenticated
  USING (
    bucket_id = 'cashbook_proofs' AND (
      (storage.foldername(name))[1]::uuid IN (
        SELECT uha.congregation_id FROM public.user_hierarchy_access uha
        WHERE uha.user_id = (SELECT auth.uid()) AND uha.status = 'active')
      OR EXISTS (SELECT 1 FROM public.user_hierarchy_access uha
        WHERE uha.user_id = (SELECT auth.uid()) AND uha.status = 'active'
          AND uha.scope_level <> 'Congregation')
    )
  )
  WITH CHECK (
    bucket_id = 'cashbook_proofs' AND (
      (storage.foldername(name))[1]::uuid IN (
        SELECT uha.congregation_id FROM public.user_hierarchy_access uha
        WHERE uha.user_id = (SELECT auth.uid()) AND uha.status = 'active')
      OR EXISTS (SELECT 1 FROM public.user_hierarchy_access uha
        WHERE uha.user_id = (SELECT auth.uid()) AND uha.status = 'active'
          AND uha.scope_level <> 'Congregation')
    )
  );
CREATE POLICY "cashbook_proofs delete - active access" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'cashbook_proofs' AND (
      (storage.foldername(name))[1]::uuid IN (
        SELECT uha.congregation_id FROM public.user_hierarchy_access uha
        WHERE uha.user_id = (SELECT auth.uid()) AND uha.status = 'active')
      OR EXISTS (SELECT 1 FROM public.user_hierarchy_access uha
        WHERE uha.user_id = (SELECT auth.uid()) AND uha.status = 'active'
          AND uha.scope_level <> 'Congregation')
    )
  );

-- ----------------------------------------------------------------------------
-- 2.2  DROP the four unscoped hyphen-bucket policies (authority = bucket id only).
-- Removing l4t6gw_2 specifically removes the "any authenticated user may SELECT any
-- cashbook-proofs object" exposure called out as the primary Tranche 4 target.
-- ----------------------------------------------------------------------------
DROP POLICY IF EXISTS "Authenticated_CRUD l4t6gw_0" ON storage.objects;  -- INSERT
DROP POLICY IF EXISTS "Authenticated_CRUD l4t6gw_1" ON storage.objects;  -- UPDATE (had NULL WITH CHECK)
DROP POLICY IF EXISTS "Authenticated_CRUD l4t6gw_2" ON storage.objects;  -- SELECT (broad read)
DROP POLICY IF EXISTS "Authenticated_CRUD l4t6gw_3" ON storage.objects;  -- DELETE

-- ----------------------------------------------------------------------------
-- 2.3  SELECT (read / mint signed url) — per-congregation, non-Secretary only.
-- Replaces the broad l4t6gw_2. Visibility is gated by get_my_proof_congregations()
-- (Secretary excluded on every branch), and the congregation is extracted from a
-- VALIDATED key (NULL -> denied), never from raw path text.
-- ----------------------------------------------------------------------------
CREATE POLICY "proofs_select_scoped" ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'cashbook-proofs'
    AND public.proof_path_congregation(name) IN (SELECT public.get_my_proof_congregations())
  );

-- ----------------------------------------------------------------------------
-- 2.4  INSERT (capture upload) — uploader = caller; key resolves to an EXACT EDITABLE
-- period; caller holds a capture role (Elder/Chairperson/Treasurer) in that period's
-- congregation. Malformed keys -> NULL -> deny. Submitted+ uploads are NOT permitted
-- here; the client gate retains offline-queued proofs (finalisation default-disabled).
-- ----------------------------------------------------------------------------
CREATE POLICY "proofs_insert_capture" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'cashbook-proofs'
    AND public.proof_path_uploader(name) = (SELECT auth.uid())
    AND EXISTS (
      SELECT 1 FROM public.cashbook_period cp
      WHERE cp.id = public.proof_path_period_id(name)
        AND cp.status IN ('Draft','Rejected')
        AND EXISTS (
          SELECT 1 FROM public.user_hierarchy_access uha
          WHERE uha.user_id = (SELECT auth.uid()) AND uha.status = 'active'
            AND uha.start_date <= now() AND (uha.end_date IS NULL OR uha.end_date >= now())
            AND uha.congregation_id = cp.congregation_id
            AND uha.role IN ('Elder','Chairperson','Treasurer')
        )
    )
  );

-- ----------------------------------------------------------------------------
-- 2.5  UPDATE — DENY by omission. No general UPDATE policy on cashbook-proofs, so
-- overwriting an existing object key is forbidden; a replacement proof is a NEW
-- versioned key via INSERT. (Also fixes the live l4t6gw_1 WITH CHECK = NULL bug.)
-- ----------------------------------------------------------------------------
-- (intentionally no CREATE POLICY ... FOR UPDATE on bucket_id = 'cashbook-proofs')

-- ----------------------------------------------------------------------------
-- 2.6  DELETE (ordinary correction) — capture role while the EXACT parent period is
-- still editable (Draft/Rejected), AND only when NO attachment still references the
-- object (shared-evidence guard). No HO/any-role exception for locked periods.
-- ----------------------------------------------------------------------------
CREATE POLICY "proofs_delete_correction" ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'cashbook-proofs'
    AND EXISTS (
      SELECT 1 FROM public.cashbook_period cp
      WHERE cp.id = public.proof_path_period_id(name)
        AND cp.status IN ('Draft','Rejected')
        AND EXISTS (
          SELECT 1 FROM public.user_hierarchy_access uha
          WHERE uha.user_id = (SELECT auth.uid()) AND uha.status = 'active'
            AND uha.start_date <= now() AND (uha.end_date IS NULL OR uha.end_date >= now())
            AND uha.congregation_id = cp.congregation_id
            AND uha.role IN ('Elder','Chairperson','Treasurer')
        )
    )
    AND public.proof_object_reference_count(name) = 0
  );

-- ----------------------------------------------------------------------------
-- 2.7  cashbook_attachment ROW policies (included in the authored migration; shown
-- here for completeness of the review diff — see the migration for full predicates):
--   DROP  "Insert own congregation attachments"
--   DROP  "Update/Delete own congregation attachments"
--   CREATE attach_insert_linked   — referenced object resolves to the EXACT period of
--          the line item, congregation matches, period editable, caller has a capture
--          role, and the object EXISTS and is owned by the caller.
--   CREATE attach_update_linked   — same binding for linkage-changing updates.
--   CREATE attach_locked_no_update / attach_locked_no_delete — RESTRICTIVE deny of
--          attachment UPDATE/DELETE once the parent period is not editable, for ALL
--          roles incl HO (no unconditional exception).
--   The deployed "Delete own congregation attachments" (logical detach) is kept; the
--          restrictive locks confine it to editable periods.
--   Non-destructive duplicate pre-check + UNIQUE index
--          cashbook_attachment_line_item_objectkey_uidx on
--          (line_item_id, proof_ref_key(file_url)) — one logical attachment identity;
--          shared slips (distinct line_item_id, same object) still allowed.

ROLLBACK;  -- NOT APPLIED — diff ends in ROLLBACK so an accidental run is a no-op.


-- ============================================================================
-- SECTION 3 — DROP / CREATE SUMMARY (storage.objects proof policies)
-- ----------------------------------------------------------------------------
-- DROPPED (6 of the 7 live storage.objects proof policies touched):
--   Authenticated_CRUD l4t6gw_0  (INSERT, unscoped)   -> removed
--   Authenticated_CRUD l4t6gw_1  (UPDATE, unscoped)   -> removed (overwrite now denied)
--   Authenticated_CRUD l4t6gw_2  (SELECT, unscoped)   -> removed (broad read closed)
--   Authenticated_CRUD l4t6gw_3  (DELETE, unscoped)   -> removed
--   cashbook_proofs insert/update/delete - active access -> dropped & recreated bucket-gated
-- CREATED:
--   cashbook_proofs insert/update/delete - active access (bucket AND (A OR B); leak closed)
--   proofs_select_scoped   (SELECT, per-congregation, non-Secretary, cast-safe)
--   proofs_insert_capture  (INSERT, uploader + exact editable period + capture role)
--   proofs_delete_correction (DELETE, capture role + editable period + no live references)
--   (no UPDATE policy on cashbook-proofs — overwrite denied by omission)
-- NET storage.objects proof policy count: 7 -> 7 (4 unscoped replaced by 3 scoped +
--   the 3 underscore policies rewritten in place). Plus the cashbook_attachment row
--   policies and dedupe index in the authored migration.
-- ============================================================================
-- END — NOT APPLIED. Diff of policy-definitions.sql (BEFORE, 2026-11-04) ->
-- supabase/migrations/20261012010000_tranche4_proof_access.sql (AFTER).
-- ============================================================================
