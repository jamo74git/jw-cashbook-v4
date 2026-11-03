import { describe, it, expect } from "vitest";
import { resolveProofKey, PROOF_PROJECT_ORIGIN, PROOF_BUCKET } from "@/lib/storage/proofReference";

const KEY = "11111111-1111-1111-1111-111111111111/2026/10/AM_2026-10-W3/22222222-2222-2222-2222-222222222222/20261012120000-proof.jpg";

describe("resolveProofKey", () => {
  it("accepts a legacy PUBLIC url for the exact project + bucket and extracts the key", () => {
    const url = `${PROOF_PROJECT_ORIGIN}/storage/v1/object/public/${PROOF_BUCKET}/${KEY}`;
    expect(resolveProofKey(url)).toEqual({ kind: "key", key: KEY });
  });

  it("accepts a sign/authenticated url for the exact project + bucket", () => {
    const signed = `${PROOF_PROJECT_ORIGIN}/storage/v1/object/sign/${PROOF_BUCKET}/${KEY}?token=abc`;
    const authed = `${PROOF_PROJECT_ORIGIN}/storage/v1/object/authenticated/${PROOF_BUCKET}/${KEY}`;
    expect(resolveProofKey(signed)).toEqual({ kind: "key", key: KEY });
    expect(resolveProofKey(authed)).toEqual({ kind: "key", key: KEY });
  });

  it("accepts a bare object key (no scheme) going forward", () => {
    expect(resolveProofKey(KEY)).toEqual({ kind: "key", key: KEY });
  });

  it("decodes percent-encoded path segments in the key", () => {
    const url = `${PROOF_PROJECT_ORIGIN}/storage/v1/object/public/${PROOF_BUCKET}/a%20b/c.jpg`;
    expect(resolveProofKey(url)).toEqual({ kind: "key", key: "a b/c.jpg" });
  });

  it("rejects a foreign origin (no substring matching)", () => {
    const evil = `https://evil.example.com/storage/v1/object/public/${PROOF_BUCKET}/${KEY}`;
    expect(resolveProofKey(evil).kind).toBe("unrecognized");
  });

  it("rejects a look-alike host that merely contains the real host as a substring", () => {
    const lookalike = `https://cwdyixafvylzgtpsfmwr.supabase.co.evil.com/storage/v1/object/public/${PROOF_BUCKET}/${KEY}`;
    expect(resolveProofKey(lookalike).kind).toBe("unrecognized");
  });

  it("rejects the real host embedded inside a foreign url path", () => {
    const embedded = `https://evil.com/${PROOF_PROJECT_ORIGIN}/storage/v1/object/public/${PROOF_BUCKET}/${KEY}`;
    expect(resolveProofKey(embedded).kind).toBe("unrecognized");
  });

  it("rejects a different bucket on the correct origin", () => {
    const other = `${PROOF_PROJECT_ORIGIN}/storage/v1/object/public/cashbook_proofs/${KEY}`;
    const res = resolveProofKey(other);
    expect(res.kind).toBe("unrecognized");
    if (res.kind === "unrecognized") expect(res.reason).toBe("foreign-bucket");
  });

  it("rejects a bucket name that is only a prefix of the real bucket", () => {
    const res = resolveProofKey(`${PROOF_PROJECT_ORIGIN}/storage/v1/object/public/cashbook-proofs-evil/${KEY}`);
    expect(res.kind).toBe("unrecognized");
  });

  it("rejects a non-storage path on the correct origin", () => {
    const res = resolveProofKey(`${PROOF_PROJECT_ORIGIN}/rest/v1/cashbook_attachment`);
    expect(res.kind).toBe("unrecognized");
  });

  it("rejects empty / null / whitespace", () => {
    expect(resolveProofKey(null).kind).toBe("unrecognized");
    expect(resolveProofKey(undefined).kind).toBe("unrecognized");
    expect(resolveProofKey("   ").kind).toBe("unrecognized");
  });

  it("rejects path traversal in a BARE key", () => {
    expect(resolveProofKey("foo/../../etc/passwd").kind).toBe("unrecognized");
    expect(resolveProofKey("a/./b").kind).toBe("unrecognized");
  });

  it("normalises away traversal segments inside a url path (URL parser collapses '..')", () => {
    // The WHATWG URL parser resolves `a/../b` to `b` before we inspect it, so there is
    // no traversal left to reject — it yields a safe, normalised key.
    const res = resolveProofKey(`${PROOF_PROJECT_ORIGIN}/storage/v1/object/public/${PROOF_BUCKET}/a/../b`);
    expect(res.kind).toBe("key");
    if (res.kind === "key") {
      expect(res.key).toBe("b");
      expect(res.key).not.toContain("..");
    }
  });

  it("rejects a url with no key after the bucket segment", () => {
    expect(resolveProofKey(`${PROOF_PROJECT_ORIGIN}/storage/v1/object/public/${PROOF_BUCKET}/`).kind).toBe("unrecognized");
  });
});
