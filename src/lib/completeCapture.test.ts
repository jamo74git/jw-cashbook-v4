// PRIORITY 1 — Complete_Capture freeze, sign-off resolution, and the Review_Ready gate.
import { describe, it, expect } from "vitest";
import {
  computeRequiredManifest,
  outstandingProofs,
  resolveSignOff,
  computeReviewReadiness,
  proofRequiredFor,
  type ManifestLineInput,
} from "@/lib/completeCapture";

function line(over: Partial<ManifestLineInput> = {}): ManifestLineInput {
  return { localId: "l1", section: "Members", item_type: "Cash", amount: 100, ...over };
}

describe("computeRequiredManifest (frozen proof list belonging to a revision)", () => {
  it("records present vs outstanding vs exempt per line and freezes the revision", () => {
    const lines: ManifestLineInput[] = [
      line({ localId: "cash", section: "Members", item_type: "Cash", amount: 100 }),
      line({ localId: "eft", section: "Members", item_type: "EFT", amount: 50, proofObjectKey: "k-eft" }),
      line({ localId: "burial", section: "Burial", item_type: "Burial", amount: 20 }), // no proof yet
    ];
    const m = computeRequiredManifest(lines, { revision: 3, frozenAt: "2026-01-01T00:00:00Z" });
    expect(m.revision).toBe(3);
    const byId = Object.fromEntries(m.proofs.map((p) => [p.lineLocalId, p.status]));
    expect(byId.cash).toBe("exempt");
    expect(byId.eft).toBe("declared-present");
    expect(byId.burial).toBe("declared-outstanding"); // may finish AFTER submission
    expect(outstandingProofs(m).map((p) => p.lineLocalId)).toEqual(["burial"]);
  });

  it("marks balance: income === banked + expenses", () => {
    // 100 cash income, banked 0, expenses 0 -> not balanced (cash still pending).
    const unbalanced = computeRequiredManifest([line({ item_type: "Cash", amount: 100 })], {
      revision: 1,
      frozenAt: "t",
    });
    expect(unbalanced.balanced).toBe(false);
    // 100 members income banked as 100 EFT -> balanced.
    const balanced = computeRequiredManifest(
      [line({ item_type: "EFT", amount: 100, proofObjectKey: "k" })],
      { revision: 1, frozenAt: "t" }
    );
    expect(balanced.balanced).toBe(true);
  });

  it("an empty capture (R0 no-tithing) freezes an empty, balanced manifest", () => {
    const m = computeRequiredManifest([], { revision: 1, frozenAt: "t" });
    expect(m.proofs).toEqual([]);
    expect(m.balanced).toBe(true);
  });
});

describe("resolveSignOff (Treasurer default; everyone else = exception)", () => {
  it("Treasurer is the default signer, no exception reason required", () => {
    const r = resolveSignOff("Treasurer");
    expect(r).toMatchObject({ eligible: true, signOffRole: "Treasurer", requiresException: false, reason: "default" });
  });
  it("Chairperson may sign only as a recorded exception", () => {
    const r = resolveSignOff("Chairperson");
    expect(r).toMatchObject({ eligible: true, signOffRole: "Treasurer", requiresException: true, reason: "exception" });
  });
  it("Elder (capture override) is an exception signer", () => {
    expect(resolveSignOff("Elder")).toMatchObject({ eligible: true, requiresException: true });
  });
  it("roles without capture.submit are ineligible (routed through the matrix)", () => {
    expect(resolveSignOff("Auditor")).toMatchObject({ eligible: false, requiresException: false, reason: "ineligible" });
    expect(resolveSignOff("Secretary").eligible).toBe(false);
    expect(resolveSignOff("HO").eligible).toBe(false);
  });
});

describe("computeReviewReadiness (Submitted != Ready for Audit)", () => {
  const lines = [
    { id: "eft", section: "Members", item_type: "EFT", amount: 100 },
    { id: "cash", section: "Members", item_type: "Cash", amount: 0 },
  ];
  it("is NOT ready while a required proof has no attachment", () => {
    const r = computeReviewReadiness(lines, []); // no attachments
    expect(r.ready).toBe(false);
    expect(r.missingEvidenceLineIds).toContain("eft");
  });
  it("is ready once evidence present AND the revision balances", () => {
    const r = computeReviewReadiness(lines, ["eft"]);
    expect(r.balanced).toBe(true);
    expect(r.missingEvidenceLineIds).toEqual([]);
    expect(r.ready).toBe(true);
  });
  it("is NOT ready when evidence is present but the revision does not balance", () => {
    const unbalanced = [{ id: "cash", section: "Members", item_type: "Cash", amount: 100 }];
    const r = computeReviewReadiness(unbalanced, []);
    expect(r.balanced).toBe(false);
    expect(r.ready).toBe(false);
  });
  it("cash is exempt from evidence", () => {
    expect(proofRequiredFor("Cash")).toBe(false);
    expect(proofRequiredFor("EFT")).toBe(true);
  });
});
