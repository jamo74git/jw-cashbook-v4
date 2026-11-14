# Tranche 4 — proof-access implementation (bounded) — EVIDENCE RECORD

Bounded implementation of the rev2 proof-access proposal, correcting its defects. Local
application changes + a versioned migration file + tests only. NOT deployed; no
production SQL executed; no remote bucket/policy change; sync NOT auto-enabled.

## Changed / added files
- `src/lib/storage/proofReference.ts` (new) — pure resolver: stored file_url (legacy
  public url OR bare key) -> object key via EXACT origin+route+bucket validation (no
  substring matching); rejects foreign origin/bucket, look-alikes, empty, bare-key
  traversal.
- `src/lib/storage/storagePort.ts` (new) — `getProofSignedUrl` (private read via
  short-lived signed url, never persisted) + `uploadProofObject` + pure
  `classifyStorageError` (missing / denied / transient).
- `src/audit/ProofLink.tsx` (edit) — mints signed url on click; distinguishes
  missing/denied/transient; a failed load is never shown as viewable evidence;
  `canView` can hide it. Prop stays `url` (stored reference) so AuditReviewPage wiring
  is unchanged.
- `src/utils/syncEngine.ts` (edit) — `uploadProof` now returns + stores the durable
  OBJECT KEY instead of a public url. Shared deposit-slip (one object / many
  attachments) preserved. Fresh timestamped key per upload => replacement is a new
  versioned key (no overwrite).
- `supabase/migrations/20261012010000_tranche4_proof_access.sql` (new) — **NOT APPLIED**.
  Additive `get_my_proof_congregations()` (get_my_hierarchy_ids traversal + Secretary
  exclusion on the direct branch; get_my_hierarchy_ids unchanged); cross-bucket leak fix
  (underscore policies re-scoped bucket AND (A OR B)); drop 4 unscoped hyphen policies;
  scoped SELECT/INSERT/DELETE; no UPDATE policy (overwrite denied); bounded RESTRICTIVE
  attachment UPDATE/DELETE lock when parent period is locked (except in-scope HO).
- `supabase/tests/tranche4_proof_rls.test.sql` (new) — effective-policy tests,
  **UNEXECUTED** (Docker/local stack unavailable).
- Unit tests (new, RUN): `src/lib/storage/proofReference.test.ts`,
  `src/lib/storage/storagePort.classify.test.ts`.

## Read-only inspections performed (no writes to production)
- `get_my_hierarchy_ids()` body (to author the helper faithfully).
- `cashbook_period` constraints/indexes: enforced UNIQUE is
  `(congregation_id, year, month, week, service)` — NOT `(congregation_id, service,
  week_key)`. `week_key` is nullable, no unique constraint. INSERT/DELETE period binding
  therefore uses year+month+service+week_key (real unique-key columns + week_key), and
  the policy comments record that week_key is only a convenience column.
- `storage.objects` and `cashbook_attachment` live policies (DROP targets + Area-5 gap).

## Verification
- Baseline (fresh this session): tsc exit 0; vitest 33 passed / 6 files; eslint exit 1
  (1 error + 6 warnings). Evidence: `_t4_base_tsc.txt`, `_t4_base_test.txt`,
  `_t4_base_lint.txt`, `_t4_base_exit.txt`.
- After changes: tsc exit 0 (clean); vitest 51 passed / 8 files (+18 new unit tests);
  eslint exit 1 — SAME 7 pre-existing findings, none in new/edited files. Evidence:
  `_t4_tsc.txt`, `_t4_test.txt`, `_t4_lint.txt`.
- Pre-existing lint (NOT touched): captureRepo.ts:440 `_params` (error);
  AuditReviewPage.tsx:129, button.tsx:52, 4x ho/*Screen loadData (warnings).
- Effective-RLS tests: UNEXECUTED (no Docker). Not server-security verification until run.

## Release blockers / reported dependencies
1. Effective-RLS + attachment-lock tests UNEXECUTED — must run on a disposable local
   stack before rollout.
2. Submitted-state upload tightening still needs a finalisation RPC to distinguish
   declared-outstanding delivery from arbitrary upload; NOT built (would require a new
   staged-upload + transactional-finalise protocol). Left disabled/unreleased.
3. Elder capture `O` override / acting-as conditions are an APP-layer control; the
   storage INSERT policy permits Elder uploads but does NOT (cannot) re-verify those
   conditions — not claimed preserved by RLS.
4. Storage-policy tightening does NOT by itself secure cashbook_attachment row mutation
   beyond the bounded lock added here; broader financial-write/audit redesign is out of
   scope and remains open.
5. Migration is NOT APPLIED; apply only after `supabase db pull` on a disposable env.

## Cutover / rollback (summary; see tranche4-proof-access-proposal-rev2.md E3-E5)
Ship app READ change first (signed-url reader tolerates legacy public urls), then apply
policies, then the upload-key change. Bucket stays private; rollback never re-enables
public read — disable the offending new policy (fail-closed) and/or roll back the app
build. Cached PWA clients: ReloadPrompt prompts update; stale getPublicUrl links 403 and
the reader shows "unavailable — refresh", not reviewed evidence. Unsynced Dexie data is a
separate storage domain and is preserved across SW update.
