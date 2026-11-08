import { describe, it, expect } from "vitest";
import {
  UNDERSCORE_BUCKET,
  HYPHEN_BUCKET,
  underscoreWritePolicyBefore,
  underscoreWritePolicyAfter,
  cannotAuthorizeForeignBucket,
  type WritePolicyInput,
} from "@/lib/storage/crossBucketPredicate";

// Buckets a write could target in this project (plus one arbitrary foreign name).
const FOREIGN_BUCKETS = [HYPHEN_BUCKET, "some-other-bucket"] as const;

describe("Tranche 4 cross-bucket write predicate (underscore bucket)", () => {
  describe("captured LIVE predicate (defect documented)", () => {
    it("LEAKS: authorizes a write to the hyphen bucket for a non-Congregation-scope user", () => {
      // This is the live defect — the OR branch has no bucket test.
      const leak: WritePolicyInput = {
        targetBucketId: HYPHEN_BUCKET,
        folderCongregationMatches: false,
        hasNonCongregationScope: true,
      };
      expect(underscoreWritePolicyBefore(leak)).toBe(true);
    });

    it("the live predicate therefore FAILS the cross-bucket invariant", () => {
      expect(
        cannotAuthorizeForeignBucket(underscoreWritePolicyBefore, UNDERSCORE_BUCKET, FOREIGN_BUCKETS),
      ).toBe(false);
    });
  });

  describe("Tranche 4 fixed predicate", () => {
    it("cannot authorize a write to ANY bucket other than its own, for all input combinations", () => {
      expect(
        cannotAuthorizeForeignBucket(underscoreWritePolicyAfter, UNDERSCORE_BUCKET, FOREIGN_BUCKETS),
      ).toBe(true);
    });

    it("denies the exact leak case the live predicate allowed", () => {
      expect(
        underscoreWritePolicyAfter({
          targetBucketId: HYPHEN_BUCKET,
          folderCongregationMatches: false,
          hasNonCongregationScope: true,
        }),
      ).toBe(false);
    });

    it("denies a foreign-bucket write even when the folder congregation matches", () => {
      expect(
        underscoreWritePolicyAfter({
          targetBucketId: HYPHEN_BUCKET,
          folderCongregationMatches: true,
          hasNonCongregationScope: false,
        }),
      ).toBe(false);
    });

    it("still allows a legitimate own-bucket write (folder match)", () => {
      expect(
        underscoreWritePolicyAfter({
          targetBucketId: UNDERSCORE_BUCKET,
          folderCongregationMatches: true,
          hasNonCongregationScope: false,
        }),
      ).toBe(true);
    });

    it("still allows a legitimate own-bucket write (non-Congregation scope)", () => {
      expect(
        underscoreWritePolicyAfter({
          targetBucketId: UNDERSCORE_BUCKET,
          folderCongregationMatches: false,
          hasNonCongregationScope: true,
        }),
      ).toBe(true);
    });

    it("denies an own-bucket write when neither authorising branch holds", () => {
      expect(
        underscoreWritePolicyAfter({
          targetBucketId: UNDERSCORE_BUCKET,
          folderCongregationMatches: false,
          hasNonCongregationScope: false,
        }),
      ).toBe(false);
    });
  });
});
