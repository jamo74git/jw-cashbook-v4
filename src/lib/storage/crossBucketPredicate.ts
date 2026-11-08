// ─────────────────────────────────────────────────────────────────────────────
// CROSS-BUCKET WRITE PREDICATE (Tranche 4 — proof-access review artifact)
// Pure, dependency-free model of the underscore-bucket (`cashbook_proofs`)
// INSERT/UPDATE/DELETE `storage.objects` policy predicate, in its captured LIVE
// (leaky) form and in its Tranche 4 (fixed) form.
//
// WHY THIS EXISTS
// The captured live policies for the underscore bucket are written as:
//     (bucket_id = 'cashbook_proofs' AND folder_matches) OR (scope_level <> 'Congregation')
// PostgreSQL combines PERMISSIVE policies — and the two operands of this OR — with OR.
// The right-hand branch has NO bucket test, so for any user holding an active
// non-Congregation scope row it is TRUE for a write to ANY bucket, including the
// hyphen `cashbook-proofs` bucket the app actually uses. That is a cross-bucket
// authorization leak.
//
// Tranche 4 rewrites the predicate as:
//     bucket_id = 'cashbook_proofs' AND (folder_matches OR scope_level <> 'Congregation')
// so the bucket condition wraps EVERY authorising branch.
//
// This module encodes both forms as pure logic so the invariant — the FIXED
// underscore-bucket write policies cannot authorize a write to any bucket other than
// their own — is asserted by a unit test without a database. It models policy
// boolean logic ONLY; it is NOT a substitute for effective-RLS testing on a live
// Postgres stack (see tranche4-access-checks.md).
// ─────────────────────────────────────────────────────────────────────────────

/** The bucket the underscore-bucket write policies legitimately own. */
export const UNDERSCORE_BUCKET = "cashbook_proofs";
/** The hyphen bucket the application actually uses for proofs. */
export const HYPHEN_BUCKET = "cashbook-proofs";

/**
 * Inputs to a single underscore-bucket write-policy evaluation. These mirror the
 * sub-expressions in the SQL predicate, decoupled from any database:
 *  - `targetBucketId`      — bucket_id of the object the write targets.
 *  - `folderCongregationMatches` — folder[1]::uuid ∈ caller's active congregations.
 *  - `hasNonCongregationScope`   — caller has an active user_hierarchy_access row with
 *                                  scope_level <> 'Congregation'.
 */
export interface WritePolicyInput {
  targetBucketId: string;
  folderCongregationMatches: boolean;
  hasNonCongregationScope: boolean;
}

/**
 * Captured LIVE (leaky) predicate — the OR branch sits OUTSIDE the bucket test:
 *   (bucket_id = 'cashbook_proofs' AND folder_matches) OR (scope_level <> 'Congregation')
 * Documents the defect; retained so the test can prove the leak is real and that the
 * fix closes it.
 */
export function underscoreWritePolicyBefore(input: WritePolicyInput): boolean {
  return (
    (input.targetBucketId === UNDERSCORE_BUCKET && input.folderCongregationMatches) ||
    input.hasNonCongregationScope
  );
}

/**
 * Tranche 4 (fixed) predicate — the bucket test wraps EVERY authorising branch:
 *   bucket_id = 'cashbook_proofs' AND (folder_matches OR scope_level <> 'Congregation')
 */
export function underscoreWritePolicyAfter(input: WritePolicyInput): boolean {
  return (
    input.targetBucketId === UNDERSCORE_BUCKET &&
    (input.folderCongregationMatches || input.hasNonCongregationScope)
  );
}

/**
 * The Tranche 4 cross-bucket invariant, as a reusable assertion over a policy
 * predicate: a write policy that owns `ownBucket` must DENY every write whose target
 * bucket is anything other than `ownBucket`, for ALL combinations of the other
 * predicate inputs. Returns true iff the predicate never authorizes a foreign bucket.
 */
export function cannotAuthorizeForeignBucket(
  predicate: (input: WritePolicyInput) => boolean,
  ownBucket: string,
  foreignBuckets: readonly string[],
): boolean {
  const boolCombos = [false, true];
  for (const targetBucketId of foreignBuckets) {
    if (targetBucketId === ownBucket) continue; // not foreign
    for (const folderCongregationMatches of boolCombos) {
      for (const hasNonCongregationScope of boolCombos) {
        if (predicate({ targetBucketId, folderCongregationMatches, hasNonCongregationScope })) {
          return false; // authorized a foreign bucket → invariant violated
        }
      }
    }
  }
  return true;
}
