# Tranche 4 — Authenticated BEFORE/AFTER Access Checks + Safe Fallback (REVIEW — NOT APPLIED)

> Companion to `tranche4-migration-diff.sql`. This records the authenticated access
> checks a reviewer (and the eventual disposable-stack run) must confirm, the
> before→after expectation for each, and the safe fallback. **Nothing in this pass was
> applied to any backend.** Docker / local Supabase is unavailable here, so every
> server-side check below is reasoned about only and is marked
> **NEEDS AUTHENTICATED/HOSTED TESTING** — none is claimed proven.
>
> - BEFORE = captured live baseline `policy-definitions.sql` (project `cwdyixafvylzgtpsfmwr`, captured 2026-11-04).
> - AFTER  = authored migration `supabase/migrations/20261012010000_tranche4_proof_access.sql` (NOT applied).
> - Bucket in use: `cashbook-proofs` (hyphen), private. `cashbook_proofs` (underscore) is legacy/unused.

## What this change does (one paragraph)

It replaces the four unscoped `Authenticated_CRUD l4t6gw_*` policies — which let **any
authenticated user** read/insert/update/delete **every** object in `cashbook-proofs`
(the `l4t6gw_2` SELECT being the broad read) — with per-congregation, role- and
state-scoped SELECT/INSERT/DELETE policies and **no** UPDATE policy (overwrite denied).
It also rewrites the three underscore-bucket write policies so their bucket test wraps
every authorising branch, closing the legacy cross-bucket write leak.

---

## A. Legacy cross-bucket write check (the specific defect called out)

**Defect (BEFORE).** The underscore-bucket INSERT/UPDATE/DELETE policies are
`(bucket_id = 'cashbook_proofs' AND folder_match) OR (EXISTS … scope_level <> 'Congregation')`.
The second OR branch has **no** `bucket_id` test. Because PERMISSIVE predicates (and the
two sides of this OR) combine with OR, any user with an active non-Congregation scope row
(Overseer / Apostle / HO) satisfies the WITH CHECK/USING for a write to **any** bucket —
including the hyphen `cashbook-proofs` bucket the app uses. That is authority over a
bucket these policies were never meant to govern.

**Fix (AFTER).** Rewrite to `bucket_id = 'cashbook_proofs' AND (folder_match OR scope_level <> 'Congregation')`
so the bucket condition gates **every** branch. The policy can then only ever authorize a
write whose target bucket is its own.

**Pure-logic assertion (verified locally this pass).** The predicate is modelled in
`src/lib/storage/crossBucketPredicate.ts` and asserted in
`src/lib/storage/crossBucketPredicate.test.ts`:
- the BEFORE predicate authorizes a foreign-bucket write for a non-Congregation-scope
  user (the leak is real) and **fails** the cross-bucket invariant;
- the AFTER predicate **cannot authorize** a write to any bucket other than its own, for
  every combination of (folder match, non-Congregation scope), while still allowing
  legitimate own-bucket writes.

This is boolean-logic proof of the predicate shape only. It does **not** exercise
PostgreSQL RLS. **NEEDS AUTHENTICATED/HOSTED TESTING** for the effective behaviour against
real `storage.objects` rows and a real JWT.

| Check | BEFORE | AFTER | Status |
|---|---|---|---|
| A1. Non-Congregation-scope user INSERT to `cashbook-proofs` via the underscore policy | ALLOWED (leak) | DENIED (bucket-gated) | NEEDS AUTHENTICATED/HOSTED TESTING |
| A2. Non-Congregation-scope user UPDATE/DELETE to `cashbook-proofs` via the underscore policy | ALLOWED (leak) | DENIED | NEEDS AUTHENTICATED/HOSTED TESTING |
| A3. Legitimate write to `cashbook_proofs` (own bucket) by an in-scope user | ALLOWED | ALLOWED (preserved) | NEEDS AUTHENTICATED/HOSTED TESTING |
| A4. Underscore policy authorizes any OTHER bucket name | ALLOWED for non-Cong scope | DENIED (all buckets ≠ own) | Pure-logic PROVEN locally; effective-RLS NEEDS AUTHENTICATED/HOSTED TESTING |

---

## B. Broad-read closure (`Authenticated_CRUD l4t6gw_2` SELECT)

**BEFORE.** `l4t6gw_2` = `FOR SELECT USING (bucket_id = 'cashbook-proofs')` — any
authenticated user can read / mint a signed URL for every proof in the bucket, across all
congregations, regardless of role. (Marking the bucket private only stopped anonymous
public-URL reads; authenticated read was still bucket-wide.)

**AFTER.** `l4t6gw_2` is dropped. SELECT is governed solely by `proofs_select_scoped`:
`bucket_id = 'cashbook-proofs' AND proof_path_congregation(name) IN (SELECT get_my_proof_congregations())`.
`get_my_proof_congregations()` excludes Secretary on every branch and requires an HO
District role **plus** a matching `ho_district_assignments` row for the District/HO route.

| Check | Role / scope | BEFORE | AFTER | Status |
|---|---|---|---|---|
| B1 | Treasurer/Chairperson/Elder reading proof in OWN congregation | ALLOW | ALLOW | NEEDS AUTHENTICATED/HOSTED TESTING |
| B2 | Auditor reading proof in a congregation they review | ALLOW | ALLOW | NEEDS AUTHENTICATED/HOSTED TESTING |
| B3 | **Secretary** (totals-only, `proof_view = '-'`) | ALLOW (bug) | **DENY** (excluded all branches) | NEEDS AUTHENTICATED/HOSTED TESTING |
| B4 | Treasurer in A reading a proof in UNRELATED congregation B | ALLOW (bug) | **DENY** (B ∉ my proof congs) | NEEDS AUTHENTICATED/HOSTED TESTING |
| B5 | HO with a matching `ho_district_assignments` row reading a proof in that district | ALLOW | ALLOW | NEEDS AUTHENTICATED/HOSTED TESTING |
| B6 | District-scope role WITHOUT an HO assignment reading a proof | ALLOW (bug) | **DENY** (no generic District bypass) | NEEDS AUTHENTICATED/HOSTED TESTING |
| B7 | Malformed / foreign object key (congregation not parseable) | ALLOW (bucket-only) | **DENY** (`proof_path_congregation` → NULL) | NEEDS AUTHENTICATED/HOSTED TESTING |

---

## C. INSERT (capture upload) access checks

`proofs_insert_capture`: `bucket_id = 'cashbook-proofs'` AND uploader segment = caller AND
the key resolves to an EXACT **editable** period (`Draft`/`Rejected`) whose congregation
has the caller in a capture role (`Elder`/`Chairperson`/`Treasurer`).

| Check | Case | BEFORE | AFTER | Status |
|---|---|---|---|---|
| C1 | Capture-role user uploads to own editable period, `folder[5] = auth.uid()` | ALLOW | ALLOW | NEEDS AUTHENTICATED/HOSTED TESTING |
| C2 | Upload where `folder[5] <> auth.uid()` (not the uploader) | ALLOW (bug) | **DENY** | NEEDS AUTHENTICATED/HOSTED TESTING |
| C3 | Capture-role user in A uploading to a period in B (no capture row in B) | ALLOW (bug) | **DENY** | NEEDS AUTHENTICATED/HOSTED TESTING |
| C4 | Non-capture role (HO/Apostle/Overseer/Auditor/Secretary) upload | ALLOW (bug) | **DENY** | NEEDS AUTHENTICATED/HOSTED TESTING |
| C5 | Upload to a `Submitted`+ (locked) period | ALLOW (bug) | **DENY** (editable states only) | NEEDS AUTHENTICATED/HOSTED TESTING |
| C6 | Malformed / forged key (bad UUID, wrong week, year/month mismatch) | ALLOW (bucket-only) | **DENY** (parser → NULL) | NEEDS AUTHENTICATED/HOSTED TESTING |
| C7 | Overwrite of an existing object key (UPDATE) | ALLOW (l4t6gw_1, with NULL WITH CHECK) | **DENY** (no UPDATE policy) | NEEDS AUTHENTICATED/HOSTED TESTING |

> **Reported limit (not a regression):** RLS permitting editable-state uploads cannot by
> itself distinguish a legitimate declared-outstanding finalisation from an arbitrary
> upload. Post-submission proof finalisation is DEFAULT-DISABLED in the client
> (`SUBMITTED_PROOF_FINALISATION_ENABLED = false`); the Submitted-state finalisation RPC
> is a genuine undeployed dependency, not claimed to exist.

---

## D. DELETE access checks

`proofs_delete_correction`: capture role while the EXACT parent period is editable AND
`proof_object_reference_count(name) = 0` (no attachment still references the object).

| Check | Case | BEFORE | AFTER | Status |
|---|---|---|---|---|
| D1 | Capture-role user deletes own proof while period is `Draft`/`Rejected`, no live references | ALLOW | ALLOW | NEEDS AUTHENTICATED/HOSTED TESTING |
| D2 | Delete while any `cashbook_attachment` still references the object (incl. references hidden from the caller by RLS) | ALLOW (bug) | **DENY** (reference-count guard) | NEEDS AUTHENTICATED/HOSTED TESTING |
| D3 | Delete a proof whose period is `Submitted`+ (locked) | ALLOW (bug) | **DENY** (no HO/any-role exception) | NEEDS AUTHENTICATED/HOSTED TESTING |
| D4 | Auditor / Secretary / Apostle / Overseer delete | ALLOW (bug) | **DENY** (not a capture role) | NEEDS AUTHENTICATED/HOSTED TESTING |
| D5 | Cross-congregation delete | ALLOW (bug) | **DENY** | NEEDS AUTHENTICATED/HOSTED TESTING |

---

## E. cashbook_attachment ROW checks (included in the migration)

| Check | Case | BEFORE | AFTER | Status |
|---|---|---|---|---|
| E1 | Insert attachment whose object resolves to the EXACT period of its line item, editable, capture role, object exists + owned by caller | ALLOW (cong-only) | ALLOW (fully bound) | NEEDS AUTHENTICATED/HOSTED TESTING |
| E2 | Insert/relink attachment to an object for a DIFFERENT period ("reparent"/ghost) | ALLOW (bug) | **DENY** | NEEDS AUTHENTICATED/HOSTED TESTING |
| E3 | Update/delete an attachment row whose parent period is locked (`Submitted`+), ANY role incl HO | ALLOW (bug) | **DENY** (RESTRICTIVE lock) | NEEDS AUTHENTICATED/HOSTED TESTING |
| E4 | Second attachment row with same `(line_item_id, object key)` (logical duplicate) | ALLOW (bug) | **DENY** (unique index) | NEEDS AUTHENTICATED/HOSTED TESTING |
| E5 | Shared deposit slip: many line items reference one object (distinct `line_item_id`) | ALLOW | ALLOW (preserved) | NEEDS AUTHENTICATED/HOSTED TESTING |

> **Reported residual:** attachment-row SELECT remains the deployed congregation/see-all
> policy (proof METADATA, not image bytes). Broader financial-write / audit hardening and
> the server-side submission-snapshot protocol are out of this change's scope and remain
> open.

---

## F. Pre-apply gate (must pass on a disposable stack before ANY apply)

1. `supabase db pull` on the disposable stack first; confirm the live policy set matches
   the BEFORE captured in `policy-definitions.sql`. If it has drifted, re-diff before applying.
2. Run `supabase/tests/tranche4_proof_rls.test.sql` (effective-policy suite) — it must pass
   on the disposable stack. **UNEXECUTED here (no Docker).**
3. Real Storage-API byte upload/retrieve/verify under a real JWT for each role — the SQL
   suite is metadata-level only and does not prove byte-level upload/download.
4. Portability: `proof_ref_key` hardcodes the `cwdyixafvylzgtpsfmwr.supabase.co` origin —
   correct for this backend; must be re-pointed for any other target.

Only after 1–3 pass on a disposable stack may the migration be applied even to the
dev/demo backend, per `environment-context.md`.

---

## G. Safe fallback / rollback

The bucket stays **private** throughout. Reopening access is never the rollback.

1. **Deployment order** (so legitimate readers are never interrupted):
   (a) ship the app READ change first — `storagePort.getProofSignedUrl` + the updated
   `ProofLink`/`AuditReviewPage`, which mint short-lived signed URLs and tolerate legacy
   public URLs via `resolveProofKey`; (b) apply the policy replacement; (c) ship the
   upload-key change (store durable object key, not a public URL).
2. **If a new policy misbehaves, fail closed, do not reopen.** Drop only the offending new
   policy so that single operation fails closed (e.g. drop `proofs_insert_capture` to block
   uploads) while `proofs_select_scoped` keeps scoped viewing working. Do **not** restore
   the broad `Authenticated_CRUD l4t6gw_*` policies and do **not** drop the role/scope
   restriction.
3. **Never** re-enable `public = true` on the bucket; legacy public URLs now 403 by design.
4. **App rollback** to the prior build via normal deploy rollback is preferred over
   reopening data access.
5. **Cached PWA clients** (`registerType:'prompt'`): a stale service worker keeps minting
   `getPublicUrl` links that now 403. `ReloadPrompt` prompts the update; the new `ProofLink`
   shows "proof unavailable — refresh app" rather than treating a 403/expired link as
   reviewed evidence. Signed URLs are short-lived and never persisted.
6. **Unsynced Dexie capture** is a separate storage domain and is preserved across a service
   worker update; none of this touches the local queue.

---

## H. Local verification performed this pass (no backend touched)

- `npm run typecheck` — recorded in the commit message.
- `npm run lint` — recorded in the commit message (pre-existing findings only; none in the
  new files).
- `npx vitest run` — includes `crossBucketPredicate.test.ts`; counts recorded in the commit
  message.

Everything server-side (Sections A–F effective behaviour) is **NEEDS AUTHENTICATED/HOSTED
TESTING** and is explicitly not claimed proven. No schema/policy/bucket change was applied
to `cwdyixafvylzgtpsfmwr` or any other backend; nothing was deployed or pushed.
