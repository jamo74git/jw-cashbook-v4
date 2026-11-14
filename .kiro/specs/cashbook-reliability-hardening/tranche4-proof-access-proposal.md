# Tranche 4 — Proof-access proposal (NOT APPLIED)

> **Scope:** proof-access proposal ONLY. No application changes, no SQL execution, no migrations,
> no deployment, no bucket/policy changes, no new buckets. All SQL below is marked `-- NOT APPLIED`.
> Retain `cashbook-proofs` (hyphen) and every existing object/path. Do NOT migrate to another bucket.
> This document stops before implementation.

---

## Summary answer (read this first)

**The task asked me to VERIFY the current live bucket/policy configuration and then propose scoped,
private proof access.** The live read-only queries were executed by the orchestrator via Supabase MCP
against project `cwdyixafvylzgtpsfmwr` on **2026-10-20**; Section A below is now **VERIFIED-LIVE** with
the verbatim results, and the DROP POLICY statements in Section B use the **real** policy names.

**The single most important live finding (new P1):** making the hyphen bucket private **closed the
anonymous public-URL read hole but did NOT secure proofs.** The user's four manual policies on
`cashbook-proofs` (`"Authenticated_CRUD l4t6gw_0..3"`) are **UNSCOPED** — their only predicate is
`bucket_id = 'cashbook-proofs'`, with **no hierarchy scope, no role gate, and no period-state lock**.
That means **any authenticated user can SELECT / INSERT / UPDATE / DELETE EVERY proof across ALL
congregations (cross-tenant)** right now. The scoped `"cashbook_proofs … active access"` policies that
DO carry hierarchy scope target the **underscore** bucket `cashbook_proofs`, which the app does not use.
So privacy was tightened against anonymous URLs but the authenticated blast radius is wide open — the
scoped policies in Section B must replace the four unscoped ones. Both buckets are confirmed PRIVATE.

Everything grounded in the repository was verified in source and is reported with file:line citations:

- **Proof uploads** are written by `src/utils/syncEngine.ts` to `PROOF_BUCKET = "cashbook-proofs"`
  (hyphen) via `supabase.storage.from(PROOF_BUCKET).upload(path, blob)`, and the stored
  `cashbook_attachment.file_url` is a **permanent public URL** from `getPublicUrl(path).data.publicUrl`
  (`syncEngine.ts` `uploadProof`, line ~269).
- **Proof reads** flow through exactly **one** component: `src/audit/ProofLink.tsx`, which renders the
  stored `file_url` as an `<a href>` opened in a new tab. Its only caller is
  `src/audit/AuditReviewPage.tsx` (three render sites). No other component reads proofs (the Overseer/HO
  review surfaces under `src/review/*` contain no `file_url`/attachment/storage references — verified by
  grep).
- Because both buckets are now **private**, every `getPublicUrl` link returns **403/forbidden** to
  anonymous/unauthenticated fetches, so **existing proof viewing is broken** for live and cached-PWA
  clients until the app is changed to mint short-lived signed URLs. This is the central break this
  proposal addresses — alongside the cross-tenant authenticated CRUD hole above.
- The **permission matrix** (`src/lib/permissions.ts`) gives `banking.proof_view` = **Secretary `-`
  (denied)**, all other roles `V`; `banking.upload_proof` = **Elder `O`, Chairperson `C`, Treasurer
  `C`**, everyone else `-` (so Auditor/Overseer/Apostle/HO/Secretary cannot upload). These drive the
  SELECT/INSERT policy design in Section B and the test matrix in Section D.

**Proposed direction (matches design.md §7):** keep the bucket private; store a **durable versioned
object key + bucket id + integrity metadata** in `cashbook_attachment` instead of a permanent URL;
retrieve proofs through **short-lived scoped signed URLs** minted on demand; back the authorisation with
hierarchy-scoped `storage.objects` policies that reuse `get_my_hierarchy_ids()` (confirmed live as the
correct scoping helper) and `get_my_role()` (confirmed live) for role gating + the folder-path
congregation id, with UPDATE/DELETE locked to HO correction + permitted parent state. Draft SQL is in
Section B, **NOT APPLIED**, and the DROP POLICY statements use the **verified** policy names
`"Authenticated_CRUD l4t6gw_0..3"`.

**STATUS: proposal only — NOT APPLIED; no code/SQL/bucket changes made.** (Full status line repeated at
the end.)

---

## A. Verified current bucket/policy facts

> **A0 — Verification status: VERIFIED-LIVE (2026-10-20).** The read-only queries below were executed
> against the live project `cwdyixafvylzgtpsfmwr` ("jw-cashbook-v4") via Supabase MCP and the verbatim
> results are recorded here. These results **SUPERSEDE** the stale bucket/policy facts in
> `tranche2-inspection.md` (which predate the user's manual dashboard changes). The query text is kept
> for reproducibility.

### A1. Buckets — VERIFIED-LIVE

```sql
select id, name, public, file_size_limit, allowed_mime_types from storage.buckets order by id;
```

Verbatim result:

```json
[
  {"id":"cashbook_proofs","public":false,"file_size_limit":null,    "allowed_mime_types":["image/*"]},
  {"id":"cashbook-proofs","public":false,"file_size_limit":52428800,"allowed_mime_types":["image/*"]}
]
```

**Facts:** BOTH buckets are now **PRIVATE** (`public = false`). The app uses the **HYPHEN** bucket
`cashbook-proofs` (`syncEngine.ts PROOF_BUCKET`), which has a 50 MB file-size limit and `image/*` MIME
restriction. The **UNDERSCORE** bucket `cashbook_proofs` also exists, is private, has no size limit, and
is **not used by the app**. The scoped policies in A2 that carry hierarchy scope target the UNUSED
underscore bucket, not the hyphen bucket the app writes to.

### A2. storage.objects policies — VERIFIED-LIVE

```sql
select policyname, cmd, roles, qual, with_check
from pg_policies where schemaname='storage' and tablename='objects' order by policyname;
```

Verbatim result (grouped by target bucket):

**On the HYPHEN bucket `cashbook-proofs` (the app's bucket) — the user's four manual policies, ALL UNSCOPED:**

| policyname | cmd | roles | USING (qual) | WITH CHECK |
|---|---|---|---|---|
| `Authenticated_CRUD l4t6gw_2` | SELECT | `{authenticated}` | `(bucket_id = 'cashbook-proofs'::text)` | `null` |
| `Authenticated_CRUD l4t6gw_0` | INSERT | `{authenticated}` | `null` | `(bucket_id = 'cashbook-proofs'::text)` |
| `Authenticated_CRUD l4t6gw_1` | UPDATE | `{authenticated}` | `(bucket_id = 'cashbook-proofs'::text)` | `null` **(WITH CHECK null on UPDATE)** |
| `Authenticated_CRUD l4t6gw_3` | DELETE | `{authenticated}` | `(bucket_id = 'cashbook-proofs'::text)` | `null` |

**On the UNDERSCORE bucket `cashbook_proofs` (NOT used by the app) — scoped but flawed:**

| policyname | cmd | roles | predicate (USING / WITH CHECK) |
|---|---|---|---|
| `cashbook_proofs insert - active access` | INSERT | `{authenticated}` | WITH CHECK: `((bucket_id='cashbook_proofs') AND ((storage.foldername(name))[1]::uuid IN (SELECT uha.congregation_id FROM user_hierarchy_access uha WHERE uha.user_id=auth.uid() AND uha.status='active'))) OR (EXISTS(SELECT 1 FROM user_hierarchy_access uha WHERE uha.user_id=auth.uid() AND uha.status='active' AND uha.scope_level<>'Congregation'))` |
| `cashbook_proofs update - active access` | UPDATE | `{authenticated}` | USING + WITH CHECK = same underscore-bucket scoped predicate |
| `cashbook_proofs delete - active access` | DELETE | `{authenticated}` | USING = same underscore-bucket scoped predicate |

**Critical finding (live P1 — cross-tenant authenticated CRUD):** on the HYPHEN bucket the app actually
uses, the **only** predicate is `bucket_id = 'cashbook-proofs'`. There is **no hierarchy scope, no role
gate, and no period-state check** on any of SELECT/INSERT/UPDATE/DELETE. Therefore **any authenticated
user can read, upload, overwrite, and delete EVERY proof in EVERY congregation** — a cross-tenant breach
of confidentiality AND evidence integrity. Making the bucket private only removed the anonymous
public-URL read path; the authenticated blast radius is wide open. Note additionally that the UPDATE
policy has `WITH CHECK = null`, so an UPDATE is unconstrained on the post-image. The scoped
`"cashbook_proofs … active access"` policies exist but bind to the WRONG bucket (`cashbook_proofs`
underscore) and, even on that bucket, (a) have an **operator-precedence bug** — the `OR EXISTS(… scope_level
<> 'Congregation')` is NOT parenthesised with the `bucket_id` check, so the see-all branch can match
regardless of bucket — and (b) carry **no role gate and no period-state lock**, so they would not satisfy
the totals-only / read-only / HO-correction constraints even if retargeted. The Section B policies
REPLACE the four unscoped hyphen-bucket policies and do NOT copy the flawed underscore ones.

**Exact DROP targets (verified names):** `"Authenticated_CRUD l4t6gw_0"`, `"Authenticated_CRUD l4t6gw_1"`,
`"Authenticated_CRUD l4t6gw_2"`, `"Authenticated_CRUD l4t6gw_3"`. (The underscore-bucket scoped policies
are left untouched — that bucket is unused and out of scope for this proposal; flagged for separate
review.)

### A3. `get_my_hierarchy_ids()` and `get_my_role()` — VERIFIED-LIVE

- **`get_my_hierarchy_ids()`** — `SECURITY DEFINER`, `STABLE`, `search_path = ''` (hardened). Returns
  **`SETOF uuid`** = the congregation ids the caller may see, derived from `user_hierarchy_access`
  filtered by `status = 'active'` **AND** `start_date <= now()` **AND** (`end_date IS NULL OR end_date >=
  now()`), unioned across Congregation/Overseership/Apostleship/District/Eldership scopes **plus**
  `ho_district_assignments`. This is the **correct scoping helper to reuse** for hierarchy scope, and
  because it already enforces the active + date-window check (R-invariant: access is time-bounded), the
  Section B policies inherit that enforcement for free. The `SETOF uuid` return confirms
  `(storage.foldername(name))[1]::uuid IN (SELECT get_my_hierarchy_ids())` type-checks.
- **`get_my_role()`** — `SECURITY DEFINER`, `search_path = ''`, **anon hard-block** (raises `42501`),
  role-rank ordering `SUPER_ADMIN > HO > Apostle > Overseer > Elder > Chairperson > Treasurer > Auditor >
  Secretary`, **fail-closed null** when no active role. This is the helper used in Section B to express
  **role gating** server-side: `get_my_role() = 'HO'` for HO-only correction DELETE, and
  `get_my_role() <> 'Secretary'` for the totals-only SELECT exclusion (defence in depth alongside the UI
  gate). The earlier dependency on confirming this helper is now RESOLVED.

### A4. `cashbook_attachment` columns + RLS — VERIFIED-LIVE

**Columns (verbatim):** `id uuid NOT NULL`; `line_item_id uuid NOT NULL` (FK → `cashbook_line_item`);
`file_url text NOT NULL` (**currently stores a PUBLIC url**); `uploaded_by uuid`; `uploaded_at
timestamptz`; `transaction_date date`; `bank_reference text`; `congregation_id uuid NOT NULL`.

- There is **NO `period_id` on the attachment** and **NO `bucket_id` / `object_key` / `byte_size` /
  `checksum` column**. The parent PERIOD is reached only via `line_item_id → cashbook_line_item.period_id
  → cashbook_period.status`. This is the linkage the period-state gate must traverse.
- `file_url` is `NOT NULL` and holds a URL today — storing a durable object key + integrity metadata
  requires an **additive column migration** (carried as a dependency in Section F, not done here).

**Attachment RLS (public schema), VERIFIED-LIVE:** SELECT + INSERT scope by `congregation_id IN
(my congregations) OR scope_level <> 'Congregation'` (the broad see-all clause, tranche2 Finding 2/P4
confirmed still present); **UPDATE/DELETE are scoped to `congregation_id` ONLY — no period-state lock and
no role gate.** This means a congregation-scoped user can currently UPDATE/DELETE attachment ROWS for an
approved/locked period. This weakness is carried into the Section D test matrix as the current state and
is a motivation for routing proof mutation through the period-state-aware model; however, per the brief's
bounds, THIS proposal changes only **storage.objects** policies + the read/upload callers, and REPORTS
the attachment-table RLS weakness for separate remediation rather than altering it here.

### A5. `period_status` enum + lock representation — VERIFIED-LIVE

**Enum labels (sortorder) verbatim:** `Draft(1), Submitted(2), AuditApproved(3), SubmittedToOverseer(3.5),
Rejected(4), SubmittedToHO(5), HOReviewed(6)`. There are **NO `OverseerApproved`/`OverseerRejected`
labels** (confirms tranche2 Finding 5 / the D-8 discrepancy where `src/review/OverseerReview.tsx` writes
labels that do not exist server-side — out of scope here, but it means any status gate must use only the
seven real labels).

**Lock representation (design.md §2.4, consistent with the live enum):** there is **no lock table** (SD-1
superseded). "Locked" = any status **at or after `Submitted`** — i.e. `status IN ('Submitted',
'AuditApproved','SubmittedToOverseer','SubmittedToHO','HOReviewed')` — unless an HO correction is in
effect; `SubmittedToHO` is the final month lock; **only HO may correct/unlock**. Editable = `Draft` or
`Rejected`. The Section B period-state gate uses these exact labels via the `line_item → period` join.

### A6. Divergences from tranche2-inspection.md (resolved against live)

| tranche2 said | VERIFIED-LIVE (2026-10-20) | Change |
|---|---|---|
| `cashbook-proofs` (hyphen) `public = TRUE` + `"Allow public reads"` (role `public`) | `public = FALSE`; four `Authenticated_CRUD l4t6gw_0..3` policies, role `authenticated`, **all unscoped** | **CONFIRMED CHANGED** — bucket now private; public-read policy gone; replaced by unscoped authenticated CRUD (new live P1) |
| `cashbook_proofs` (underscore) private with scoped policies | STILL present, private, with the three `… active access` scoped policies (bound to the underscore bucket; precedence bug noted) | Unchanged; still the unused bucket |
| Proof reads work via public URL | public URLs now **403** to anonymous fetches; reads broken until signed URLs ship | CONFIRMED |
| Attachment SELECT/INSERT scoped `OR scope_level <> 'Congregation'`; no scoped UPDATE/DELETE | SELECT/INSERT see-all clause CONFIRMED present; UPDATE/DELETE scoped to `congregation_id` only, **no period-state lock, no role gate** | CONFIRMED (slightly more detail than tranche2) |

---

## B. Proposed SQL (DRAFT — NOT APPLIED)

> **BEGIN/ROLLBACK is a drafting precaution, not a guarantee that executing this file is harmless.**
> Do NOT run this file. The four `DROP POLICY` names below are the **VERIFIED-LIVE** names from A2
> (`Authenticated_CRUD l4t6gw_0..3` on the hyphen bucket). The predicates use the VERIFIED-LIVE helpers
> `get_my_hierarchy_ids()` (`SETOF uuid`, A3) and `get_my_role()` (A3), and the VERIFIED-LIVE
> `cashbook_period` status labels (A5) reached via `cashbook_attachment.line_item_id →
> cashbook_line_item.period_id → cashbook_period` (A4). This refines `tranche3-migration-draftsql.txt`
> §F; it does **not** copy it — §F lacked the parent-state lock, the HO-only correction gate, and the
> proof-view/Secretary exclusion worked out below, and §F's `UPDATE storage.buckets SET public=FALSE`
> is already done manually so it is omitted.

```sql
-- ============================================================================
-- Tranche 4 DRAFT — proof-access storage.objects policies  --  NOT APPLIED
-- Project (authoritative): cwdyixafvylzgtpsfmwr ("jw-cashbook-v4")
-- Bucket retained: 'cashbook-proofs' (hyphen). No bucket migration. No new bucket.
-- Run `supabase db pull` first; substitute real policy names from query A2.
-- ============================================================================
BEGIN;  -- NOT APPLIED — drafting precaution only

-- The bucket is ALREADY private (user did this in the dashboard). This proposal
-- does NOT change storage.buckets. The following line is intentionally omitted:
--   UPDATE storage.buckets SET public = FALSE WHERE id = 'cashbook-proofs';  -- NOT APPLIED / NOT NEEDED

-- 0. Drop the four VERIFIED-LIVE unscoped hyphen-bucket policies (A2). -- NOT APPLIED
DROP POLICY IF EXISTS "Authenticated_CRUD l4t6gw_0" ON storage.objects;  -- INSERT  -- NOT APPLIED
DROP POLICY IF EXISTS "Authenticated_CRUD l4t6gw_1" ON storage.objects;  -- UPDATE  -- NOT APPLIED
DROP POLICY IF EXISTS "Authenticated_CRUD l4t6gw_2" ON storage.objects;  -- SELECT  -- NOT APPLIED
DROP POLICY IF EXISTS "Authenticated_CRUD l4t6gw_3" ON storage.objects;  -- DELETE  -- NOT APPLIED
-- (The underscore-bucket "cashbook_proofs … active access" policies are NOT touched — that
--  bucket is unused and out of scope; flag for separate review.)                 -- NOT APPLIED

-- 1. SELECT (read / signed-URL mint): hierarchy scope via folder[1] congregation. -- NOT APPLIED
--    Proof-view authority (banking.proof_view) is held by HO/Apostle/Overseer/
--    Elder/Chairperson/Treasurer/Auditor; Secretary = '-' (denied). RLS cannot read
--    the app permission matrix, so the Secretary exclusion is enforced in TWO places:
--    (a) the app never mints a signed URL for a Secretary (ProofLink hidden — Section C);
--    (b) OPTIONALLY a role predicate here if get_my_role() exists (see note).
CREATE POLICY proofs_select_scoped ON storage.objects  -- NOT APPLIED
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'cashbook-proofs'
    AND (storage.foldername(name))[1]::uuid IN (SELECT get_my_hierarchy_ids())
    -- get_my_role() is VERIFIED-LIVE (A3): exclude Secretary (totals-only) server-side too.
    AND get_my_role() <> 'Secretary'
  );

-- 2. INSERT (capture upload): hierarchy scope + uploader path segment = caller +
--    parent period must be EDITABLE (Draft/Rejected) OR a declared-outstanding
--    finalisation while Submitted. folder[1]=congregationId, folder[5]=capturedByUserId.
--    NOTE: the object is uploaded BEFORE the cashbook_attachment row exists, so the
--    parent link cannot be proven via the attachment FK at upload time. The smallest
--    secure dependency is the PATH CONVENTION validated against get_my_hierarchy_ids()
--    (folder[1]) AND auth.uid() (folder[5]) AND an EXISTS check that the congregation
--    has an editable period for that week/service (derived from folder[3]/folder[4]).
CREATE POLICY proofs_insert_scoped ON storage.objects  -- NOT APPLIED
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'cashbook-proofs'
    AND (storage.foldername(name))[1]::uuid IN (SELECT get_my_hierarchy_ids())
    AND (storage.foldername(name))[5]::uuid = auth.uid()
    -- Parent-state dependency (see Section F): require an editable (or Submitted-with-
    -- declared-outstanding) period in this congregation. folder[4] = '{service}_{weekKey}'.
    AND EXISTS (
      SELECT 1
      FROM public.cashbook_period cp
      WHERE cp.congregation_id = (storage.foldername(name))[1]::uuid
        -- week/service linkage from the path; cp column names (week_key/service) NOT in the
        -- supplied live facts — confirm before enabling these two lines:
        -- AND cp.week_key = split_part((storage.foldername(name))[4], '_', 2)
        -- AND cp.service  = split_part((storage.foldername(name))[4], '_', 1)
        AND cp.status IN ('Draft','Rejected','Submitted')  -- VERIFIED-LIVE labels (A5);
        -- Submitted allowed ONLY for declared-outstanding finalisation, enforced precisely
        -- by the finalisation RPC. Editable = Draft/Rejected; everything >= Submitted is locked.
    )
  );

-- 3. UPDATE: DENY by omission for ordinary users. Overwriting an existing object key
--    is NOT permitted (design §7.4 — a replacement is a NEW versioned key, a new INSERT,
--    gated by the finalisation RPC). Provide NO general UPDATE policy. This also fixes the
--    live bug where "Authenticated_CRUD l4t6gw_1" (UPDATE) had WITH CHECK = null. If an
--    explicit HO-only correction UPDATE is ever required, it must be gated on HO role +
--    parent state; uploader identity / congregation membership ALONE is insufficient:
-- CREATE POLICY proofs_update_ho_correction ON storage.objects  -- NOT APPLIED
--   FOR UPDATE TO authenticated
--   USING (
--     bucket_id = 'cashbook-proofs'
--     AND get_my_role() = 'HO'                                   -- VERIFIED-LIVE helper (A3)
--     AND (storage.foldername(name))[1]::uuid IN (SELECT get_my_hierarchy_ids())
--   )
--   WITH CHECK (  -- MUST set a WITH CHECK (the live UPDATE policy omitted it)
--     bucket_id = 'cashbook-proofs'
--     AND get_my_role() = 'HO'
--     AND (storage.foldername(name))[1]::uuid IN (SELECT get_my_hierarchy_ids())
--   );

-- 4. DELETE: HO correction ONLY, and only for a parent period in a permitted state.
--    Auditors / read-only roles and ordinary capturers are DENIED.
CREATE POLICY proofs_delete_ho_only ON storage.objects  -- NOT APPLIED
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'cashbook-proofs'
    AND get_my_role() = 'HO'                                     -- VERIFIED-LIVE helper (A3)
    AND (storage.foldername(name))[1]::uuid IN (SELECT get_my_hierarchy_ids())
  );

ROLLBACK;  -- NOT APPLIED — this draft ends in ROLLBACK so an accidental run is a no-op.
-- ============================================================================
-- END DRAFT — NOT APPLIED
-- ============================================================================
```

**Design notes on the SQL (why these predicates):**

- **Upload-before-attachment problem (explicitly required by the brief):** the proof object is uploaded
  first and the `cashbook_attachment` row is inserted afterwards (`syncEngine.ts` `syncLineItem`), so at
  INSERT time there is no attachment FK to prove the parent relationship. The **smallest secure
  dependency** is therefore the **upload path convention** validated against `get_my_hierarchy_ids()`
  (folder[1] = congregation the caller may see) **plus** `auth.uid()` (folder[5] = the uploader is the
  caller) **plus** an `EXISTS` on an **editable/declared-outstanding `cashbook_period`** for that
  congregation+week+service. This binds the upload to a real, permitted parent period without inventing
  a new table — but it depends on the path `{service}_{weekKey}` segment being parseable and on
  confirming `cashbook_period.week_key`/`service` column names (A4/A5). If that parse is not robust, the
  smallest additional dependency is a **server-side INSERT RPC** (design §6.7 `cashbook_finalize_proof`
  / the attachment-insert RPC in §6.1-G) that derives the period from the path and sets the key — see
  Section F.
- **Overwrite is never granted (design §7.4, R6.5/R14.7):** a corrected proof is a new `proofId/version`
  → a new key → a fresh INSERT. No UPDATE policy is created for ordinary users, so a previously issued
  upload permission cannot alter approved evidence at an existing key. This is why ordinary uploads do
  **not** need overwrite permission (brief requirement 2).
- **Secretary totals-only (T):** base RLS cannot read the app permission matrix, but `get_my_role()` is
  now **VERIFIED-LIVE (A3)** and returns the caller's role server-side. The Secretary exclusion is
  therefore enforced in **two** layers: (a) in the app, never mint a signed URL / never render ProofLink
  for a Secretary (Section C); AND (b) server-side in the SELECT policy via `get_my_role() <>
  'Secretary'`. This is defence in depth, no longer a pending dependency.
- **Auditors read but never modify:** Auditor has `banking.proof_view = V` (may read) and
  `banking.upload_proof = '-'`, `audit.*` does not grant object writes — so Auditor is covered by the
  SELECT policy and DENIED by the absence of any INSERT/UPDATE/DELETE grant (no auditor congregation
  path match anyway for INSERT, and no HO role for DELETE).

---

## C. Affected upload/read callers

| File:line | Upload / Read | Current behaviour | Proposed change |
|---|---|---|---|
| `src/utils/syncEngine.ts` `uploadProof` (~266–270) | **Upload** | `supabase.storage.from('cashbook-proofs').upload(path, blob)` then returns `getPublicUrl(path).data.publicUrl`. Path `{cong}/{yr}/{mo}/{service}_{weekKey}/{userId}/{ts}-{suffix}.{ext}` (second-precision ts; folder[1]=cong, folder[5]=userId). | Stop returning/storing a public URL. Return the **object key** (the `path`) + bucket id. Upload stays; the function returns `{ bucketId: 'cashbook-proofs', objectKey: path }` for the caller to persist. (Versioning per design §5.4 is a separate reliability change; minimally, persist the key not the URL.) |
| `src/utils/syncEngine.ts` `syncLineItem` attachment insert (~210) | Upload (writes `file_url`) | Inserts `cashbook_attachment { file_url: <publicUrl>, … }`. | Insert a **durable object reference** instead: store `objectKey` (+ `bucket_id`, + integrity metadata: `byte_size`, `checksum`) rather than `file_url=publicUrl`. Requires an added column (see Section F — attachment schema). |
| `src/utils/syncEngine.ts` `syncDepositSlip` attachment insert (~243) | Upload (writes `file_url`) | Same as above for the shared bulk-cash deposit slip (one object, one attachment per banked item). | Same: store the object key once; each banked item's attachment references the same key (shared deposit-slip linkage preserved — CON-STORAGE3). |
| `src/audit/ProofLink.tsx` (`ProofLink({ url })`) | **Read** | Renders stored `file_url` as `<a href target=_blank>`; green clip when present, red when missing. | Change the prop to an **object reference** (`{ bucketId, objectKey }` or attachment id). On click/hover, call `StoragePort.getSignedUrl(key, ttl)` (design §7.2) to mint a **short-lived signed URL**, then open it. Handle null (unauthorised/expired) by showing the "missing/denied" state. Hide entirely for Secretary (totals-only). |
| `src/audit/AuditReviewPage.tsx` (~120 select; ~256/~395/~427 render) | **Read** | Selects `cashbook_attachment.file_url` and passes `att?.file_url` to `<ProofLink url=…>` at three sites. | Select the **object key + metadata** columns instead of `file_url`; pass the reference to the updated `ProofLink`. Keep the existing in-memory line-item filtering (Finding 20 is a separate issue; not in scope here). Secretary must not reach this page's proof column (totals-only). |
| `src/lib/imageCompress.ts` | neither (context) | Client compression before upload. | No change. |
| `src/review/OverseerReview.tsx`, `src/review/HOReview.tsx` | neither | No `file_url`/attachment/storage references (verified by grep). | No change (brief bounds the work away from Overseer approval components). |

**New shared piece (design §7.2):** introduce a thin `StoragePort` with `getSignedUrl(key, ttlSeconds)`
(+ `upload`, `stat`, `remove`) so `ProofLink`/viewer/sync depend on it rather than `supabase.storage`
directly. Minting signed URLs at view time is what restores private viewing.

---

## D. Role / action / state test matrix (expected ALLOW / DENY)

Roles: HO, Apostle, Overseer, Elder, Chairperson, Treasurer, Auditor, Secretary. Parent period state:
Draft / Submitted / Approved(AuditApproved+) / Locked(SubmittedToHO/HOReviewed). All rows assume the
object is **in the caller's hierarchy scope** unless the row says cross-hierarchy.

### SELECT (read / signed-URL mint)

| Role | Draft | Submitted | Approved | Locked | Cross-hierarchy (any state) |
|---|---|---|---|---|---|
| HO | ALLOW | ALLOW | ALLOW | ALLOW | DENY (unless in HO district scope) |
| Apostle | ALLOW | ALLOW | ALLOW | ALLOW | DENY |
| Overseer | ALLOW | ALLOW | ALLOW | ALLOW | DENY |
| Elder | ALLOW | ALLOW | ALLOW | ALLOW | DENY |
| Chairperson | ALLOW | ALLOW | ALLOW | ALLOW | DENY |
| Treasurer | ALLOW | ALLOW | ALLOW | ALLOW | DENY |
| Auditor | ALLOW | ALLOW | ALLOW | ALLOW | DENY |
| **Secretary** | **DENY** | **DENY** | **DENY** | **DENY** | **DENY** (totals-only, `banking.proof_view='-'`) |

### INSERT (upload)

| Role | Draft | Submitted (declared-outstanding only) | Approved | Locked |
|---|---|---|---|---|
| Elder (O) | ALLOW | ALLOW (declared-outstanding) | DENY | DENY |
| Chairperson (C) | ALLOW | ALLOW (declared-outstanding) | DENY | DENY |
| Treasurer (C) | ALLOW | ALLOW (declared-outstanding) | DENY | DENY |
| HO / Apostle / Overseer / Auditor / Secretary | DENY | DENY | DENY | DENY (`banking.upload_proof='-'`) |

Additional INSERT denials (all roles): folder[5] ≠ `auth.uid()` → DENY; folder[1] ∉
`get_my_hierarchy_ids()` → DENY; **overwrite of an existing key → DENY**; undeclared proof after
Submitted → DENY (finalisation RPC); any upload to an Approved/Locked period → DENY.

### UPDATE

| Role | Any state |
|---|---|
| All roles | **DENY** (no general UPDATE policy; overwrite forbidden — replacement = new key via INSERT). HO "correction UPDATE" only if explicitly added later, gated on HO role + permitted parent state. |

### DELETE

| Role | Draft | Submitted | Approved | Locked |
|---|---|---|---|---|
| HO | ALLOW (correction, permitted parent state) | ALLOW (correction) | ALLOW (correction) | ALLOW (HO-only unlock/correct) |
| Apostle/Overseer/Elder/Chairperson/Treasurer | DENY | DENY | DENY | DENY |
| **Auditor** | **DENY** | **DENY** | **DENY** | **DENY** (read-only role — must not modify/delete) |
| Secretary | DENY | DENY | DENY | DENY |

**Explicit DENIED cases the brief named:** Secretary proof read → DENY (all states). Auditor delete →
DENY. Non-HO update/delete of a locked proof → DENY. Cross-hierarchy read → DENY. Ordinary-upload
overwrite of existing evidence → DENY.

**CURRENT LIVE STATE (the gap this matrix closes) — for contrast:** under the VERIFIED-LIVE policies
(A2), the hyphen-bucket `storage.objects` policies grant **every authenticated user ALLOW on
SELECT/INSERT/UPDATE/DELETE in every cell above, cross-hierarchy included** (predicate is only
`bucket_id`). Separately, `cashbook_attachment` ROW UPDATE/DELETE (A4) is congregation-scoped but has
**no period-state lock and no role gate**, so today a congregation-scoped user can mutate attachment rows
for an Approved/Locked period. The storage-policy half of this gap is closed by Section B; the
attachment-row-RLS half is reported in Section F as a separate remediation (bounded out of this proposal).

---

## E. Deployment + cached-client handling + privacy-preserving rollback

**Ordering (app change leads, bucket is already private):**

1. **The bucket is already private**, so anonymous public-URL viewing is **already broken** for every
   client using `getPublicUrl`. But note the live cross-tenant authenticated CRUD hole (A2) means the
   scoped policy tightening in Section B is also urgent on its own — it is a confidentiality/integrity
   fix, not merely a viewing fix.
2. **Ship the app read change FIRST:** `StoragePort.getSignedUrl` + updated `ProofLink`/`AuditReviewPage`
   that mint short-lived signed URLs from an object key. This restores viewing for NEW reads immediately,
   because signed URLs work on a private bucket regardless of policy changes (RLS still gates the mint).
3. **Legacy row backfill (design §7.3):** existing `cashbook_attachment.file_url` rows hold public URLs.
   Parse the object key out of each stored public URL
   (`…/storage/v1/object/public/cashbook-proofs/<KEY>` → `<KEY>`), verify existence with `stat()`, and
   persist the key (+ bucket id) into the new reference column. Rows that cannot be mapped are **retained
   and flagged, never deleted**. The signed-URL reader should accept either a stored key or a
   key-parsed-from-legacy-URL during the transition.
4. **Then apply the scoped `storage.objects` policies** (Section B) — the four DROP names are confirmed
   (A2). The SELECT policy restricts who can mint a signed URL to in-scope non-Secretary authenticated
   users; INSERT/UPDATE/DELETE are tightened to capture roles / HO correction. This is a tightening that
   also closes the live cross-tenant hole; sequence it so the app read change (step 2) is live first, so
   legitimate in-scope readers are not interrupted.
5. **Ship the upload change** (store key not URL) alongside or just after, so new uploads stop writing
   public URLs.

**Cached PWA builds calling `getPublicUrl`:** a cached service-worker build will keep generating public
URLs that now 403. Mitigations: (a) the app uses `registerType: 'prompt'` with `ReloadPrompt`
(`src/pwa/ReloadPrompt.tsx`) — prompt users to update so the new signed-URL reader loads; (b) the new
`ProofLink` must treat a 403/expired/null signed URL as the "proof unavailable — refresh app" state
rather than a hard error; (c) because reads now go through a key→signed-URL mint, a stale cached build
that still stores public URLs on upload is a correctness problem — gate the upload change behind the app
update and backfill any public URLs written during the transition window.

**Signed-URL expiry in the UI:** signed URLs are short-lived (e.g. 60–300s). Mint on demand at
click/hover, not at list render; if an opened URL expires, re-mint on retry. Never cache a signed URL in
IndexedDB or the attachment row (that would recreate the permanent-URL problem).

**Privacy-preserving rollback (the bucket stays private throughout):** if the policy change or app
change misbehaves, roll back by (a) **reverting the `storage.objects` policies** to the
previously-captured four definitions (verbatim in A2 — but note those four are the INSECURE unscoped
policies, so a rollback to them re-opens the cross-tenant hole; prefer rolling back only the APP and
keeping the scoped policies, or fall back to the scope-only SELECT below) and/or (b)
reverting the app to the prior build via the normal deploy rollback — **NOT** by making the bucket
public. Making the bucket public again is explicitly **prohibited** as a rollback. If viewing must be
restored urgently while policies are reverted, the safe lever is a **broader-but-still-authenticated
SELECT policy** (e.g. scope-only, no role predicate) that still requires a signed URL — never
`public = TRUE`.

---

## F. Blocking dependencies (genuine blockers only)

**Resolved since first draft (no longer blockers):** live verification is now complete (Section A,
VERIFIED-LIVE 2026-10-20 via orchestrator MCP) — the four real policy names, both bucket privacy flags,
`get_my_hierarchy_ids()` (`SETOF uuid`, active+date-window scoped) and `get_my_role()` (role-ranked,
fail-closed) definitions, the `cashbook_attachment` columns/RLS, and the `period_status` labels are all
confirmed. The earlier "cannot query" blocker and the "confirm `get_my_role()`" dependency are closed.

Remaining genuine dependencies:

1. **Attachment schema lacks a durable object-key column.** `cashbook_attachment` stores only
   `file_url NOT NULL` (a public URL); there is **no `bucket_id` / `object_key` / `byte_size` /
   `checksum` column** (VERIFIED-LIVE, A4). Storing a durable versioned object reference + integrity
   metadata (design §7.1/§7.5) **requires an additive column migration** (and, because `file_url` is
   `NOT NULL`, either keep writing it during transition or relax the constraint). That schema change is
   out of this proposal's scope (reliability tranche), but the proof-access cutover depends on it: until
   the key column exists, the signed-URL reader must parse keys out of legacy public URLs. *Reported;
   not changed here.*

2. **Upload-time parent linkage needs the path convention confirmed (and possibly an RPC).** The object
   is uploaded before the `cashbook_attachment` row exists and the attachment has **no `period_id`**
   (A4), so the INSERT policy proves the parent period via the folder path (folder[1] congregation +
   folder[5] uploader + an `EXISTS` on a `cashbook_period` in an editable/`Submitted` state). The
   `period_status` labels are confirmed (A5), but the **`cashbook_period.week_key` / `service` column
   names were NOT in the supplied live facts** and must be confirmed before the two commented
   path-parse lines are enabled; if the `{service}_{weekKey}` parse is not robust, the smallest
   additional dependency is a **server-side INSERT/finalisation RPC** (design §6.7 / §6.1-G) that
   derives the period from the path. *Reported; not assumed independent.*

3. **Attachment-row RLS weakness (reported, bounded out).** `cashbook_attachment` UPDATE/DELETE are
   congregation-scoped with **no period-state lock and no role gate** (VERIFIED-LIVE, A4), so a
   congregation-scoped user can currently mutate attachment ROWS for an Approved/Locked period. This
   proposal changes only `storage.objects` policies + the read/upload callers (per the brief's bounds),
   so the attachment-row-RLS tightening is **reported here for separate remediation**, not changed. It
   does not block the storage-policy cutover but should be sequenced with it for complete coverage.

4. **Unused underscore bucket `cashbook_proofs` (reported, out of scope).** Its three
   `… active access` policies have an **operator-precedence bug** (the `OR scope_level <> 'Congregation'`
   see-all branch is not parenthesised with the `bucket_id` check) and no role/period gate. The app does
   not use this bucket, so it is out of scope, but flag it for cleanup/decommission review.

No other blockers. The hyphen bucket, `get_my_hierarchy_ids()`, `get_my_role()`, and the
`line_item → period` join are sufficient for the SELECT/INSERT scope, the role gating, and the
parent-state lock proposed in Section B.

---

STATUS: proposal only — NOT APPLIED; no code/SQL/bucket changes made.
