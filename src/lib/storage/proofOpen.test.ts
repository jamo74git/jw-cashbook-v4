import { describe, it, expect } from "vitest";
import { decideProofOpen, type SignedUrlResult } from "@/lib/storage/storagePort";

// Item 8: ProofLink open behavior (pure decision; no DOM needed).
describe("decideProofOpen", () => {
  const ok: SignedUrlResult = { status: "ok", url: "https://signed/x" };

  it("navigates the popup when one is available", () => {
    expect(decideProofOpen(ok, true)).toEqual({ kind: "navigate", url: "https://signed/x" });
  });

  it("falls back to an INLINE open link when the popup is blocked (never navigates current tab)", () => {
    expect(decideProofOpen(ok, false)).toEqual({ kind: "inline", url: "https://signed/x" });
  });

  it("surfaces denied / missing / error as failures, never ok", () => {
    expect(decideProofOpen({ status: "denied" }, true)).toEqual({ kind: "fail", status: "denied" });
    expect(decideProofOpen({ status: "missing" }, false)).toEqual({ kind: "fail", status: "missing" });
    expect(decideProofOpen({ status: "error" }, true)).toEqual({ kind: "fail", status: "error" });
  });

  it("a failed load is never treated as a viewable/issued link", () => {
    for (const s of ["denied", "missing", "error"] as const) {
      const a = decideProofOpen({ status: s }, false);
      expect(a.kind).toBe("fail");
    }
  });
});
