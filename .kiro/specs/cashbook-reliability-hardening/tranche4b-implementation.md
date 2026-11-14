# Tranche 4 consolidated correction - implementation + verification (EVIDENCE)

Pre-production context recorded at .kiro/steering/environment-context.md (always-on).
Next-stage direction recorded at next-stage-direction.md (NOT implemented this pass).
No change applied to backend cwdyixafvylzgtpsfmwr; no deployment. Read-only inspection
only (get_my_hierarchy_ids body, cashbook_period unique key, storage/attachment policies,
HO representation). Migration is NOT APPLIED.

## Confirmed-blocker fixes
1 Locked-proof mutation: storage DELETE + attachment UPDATE/DELETE restrictive locks now
  permit ONLY Draft/Rejected; NO HO (or any-role) exception for Submitted+ (no unlock
  mechanism exists and none was invented). (migration sections 7, 8b)
2 Attachment linkage: attach_insert_linked / attach_update_linked require the row's
  congregation to equal the parent period's congregation (via line_item->period, no
  cashbook_line_item.congregation_id), the object key folder to match, and caller scope.
  Shared slips preserved (per-row linkage). (migration 8a)
3 Period match: INSERT/DELETE bind the FULL unique key (congregation_id, year, month,
  week, service) with week parsed from the path + week_key consistency. (migration 5, 7)
4 Stable proof identity: schema.proofObjectKey / depositObjectKey assigned at capture
  (captureRepo) and reused across retries; syncEngine.buildProofPath + ensure* use it;
  uploadProofStable verifies on "already exists" (no overwrite). Replaced bytes get a new
  identity (attachProof/markCashBanked reallocate; Cash clears it).
5 Submitted uploads: DEFAULT-DISABLED. Migration INSERT permits Draft/Rejected only;
  syncEngine SUBMITTED_PROOF_FINALISATION_ENABLED=false retains the Blob, does NOT mark
  synced, surfaces blocked-pending (BLOCKED_SUBMITTED_PROOF_MSG). No outbox/replay built.
6 HO helper authority: get_my_proof_congregations HO branch requires BOTH an
  ho_district_assignments row AND a matching active, time-valid HO role row for the SAME
  district. get_my_hierarchy_ids() unchanged.
7 Reliability: attachment/status/upload failures throw -> period retryable, Blob retained;
  shared slip releases bytes only when EVERY banked item is acked; idempotent attachment
  insert avoids duplicates; release guarded by current proofObjectKey (older ack never
  clears a newer Blob). No auto-scheduling added.
8 Reader: ProofLink detects a blocked popup (decideProofOpen) and shows an inline
  "Open proof" link instead of navigating the current tab away; missing/denied/transient
  distinguished; link-issued is not shown as reviewed evidence.

## Changed/added files
- src/db/schema.ts (+ proofObjectKey / depositObjectKey, additive non-indexed)
- src/db/captureRepo.ts (assign stable keys; clear on Cash)
- src/utils/syncEngine.ts (items 4,5,7 rewrite)
- src/audit/ProofLink.tsx (item 8)
- src/lib/storage/storagePort.ts (+ decideProofOpen)
- supabase/migrations/20261012010000_tranche4_proof_access.sql (items 1,2,3,5,6; NOT APPLIED)
- supabase/tests/tranche4_proof_rls.test.sql (item 9 repairs; UNEXECUTED)
- tests: src/lib/storage/proofOpen.test.ts, src/utils/syncEngine.retention.test.ts
- records: .kiro/steering/environment-context.md, next-stage-direction.md

## Verification
Baseline (before): tsc 0; vitest 51/8; eslint 1 error + 6 warnings.
After: tsc 0; vitest 61 passed / 10 files; eslint SAME 7 findings (none in new/edited
files; the captureRepo _params error is pre-existing, only its line number shifted).
Evidence: _t4b_base_*, _t4b_final_test.txt, _t4b_final_lint.txt, _t4b_git_before.txt.

## INCOMPLETE - environment requirement (item 9)
Effective-RLS + attachment-integrity DB tests are UNEXECUTED: no Docker in this
environment, so `supabase start` cannot run. The implementation is therefore INCOMPLETE
until those tests run on a disposable local stack (Docker) or a disposable cloud project.
Passing them is the GATE before applying the migration even to the dev/demo backend.
