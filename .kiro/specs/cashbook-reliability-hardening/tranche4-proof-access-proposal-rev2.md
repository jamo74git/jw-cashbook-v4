# Tranche 4 (rev2) — Proof-access proposal, CORRECTION PASS (NOT APPLIED)

> **This supersedes the SQL/analysis in `tranche4-proof-access-proposal.md`.** It is a correction
> pass on the same Feature Spec work — NOT a new spec. Scope: proof-access proposal ONLY; stop before
> implementation. No application changes, no mutating SQL, no migrations, no deployment, no bucket
> changes. Targeted read-only inspection was used to re-verify policies/columns. Overseer
> approval/rejection, status mappings, `period_status` enum, financial gates, and interim-officer
> capture UX are left unchanged. Retain the `cashbook-proofs` (hyphen) bucket and every existing
> object/path; do NOT migrate to the `cashbook_proofs` (underscore) bucket.
>
> **Separate defect recorded (not fixed here):** interim-officer capture UX — tracked for its own pass.

Project: `cwdyixafvylzgtpsfmwr` ("jw-cashbook-v4"). Live re-verification date: **2026-10-20**.

---

## What draft 1 got wrong (why this rev exists)

1. **Missed cross-bucket policy leakage.** Draft 1 proposed dropping only the four
   `Authenticated_CRUD l4t6gw_0..3` policies and said to "leave the underscore-bucket policies
   untouched." That is unsafe: the three `cashbook_proofs … active access` policies place the
   `OR (EXISTS … scope_level <> 'Congregation')` branch **outside** the bucket condition. Because
   PostgreSQL combines PERMISSIVE policies with OR, that branch grants INSERT/UPDATE/DELETE on **any**
   bucket — including the hyphen `cashbook-proofs` bucket — to any user holding a non-Congregation
   scope row (Overseer/Apostle/HO). They MUST be corrected, not left alone.
2. **Used the single highest role (`get_my_role()`) as INSERT/SELECT authority.** That is wrong for a
   multi-congregation user: it decides authority globally, not in the target congregation. Replaced with
   a per-congregation, time-valid `user_hierarchy_access` check.
3. **Made DELETE HO-only.** That silently removed ordinary capture-role correction rights. Corrected to
   preserve ordinary correction (capture role + editable parent state) AND HO correction (any state).
4. **Treated an undeployed finalisation RPC as if it protected Submitted-state uploads.** Corrected: the
   sync ordering is traced below; Submitted-state uploads must be permitted for offline-queued proofs,
   and the RPC that would distinguish declared-outstanding finalisation from arbitrary upload is
   identified as a genuine (undeployed) dependency, not claimed as existing protection.

---

## A. Verified current bucket/policy facts (re-verified live 2026-10-20)

### A1. Buckets
`select id, name, public, file_size_limit, allowed_mime_types from storage.buckets;`
```json
[ {"id":"cashbook_proofs","public":false,"file_size_limit":null,"allowed_mime_types":["image/*"]},
  {"id":"cashbook-proofs","public":false,"file_size_limit":52428800,"allowed_mime_types":["image/*"]} ]
```
Both buckets are PRIVATE. The app uses the HYPHEN bucket `cashbook-proofs` (50 MB limit, `image/*`).

### A2. All `storage.objects` policies (full predicates, permissive)
All seven policies are PERMISSIVE, role `{authenticated}`. Grouped by the bucket each legitimately targets:

**Hyphen bucket `cashbook-proofs` — four UNSCOPED policies (predicate = bucket id only):**

| policyname | cmd | USING (qual) | WITH CHECK |
|---|---|---|---|
| `Authenticated_CRUD l4t6gw_2` | SELECT | `(bucket_id = 'cashbook-proofs')` | — |
| `Authenticated_CRUD l4t6gw_0` | INSERT | — | `(bucket_id = 'cashbook-proofs')` |
| `Authenticated_CRUD l4t6gw_1` | UPDATE | `(bucket_id = 'cashbook-proofs')` | `null` (no WITH CHECK) |
| `Authenticated_CRUD l4t6gw_3` | DELETE | `(bucket_id = 'cashbook-proofs')` | — |

**Underscore bucket `cashbook_proofs` — three policies whose OR-branch LEAKS to all buckets:**

| policyname | cmd | predicate (USING and/or WITH CHECK) |
|---|---|---|
| `cashbook_proofs insert - active access` | INSERT | `((bucket_id='cashbook_proofs' AND foldername[1]::uuid IN (SELECT uha.congregation_id FROM user_hierarchy_access uha WHERE uha.user_id=auth.uid() AND uha.status='active')) OR (EXISTS (SELECT 1 FROM user_hierarchy_access uha WHERE uha.user_id=auth.uid() AND uha.status='active' AND uha.scope_level<>'Congregation')))` |
| `cashbook_proofs update - active access` | UPDATE | same predicate in BOTH USING and WITH CHECK |
| `cashbook_proofs delete - active access` | DELETE | same predicate in USING |

**Precedence reading (the leak):** the predicate parses as `(bucket_id='cashbook_proofs' AND cong_match) OR (EXISTS scope_level<>'Congregation')`. The right operand has NO bucket test, so for a user with any active non-Congregation scope row it is TRUE regardless of `bucket_id`. Result: those three policies authorize INSERT/UPDATE/DELETE on the hyphen `cashbook-proofs` bucket too. There is no underscore SELECT policy, so hyphen SELECT is governed only by `Authenticated_CRUD l4t6gw_2`.

**Net effective authority on the hyphen bucket TODAY:** any authenticated user → SELECT/INSERT/UPDATE/DELETE on every object (via the unscoped four); additionally any non-Congregation-scoped user → INSERT/UPDATE/DELETE via the underscore leak. Both cross-tenant. Making the bucket private only removed anonymous URL reads.

### A3. Helpers (verified live)
- `get_my_hierarchy_ids()` — SECURITY DEFINER, STABLE, `search_path=''`; returns `SETOF uuid` = congregations the caller may see, from `user_hierarchy_access` filtered `status='active' AND start_date<=now() AND (end_date IS NULL OR end_date>=now())`, unioned across Congregation/Overseership/Apostleship/District/Eldership scopes + `ho_district_assignments`. NOTE: its direct-congregation branch includes Secretary congregation access (relevant to the SELECT edge case in F).
- `get_my_role()` — returns the caller's single highest-ranked role globally. **Not used in this rev** for authority decisions (wrong granularity for multi-congregation users).
- `can_capture_period(cong_id, yr, mnth, wk, svc)` — SECURITY DEFINER; raises 42501 if `cong_id NOT IN get_my_hierarchy_ids()`, then enforces week-sequencing (week N requires week N-1 = `AuditApproved`; week 1 always true). It checks SCOPE + sequencing, **NOT role** — so it cannot by itself establish capture authority.
- `get_or_create_period(p_congregation_id, p_week_key, p_service, p_user_id)` — SECURITY DEFINER; scope-checks then looks up/creates a `Draft` period by `(congregation_id, week_key, service)`. Confirms `(congregation_id, week_key, service)` uniquely identifies a period.

### A4. Relevant columns (verified live)
- `cashbook_attachment`: `id`, `line_item_id uuid NOT NULL` (FK→`cashbook_line_item`), `file_url text NOT NULL` (currently a PUBLIC url), `uploaded_by`, `uploaded_at`, `transaction_date`, `bank_reference`, `congregation_id uuid NOT NULL`. No `period_id`; no object-key/bucket/checksum columns. Parent period = `line_item_id → cashbook_line_item.period_id → cashbook_period`.
- `cashbook_line_item`: `id`, `period_id uuid NOT NULL`, `section`, `item_type`, `amount`, `proof_status`, `transaction_date`, … (period reachable via `period_id`).
- `cashbook_period`: `id`, `congregation_id NOT NULL`, `year`, `month`, `week int`, `service text NOT NULL`, `status NOT NULL`, `week_key text` (NULLABLE — but always set by `get_or_create_period`, so reliable for capture-flow periods).
- `user_hierarchy_access`: `user_id`, `role text NOT NULL`, `hierarchy_id`, `congregation_id uuid` (nullable), `scope_level text NOT NULL`, `status text`, `start_date NOT NULL`, `end_date` (nullable). This is the per-congregation role/scope source of truth.

### A5. `period_status` + lock
Labels: `Draft, Submitted, AuditApproved, SubmittedToOverseer, Rejected, SubmittedToHO, HOReviewed` (no `OverseerApproved/OverseerRejected`). Editable = `Draft`/`Rejected`. "Locked/submitted" = `Submitted` and beyond; only HO corrects/unlocks.

### A6. Permission matrix (verified `src/lib/permissions.ts`)
- `banking.proof_view`: Secretary `-` (DENY); all other roles `V`.
- `banking.upload_proof` and `banking.create`: Elder `O`, Chairperson `C`, Treasurer `C`; HO/Apostle/Overseer/Auditor/Secretary `-`.

---

## B. Revised SQL — NOT APPLIED

> **BEGIN/ROLLBACK is a drafting precaution, NOT a guarantee that executing this file is harmless.**
> Do NOT run this file. Run `supabase db pull` first. DROP targets use the VERIFIED names from A2 and
> cover **every** policy that can authorize the hyphen bucket (the four unscoped + the three underscore
> leakers). The underscore policies are RECREATED correctly scoped to the underscore bucket so their
> legitimate function is preserved without cross-bucket authority. Path layout (from
> `syncEngine.uploadProof`): `cong/year/month/{service}_{weekKey}/userId/file` →
> `foldername[1]=cong`, `[4]={service}_{weekKey}`, `[5]=userId`.

```sql
-- ========================================================================
-- Tranche 4 rev2 DRAFT — proof-access storage.objects policies  -- NOT APPLIED
-- Bucket retained: 'cashbook-proofs' (hyphen). No bucket migration. No new bucket.
-- The bucket is ALREADY private; storage.buckets is NOT modified here.
-- ========================================================================
BEGIN;  -- NOT APPLIED — drafting precaution only

-- 0a. Drop the four unscoped hyphen-bucket policies (A2).                 -- NOT APPLIED
DROP POLICY IF EXISTS "Authenticated_CRUD l4t6gw_0" ON storage.objects;   -- INSERT
DROP POLICY IF EXISTS "Authenticated_CRUD l4t6gw_1" ON storage.objects;   -- UPDATE
DROP POLICY IF EXISTS "Authenticated_CRUD l4t6gw_2" ON storage.objects;   -- SELECT
DROP POLICY IF EXISTS "Authenticated_CRUD l4t6gw_3" ON storage.objects;   -- DELETE

-- 0b. Drop the three underscore policies whose OR-branch leaks to all buckets (A2). -- NOT APPLIED
DROP POLICY IF EXISTS "cashbook_proofs insert - active access" ON storage.objects;
DROP POLICY IF EXISTS "cashbook_proofs update - active access" ON storage.objects;
DROP POLICY IF EXISTS "cashbook_proofs delete - active access" ON storage.objects;

-- 0c. Recreate the underscore-bucket policies with the bucket condition wrapping EVERY
--     authorising branch: bucket AND (branch_A OR branch_B). Preserves legitimate
--     underscore access; removes accidental authority over other buckets.   -- NOT APPLIED
CREATE POLICY "cashbook_proofs insert - active access" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'cashbook_proofs'
    AND (
      (storage.foldername(name))[1]::uuid IN (
        SELECT uha.congregation_id FROM public.user_hierarchy_access uha
        WHERE uha.user_id = auth.uid() AND uha.status = 'active')
      OR EXISTS (SELECT 1 FROM public.user_hierarchy_access uha
        WHERE uha.user_id = auth.uid() AND uha.status = 'active'
          AND uha.scope_level <> 'Congregation')
    )
  );
CREATE POLICY "cashbook_proofs update - active access" ON storage.objects
  FOR UPDATE TO authenticated
  USING      ( bucket_id = 'cashbook_proofs' AND ( (storage.foldername(name))[1]::uuid IN (SELECT uha.congregation_id FROM public.user_hierarchy_access uha WHERE uha.user_id=auth.uid() AND uha.status='active') OR EXISTS (SELECT 1 FROM public.user_hierarchy_access uha WHERE uha.user_id=auth.uid() AND uha.status='active' AND uha.scope_level<>'Congregation') ) )
  WITH CHECK ( bucket_id = 'cashbook_proofs' AND ( (storage.foldername(name))[1]::uuid IN (SELECT uha.congregation_id FROM public.user_hierarchy_access uha WHERE uha.user_id=auth.uid() AND uha.status='active') OR EXISTS (SELECT 1 FROM public.user_hierarchy_access uha WHERE uha.user_id=auth.uid() AND uha.status='active' AND uha.scope_level<>'Congregation') ) );
CREATE POLICY "cashbook_proofs delete - active access" ON storage.objects
  FOR DELETE TO authenticated
  USING ( bucket_id = 'cashbook_proofs' AND ( (storage.foldername(name))[1]::uuid IN (SELECT uha.congregation_id FROM public.user_hierarchy_access uha WHERE uha.user_id=auth.uid() AND uha.status='active') OR EXISTS (SELECT 1 FROM public.user_hierarchy_access uha WHERE uha.user_id=auth.uid() AND uha.status='active' AND uha.scope_level<>'Congregation') ) );

-- 1. SELECT (read / mint signed URL): per-congregation, non-Secretary access only. -- NOT APPLIED
--    Scope gate via get_my_hierarchy_ids(); the EXISTS requires that visibility to THIS
--    congregation is held through a non-Secretary role (preserves Secretary totals-only DENY).
--    Treasurer-in-A/Auditor-in-B reading B => ALLOW; Treasurer-in-A/Secretary-only-in-B reading B => DENY.
CREATE POLICY proofs_select_scoped ON storage.objects
  FOR SELECT TO authenticated
  USING (
    bucket_id = 'cashbook-proofs'
    AND (storage.foldername(name))[1]::uuid IN (SELECT public.get_my_hierarchy_ids())
    AND EXISTS (
      SELECT 1 FROM public.user_hierarchy_access uha
      WHERE uha.user_id = auth.uid() AND uha.status = 'active'
        AND uha.start_date <= now() AND (uha.end_date IS NULL OR uha.end_date >= now())
        AND uha.role <> 'Secretary'
        AND ( uha.congregation_id = (storage.foldername(name))[1]::uuid
              OR uha.scope_level <> 'Congregation' )   -- see F-SELECT edge case
    )
  );

-- 2. INSERT (capture upload): per-congregation capture role + uploader=caller + EXACT period
--    binding + permitted state. Draft/Rejected = ordinary capture; Submitted = offline-queued /
--    declared-outstanding delivery (see Section E sync trace). AuditApproved+ => DENY (locked). -- NOT APPLIED
CREATE POLICY proofs_insert_capture ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'cashbook-proofs'
    AND (storage.foldername(name))[5]::uuid = auth.uid()
    AND EXISTS (                                   -- per-congregation capture authority (NOT get_my_role)
      SELECT 1 FROM public.user_hierarchy_access uha
      WHERE uha.user_id = auth.uid() AND uha.status = 'active'
        AND uha.start_date <= now() AND (uha.end_date IS NULL OR uha.end_date >= now())
        AND uha.congregation_id = (storage.foldername(name))[1]::uuid
        AND uha.role IN ('Elder','Chairperson','Treasurer')   -- banking.upload_proof holders
    )
    AND EXISTS (                                   -- EXACT intended period (cong+service+week_key)
      SELECT 1 FROM public.cashbook_period cp
      WHERE cp.congregation_id = (storage.foldername(name))[1]::uuid
        AND cp.service  = split_part((storage.foldername(name))[4], '_', 1)
        AND cp.week_key = substring((storage.foldername(name))[4]
                                    from position('_' in (storage.foldername(name))[4]) + 1)
        AND cp.status IN ('Draft','Rejected','Submitted')   -- NOT AuditApproved+ ; see F-INSERT
    )
  );

-- 3. UPDATE: DENY by omission. No general UPDATE policy — overwrite of an existing key is
--    forbidden; a replacement proof is a NEW versioned key via INSERT. (This also fixes the
--    live bug where the old UPDATE policy had WITH CHECK = null.) An HO-correction UPDATE, if
--    ever required, must gate on per-congregation HO + parent state + hierarchy (see F).   -- NOT APPLIED

-- 4. DELETE: preserve ORDINARY correction (capture role + editable period) AND HO correction
--    (any state). NOT HO-only. Auditor/Secretary/other roles => DENY.                      -- NOT APPLIED
CREATE POLICY proofs_delete_correction ON storage.objects
  FOR DELETE TO authenticated
  USING (
    bucket_id = 'cashbook-proofs'
    AND (storage.foldername(name))[1]::uuid IN (SELECT public.get_my_hierarchy_ids())
    AND (
      (  -- ordinary capture-role correction while the exact period is still editable
        EXISTS (SELECT 1 FROM public.user_hierarchy_access uha
          WHERE uha.user_id=auth.uid() AND uha.status='active'
            AND uha.start_date<=now() AND (uha.end_date IS NULL OR uha.end_date>=now())
            AND uha.congregation_id=(storage.foldername(name))[1]::uuid
            AND uha.role IN ('Elder','Chairperson','Treasurer'))
        AND EXISTS (SELECT 1 FROM public.cashbook_period cp
          WHERE cp.congregation_id=(storage.foldername(name))[1]::uuid
            AND cp.service = split_part((storage.foldername(name))[4],'_',1)
            AND cp.week_key = substring((storage.foldername(name))[4] from position('_' in (storage.foldername(name))[4])+1)
            AND cp.status IN ('Draft','Rejected'))
      )
      OR  -- HO correction (per-congregation HO), permitted in any parent state
      EXISTS (SELECT 1 FROM public.user_hierarchy_access uha
        WHERE uha.user_id=auth.uid() AND uha.status='active'
          AND uha.start_date<=now() AND (uha.end_date IS NULL OR uha.end_date>=now())
          AND uha.role='HO'
          AND (uha.congregation_id=(storage.foldername(name))[1]::uuid OR uha.scope_level<>'Congregation'))
    )
  );

ROLLBACK;  -- NOT APPLIED — draft ends in ROLLBACK so an accidental run is a no-op.
-- ========================================================================
```

---

## C. Affected callers and proposed changes

| File:line | Upload/Read | Current behaviour | Proposed change |
|---|---|---|---|
| `src/utils/syncEngine.ts` `uploadProof` (~262-270) | Upload | `.upload(path, blob)` then returns `getPublicUrl(path).data.publicUrl`. | Return the durable object key (the `path`) + bucket id; stop returning a public URL. |
| `src/utils/syncEngine.ts` `syncLineItem` (~210) | Upload (writes `file_url`) | Inserts `cashbook_attachment { file_url: <publicUrl> }`. | Persist the object key (not a public URL) in `file_url` during transition; later add a durable reference column (Section F dep 1). |
| `src/utils/syncEngine.ts` `syncDepositSlip` (~230-245) | Upload (writes `file_url`) | One deposit-slip object; inserts one attachment per `CashBanked` item, all sharing the same `file_url`. | Same: store one object key; all banked-item attachments reference it (shared-slip case preserved — see D). |
| `src/audit/ProofLink.tsx` | Read | Renders stored `file_url` directly as `<a href target=_blank>`. | Accept an object reference (`{bucketId, objectKey}` or attachment id); on click, mint a short-lived `createSignedUrl(key, ttl)` and open it; null/expired → show missing/denied state; render nothing for Secretary. |
| `src/audit/AuditReviewPage.tsx` (~120 select; ~256/395/427 render) | Read | Selects `cashbook_attachment.file_url`; passes to three `<ProofLink url=…>`. | Select the key column; pass reference to the updated `ProofLink`; Secretary must not reach the proof column (totals-only). |

**Legacy `file_url` handling (no mandatory migration to read):** existing rows hold
`…/storage/v1/object/public/cashbook-proofs/<KEY>`. The reader extracts `<KEY>` after the known
`cashbook-proofs/` segment for project `cwdyixafvylzgtpsfmwr` and calls `createSignedUrl(<KEY>, ttl)`.
This restores private reading immediately WITHOUT first adding object-key columns; a durable
object-reference column is justified separately as a permanence/robustness improvement (Section F dep 1),
not a prerequisite for compatible reading.

**New shared piece:** a thin `StoragePort.getSignedUrl(key, ttlSeconds)` (+ `upload`) so `ProofLink`,
viewer and sync depend on it instead of `supabase.storage` directly. Minting signed URLs at view time is
what restores private viewing; signed URLs are never cached in IndexedDB or the attachment row.

---

## D. Role / action / state matrix (ALLOW / DENY)

Object assumed in the caller's hierarchy scope unless the row says cross-hierarchy. "Capture role" =
Elder/Chairperson/Treasurer (`banking.upload_proof`). States via path→period (INSERT/DELETE) and
scope+role (SELECT).

### SELECT (read / mint signed URL)
| Case | Result |
|---|---|
| HO/Apostle/Overseer/Elder/Chairperson/Treasurer/Auditor with non-Secretary access to the congregation | ALLOW (all states) |
| **Secretary** (totals-only, `proof_view='-'`) | **DENY** (all states) |
| **Treasurer in A / Auditor in B → read B** | **ALLOW** (Auditor is a non-Secretary role in B) |
| **Treasurer in A / Secretary-only in B → read B** | **DENY** (only role in B is Secretary) |
| Cross-hierarchy (congregation not in `get_my_hierarchy_ids()`) | DENY |

### INSERT (upload)
| Case | Draft | Rejected | Submitted | AuditApproved+ |
|---|---|---|---|---|
| Capture role in the TARGET congregation, `folder[5]=auth.uid()`, exact period | ALLOW | ALLOW | ALLOW (offline-queued / declared-outstanding) | DENY (locked) |
| HO/Apostle/Overseer/Auditor/Secretary (`upload_proof='-'`) | DENY | DENY | DENY | DENY |
| **Capture role in A uploading to B** (no capture row in B) | DENY | DENY | DENY | DENY |
| `folder[5] <> auth.uid()` (not the uploader) | DENY | DENY | DENY | DENY |
| Unrelated editable period in same congregation (path→period mismatch) | DENY (no exact-period match) | — | — | — |
| **Shared deposit-slip** (one object → many banked items) | ALLOW once at period level; each banked-item attachment row references the same key | | | |
| Overwrite of an existing object key | DENY (no UPDATE policy; replacement = new key INSERT) | | | |

### UPDATE
| Any role / state | **DENY** (no general UPDATE policy; overwrite forbidden). Optional HO-correction UPDATE only if later added, gated on per-congregation HO + parent state + hierarchy. |
|---|---|

### DELETE
| Case | Draft/Rejected | Submitted/AuditApproved+ (locked) |
|---|---|---|
| Capture role in the congregation (ordinary correction) | ALLOW | DENY |
| HO (per-congregation / in-scope) correction | ALLOW | ALLOW |
| **Auditor** (read-only) | **DENY** | **DENY** |
| Secretary | DENY | DENY |
| Apostle / Overseer | DENY | DENY |
| Cross-hierarchy | DENY | DENY |

### Offline-queued proof delivery (the case a strict rule would break)
A proof captured offline for a period that is already `Submitted` server-side (e.g. the bulk-cash
deposit slip for a declared-outstanding item) is uploaded by the Sync_Engine when `local status =
server status = Submitted` (not a downstream conflict). The INSERT policy permits `Submitted` so this
legitimate proof still lands. It is blocked once the period reaches `AuditApproved` or later.

---

## E. Sync-order trace, deployment, cached clients, rollback

### E1. Server-state ordering (traced in `syncEngine.ts reconcilePeriod`)
1. `get_or_create_period` → returns/creates the period (`Draft` when new).
2. Downstream-conflict check (`isServerDownstream`): if server advanced beyond local, mark `conflict`, upload nothing.
3. `syncLineItem` per item → `uploadProof` + insert `cashbook_attachment` (proofs upload HERE).
4. `syncDepositSlip` → one upload, an attachment per `CashBanked` item.
5. ONLY THEN apply the `Draft/Rejected → Submitted` transition on `cashbook_period`.

So in a single online pass, proofs upload while the server period is still `Draft` — a Draft-only rule
would NOT break the common path. BUT offline capture + retry means a proof can legitimately be uploaded
when local and server are both already `Submitted` (step 5 of an earlier pass ran, or the slip was
captured after submission). Hence INSERT must allow `Submitted`, as above.

### E2. The honest limit on Submitted-state uploads (genuine dependency, not claimed as existing)
RLS permitting `Submitted` cannot by itself distinguish a legitimate declared-outstanding finalisation
from an arbitrary extra upload by a capture-role user. There is **no deployed finalisation RPC** (edge
functions: none; no such DB function verified). To tighten "Submitted uploads must be declared-outstanding
only", the smallest server dependency is a `SECURITY DEFINER` finalisation/insert RPC that (a) verifies a
declared-outstanding marker on the target period (e.g. a line item in `CashPending`/`proof_status=Pending`)
and (b) performs the upload+attachment atomically — routing Submitted-state uploads through it and
restricting direct Submitted INSERTs. This RPC is identified here and is NOT assumed to exist or protect
anything today.

### E3. Deployment order (bucket already private)
1. Ship the app READ change first (`StoragePort.getSignedUrl` + updated `ProofLink`/`AuditReviewPage`,
   incl. legacy-URL key extraction). Signed URLs work on a private bucket; this restores viewing for
   in-scope readers immediately.
2. Apply the `storage.objects` policy replacement (Section B) — closes the cross-tenant hole and the
   underscore leak. Sequence after step 1 so legitimate readers are never interrupted.
3. Ship the upload change (store key, not public URL) alongside/just after.

### E4. Cached PWA builds (`registerType:'prompt'`, `ReloadPrompt`)
A cached service-worker build keeps minting `getPublicUrl` links that now 403. Mitigate: (a) the app's
`ReloadPrompt` (`src/pwa/ReloadPrompt.tsx`) prompts users to update to the signed-URL reader; (b) the new
`ProofLink` treats a 403/expired/null signed URL as "proof unavailable — refresh app", not a hard error;
(c) gate the upload change behind the app update and backfill any public URLs written during the window.
Signed URLs are short-lived (60-300s), minted on demand at click, re-minted on expiry, never persisted.

### E5. Privacy-preserving rollback (bucket stays private)
Do NOT roll back by restoring the broad `Authenticated_CRUD` policies or by dropping the role/scope
restriction, and NEVER re-enable `public=TRUE` (public URLs are 403 by design now). If the new policies
misbehave, prefer **temporarily disabling the affected operation** (e.g. drop only the new INSERT or
DELETE policy so that operation fails closed) while keeping SELECT scoped so viewing continues; and/or
roll back the APP to the prior build via normal deploy rollback. Reopening access is never the rollback.

---

## F. Genuine blocking dependencies (only demonstrated ones)

1. **Submitted-state upload tightening needs a finalisation RPC (E2).** Without it, RLS must permit all
   capture-role `Submitted` uploads (to preserve offline-queued proofs) and cannot enforce
   declared-outstanding-only. This is a real pre-implementation decision, not done here. *Reported.*

2. **SELECT edge case for multi-role users (precise Secretary exclusion).** The `proofs_select_scoped`
   EXISTS handles the two stated cases correctly. It can still over-grant in a rare combination: a user who
   is Secretary-only in B **and** holds an unrelated non-Congregation scope elsewhere — `get_my_hierarchy_ids()`
   admits B via the Secretary row while the `scope_level<>'Congregation'` branch is TRUE from the unrelated
   role. Closing this precisely needs a small additive helper `get_my_proof_congregations()` (a
   Secretary-excluding variant of `get_my_hierarchy_ids()`); it ADDS a helper rather than changing the
   existing one. *Reported; base policy covers the stated cases.*

3. **Durable object-reference columns are an improvement, NOT a blocker for reading (point 9).** Legacy
   public-URL key extraction (Section C) restores private reading now. Adding `object_key`/`bucket_id`/
   integrity columns to `cashbook_attachment` (and relaxing `file_url NOT NULL`) is justified separately for
   permanence/robustness. *Reported; not required for cutover.*

4. **Residual risk NOT fixed by storage policies — report accurately.** Tightening `storage.objects` does
   NOT secure `cashbook_attachment` ROW mutation: its UPDATE/DELETE are congregation-scoped with no
   period-state lock and no role gate (verified A4-equivalent in rev1), so a congregation-scoped user can
   still delete/redirect an attachment row (the reference to the proof) for a locked period. **The proof
   system is NOT fully secure after the Storage-only change**; the attachment-row RLS is a separate required
   remediation, bounded out of this proposal. *Reported.*

5. **`cashbook_period.week_key` is nullable.** Capture-flow periods always have it (set by
   `get_or_create_period`), so the path→period binding is reliable for proofs produced by the app. Any
   legacy period with a NULL `week_key` would not match the INSERT/DELETE EXISTS. **Verified live
   2026-10-20: 0 of 11 periods have a NULL `week_key`, 0 non-Draft nulls, and all 11 match the
   `YYYY-MM-WN` format the policy parse expects — so the path->period binding is reliable; not a blocker.**

6. **Underscore `cashbook_proofs` bucket is unused.** This rev corrects (not drops) its three policies to
   remove the cross-bucket leak. Decommissioning that bucket entirely is a separate cleanup. *Reported.*

---

STATUS: proposal only (rev2 correction pass) — NOT APPLIED; no code/SQL/bucket changes made.

