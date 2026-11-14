# Tranche 4 round-2 (continued) - implementation + verification (EVIDENCE)

No deploy, no Git push, no Vercel build, no change to backend cwdyixafvylzgtpsfmwr. The
migration was NOT applied anywhere (no disposable Supabase stack / Docker available).

## Code (verified: npm run typecheck exit 0; npm test 71/10; npm run lint exit 1 = 7 pre-existing)
- src/utils/syncEngine.ts
  - Area 1: bindLineItemProof/bindDepositProof read key+blob+hash+size from ONE fresh row
    before upload; upload uses that bound version; compare-and-clear clears only the exact
    delivered key - a newer replacement is retained and keeps the period pending.
  - Area 2: a locked server period with pending proof OR un-pushed line items is NOT marked
    synced (blocked / conflict with retained data); equal status != acknowledged data.
  - Area 3: period submission now requires the expected affected row (requireOneRow); the
    acting-as audit insert is row-checked; a reported idempotency dependency is documented
    (no audit_log dedupe key - a lost ack after commit could duplicate on retry).
- src/utils/syncEngine.retention.test.ts: +4 tests (Area1 shared-slip race, Area2 locked
  unacked capture, Area3 zero-row submission, Area3 zero-row acting-as audit). Suite = 16.
- ProofLink.tsx / storagePort.ts / proofReference.ts / schema.ts / captureRepo.ts:
  carried from round-2 (reset-on-ref-change, stale-async discard, re-mint inline, neutral
  copy, popup-closed guard; proofHash/proofSize+depositHash/depositSize; capture hashing).

## Migration (supabase/migrations/20261012010000_tranche4_proof_access.sql) - NOT APPLIED
- R08 cast-safety: strict 8-4-4-4-12 UUID regex + bounded week W[1-5]; MATERIALIZED-CTE
  validate-before-cast; one parser used by INSERT, DELETE and attachment linkage. SELECT
  policy now uses the cast-safe proof_path_congregation(name).
- R04: attachment INSERT AND UPDATE both enforce exact-parent period, congregation match,
  editable state, capture role, and object existence + ownership.
- R05: shared-object deletion guard now counts ALL references via a SECURITY DEFINER
  function (proof_object_reference_count) so references hidden from the deleting user by
  RLS still block physical deletion.
- R06 (unchanged): non-destructive duplicate pre-check + unique index on
  (line_item_id, proof_ref_key(file_url)).
- R07 (unchanged): HO requires district assignment AND active HO District role; no generic
  District bypass; Secretary excluded on all branches.
- 10 policies, 6 functions.

## SQL effective-policy suite (supabase/tests/tranche4_proof_rls.test.sql) - UNEXECUTED
Completed the replacement suite: row-count-aware writes (do_write: >0 allow / 0 RLS-filtered
/ -1 42501; other sqlstate re-raised), positive controls, and the matrix (SELECT incl both
HO-omissions + expired + cross-hierarchy; INSERT allow + forged/malformed/wrong-week/locked
/cross-cong deny; overwrite via UPDATE+upsert deny; DELETE editable-allow, locked-incl-HO
deny, R05 referenced-deny; attachment linked-allow, reparent/ghost deny, locked deny).
Metadata-level only - does NOT prove Storage-API byte upload/retrieve/verify.

## Environment
No disposable Supabase project and no Docker -> DB migration execution and effective
SQL/Storage tests are UNEXECUTED. Mocked client tests are NOT presented as server proof.
