// PRIORITY 2 — two-person sign-off: eligibility, involvement, fresh-revision, the
// completing transition, and the Elder-referral predicate. Pure logic only; the
// AUTHORITATIVE server enforcement (RPC + trigger + partial indexes) is authored in the
// unapplied migration and is marked NEEDS AUTHENTICATED/HOSTED TESTING.
import { describe, it, expect } from "vitest";
import {
  signoffRoleKind,
  signoffPermCode,
  involvementSet,
  isSignerIndependent,
  signoffsForRevision,
  pairHasAuditor,
  evaluateSignoffAttempt,
  pendingNeedsSecond,
  signoffLabel,
  type SignoffAttempt,
  type SignoffRecord,
} from "@/audit/signoff";

const GEN = 1;
const REV = 5;

function auditorSignoff(userId: string, over: Partial<SignoffRecord> = {}): SignoffRecord {
  return {
    actorUserId: userId,
    permCode: "A",
    actingAsAuditor: false,
    actingReason: null,
    captureGeneration: GEN,
    reviewedRevision: REV,
    slot: 1,
    ...over,
  };
}

function attempt(over: Partial<SignoffAttempt> = {}): SignoffAttempt {
  return {
    actor: { userId: "auditor-2", role: "Auditor" },
    period: { captureGeneration: GEN, serverRevision: REV },
    reviewedRevision: REV,
    captureGeneration: GEN,
    existingSignoffs: [],
    involvement: new Set<string>(),
    reviewReady: true,
    actingReason: null,
    ...over,
  };
}

describe("signoffRoleKind / signoffPermCode (matrix-routed eligibility)", () => {
  it("Auditor is the primary signer (A)", () => {
    expect(signoffRoleKind("Auditor")).toBe("primary");
    expect(signoffPermCode("Auditor")).toBe("A");
  });
  it("Chairperson is the acting signer (O)", () => {
    expect(signoffRoleKind("Chairperson")).toBe("acting");
    expect(signoffPermCode("Chairperson")).toBe("O");
  });
  it("Elder is NOT an eligible sign-off signatory (oversight is not a signature)", () => {
    expect(signoffRoleKind("Elder")).toBeNull();
    expect(signoffPermCode("Elder")).toBeNull();
  });
  it("Treasurer/Secretary/HO/Overseer cannot sign off", () => {
    for (const r of ["Treasurer", "Secretary", "HO", "Overseer", "Apostle"] as const) {
      expect(signoffRoleKind(r)).toBeNull();
    }
  });
});

describe("involvementSet (independence, not just role)", () => {
  it("includes the submitter and every prepare/submit/role-switch participant", () => {
    const set = involvementSet({
      submittedBy: "treasurer-1",
      participationLog: [
        { userId: "treasurer-1", actionType: "CAPTURE" },
        { userId: "chair-9", actionType: "ACTING_AS_TREASURER" },
        { userId: "elder-3", actionType: "SELF_REVIEW_EXCEPTION" },
        { userId: "someone", actionType: "AUDIT_APPROVE" }, // not an involvement action
      ],
    });
    expect(set.has("treasurer-1")).toBe(true);
    expect(set.has("chair-9")).toBe(true);
    expect(set.has("elder-3")).toBe(true);
    expect(set.has("someone")).toBe(false);
    expect(isSignerIndependent("auditor-x", set)).toBe(true);
    expect(isSignerIndependent("chair-9", set)).toBe(false);
  });
});

describe("evaluateSignoffAttempt — no self-approval / no same person twice / involvement", () => {
  it("rejects the submitter (self-approval)", () => {
    const r = evaluateSignoffAttempt(
      attempt({ actor: { userId: "treasurer-1", role: "Auditor" }, involvement: new Set(["treasurer-1"]) })
    );
    expect(r).toMatchObject({ ok: false, error: "signer_involved" });
  });
  it("blocks a Chairperson who acted as Treasurer from signing by switching roles", () => {
    const r = evaluateSignoffAttempt(
      attempt({
        actor: { userId: "chair-9", role: "Chairperson" },
        involvement: new Set(["chair-9"]),
        existingSignoffs: [auditorSignoff("auditor-1")],
        actingReason: "Only one auditor available",
      })
    );
    expect(r).toMatchObject({ ok: false, error: "signer_involved" });
  });
  it("rejects the same person signing twice on the same revision", () => {
    const r = evaluateSignoffAttempt(
      attempt({ actor: { userId: "auditor-1", role: "Auditor" }, existingSignoffs: [auditorSignoff("auditor-1")] })
    );
    expect(r).toMatchObject({ ok: false, error: "already_signed" });
  });
  it("rejects an ineligible role (Elder) outright", () => {
    const r = evaluateSignoffAttempt(attempt({ actor: { userId: "elder-3", role: "Elder" } }));
    expect(r).toMatchObject({ ok: false, error: "signer_role_not_eligible" });
  });
});

describe("evaluateSignoffAttempt — first vs completing sign-off", () => {
  it("records the FIRST auditor sign-off without completing (stays 1 of 2)", () => {
    const r = evaluateSignoffAttempt(attempt({ actor: { userId: "auditor-1", role: "Auditor" } }));
    expect(r).toMatchObject({ ok: true, slot: 1, permCode: "A", willComplete: false, signoffCountAfter: 1 });
  });
  it("completes on the SECOND independent auditor sign-off when Review_Ready", () => {
    const r = evaluateSignoffAttempt(
      attempt({ actor: { userId: "auditor-2", role: "Auditor" }, existingSignoffs: [auditorSignoff("auditor-1")] })
    );
    expect(r).toMatchObject({ ok: true, slot: 2, willComplete: true, signoffCountAfter: 2 });
  });
});

describe("Chairperson acting-auditor second sign-off", () => {
  it("requires a recorded reason", () => {
    const r = evaluateSignoffAttempt(
      attempt({
        actor: { userId: "chair-9", role: "Chairperson" },
        existingSignoffs: [auditorSignoff("auditor-1")],
        actingReason: "   ",
      })
    );
    expect(r).toMatchObject({ ok: false, error: "reason_required" });
  });
  it("cannot be the first/sole signer (acting is the second slot only)", () => {
    const r = evaluateSignoffAttempt(
      attempt({ actor: { userId: "chair-9", role: "Chairperson" }, actingReason: "Treasurer ill" })
    );
    expect(r).toMatchObject({ ok: false, error: "acting_not_second_slot" });
  });
  it("completes as the second sign-off behind one real Auditor, with a reason", () => {
    const r = evaluateSignoffAttempt(
      attempt({
        actor: { userId: "chair-9", role: "Chairperson" },
        existingSignoffs: [auditorSignoff("auditor-1")],
        actingReason: "Only one auditor available",
      })
    );
    expect(r).toMatchObject({ ok: true, slot: 2, permCode: "O", acting: true, willComplete: true });
  });
});

describe("valid pair must contain one real Auditor", () => {
  it("pairHasAuditor is false for two acting sign-offs", () => {
    expect(pairHasAuditor([{ permCode: "O" }, { permCode: "O" }])).toBe(false);
    expect(pairHasAuditor([{ permCode: "A" }, { permCode: "O" }])).toBe(true);
  });
});

describe("succeed-or-fail-together — completing transition is coupled to a valid sign-off", () => {
  it("does NOT complete (and does not accept) when the revision is not Review_Ready", () => {
    const r = evaluateSignoffAttempt(
      attempt({
        actor: { userId: "auditor-2", role: "Auditor" },
        existingSignoffs: [auditorSignoff("auditor-1")],
        reviewReady: false,
      })
    );
    // The second sign-off is NOT accepted AND the approval is NOT completed — together.
    expect(r.ok).toBe(false);
    expect(r.error).toBe("not_review_ready");
    expect(r.willComplete).toBeUndefined();
  });
  it("willComplete is never set on a rejected attempt", () => {
    const r = evaluateSignoffAttempt(
      attempt({ actor: { userId: "auditor-1", role: "Auditor" }, existingSignoffs: [auditorSignoff("auditor-1")] })
    );
    expect(r.ok).toBe(false);
    expect(r.willComplete).toBeUndefined();
  });
});

describe("fresh revision requires fresh sign-offs; history preserved", () => {
  it("ignores sign-offs bound to a superseded revision", () => {
    const stale = auditorSignoff("auditor-1", { reviewedRevision: REV - 1 });
    const current = signoffsForRevision([stale], GEN, REV);
    expect(current).toEqual([]); // stale row preserved in input, just not counted
    // A new first sign-off on the current revision is slot 1 again (fresh sign-offs).
    const r = evaluateSignoffAttempt(
      attempt({ actor: { userId: "auditor-2", role: "Auditor" }, existingSignoffs: [stale] })
    );
    expect(r).toMatchObject({ ok: true, slot: 1, willComplete: false });
  });
  it("rejects a sign-off whose revision no longer matches the server (stale)", () => {
    const r = evaluateSignoffAttempt(
      attempt({ actor: { userId: "auditor-1", role: "Auditor" }, period: { captureGeneration: GEN, serverRevision: REV + 1 } })
    );
    expect(r).toMatchObject({ ok: false, error: "rejected_stale" });
  });
  it("rejects a sign-off from a superseded generation (HO reopen)", () => {
    const r = evaluateSignoffAttempt(
      attempt({ actor: { userId: "auditor-1", role: "Auditor" }, period: { captureGeneration: GEN + 1, serverRevision: REV } })
    );
    expect(r).toMatchObject({ ok: false, error: "rejected_stale" });
  });
});

describe("pendingNeedsSecond (Elder referral; leave pending, no one-signature closure)", () => {
  it("is true for a Review_Ready Submitted revision with exactly one sign-off", () => {
    expect(pendingNeedsSecond({ status: "Submitted", reviewReady: true, acceptedSignoffsThisRevision: 1 })).toBe(true);
  });
  it("is false with zero sign-offs (awaiting first, not a gap)", () => {
    expect(pendingNeedsSecond({ status: "Submitted", reviewReady: true, acceptedSignoffsThisRevision: 0 })).toBe(false);
  });
  it("is false once two sign-offs land (it would be AuditApproved)", () => {
    expect(pendingNeedsSecond({ status: "Submitted", reviewReady: true, acceptedSignoffsThisRevision: 2 })).toBe(false);
  });
  it("is false when not Review_Ready", () => {
    expect(pendingNeedsSecond({ status: "Submitted", reviewReady: false, acceptedSignoffsThisRevision: 1 })).toBe(false);
  });
});

describe("signoffLabel (UI)", () => {
  it("labels the first sign-off and the acting second sign-off", () => {
    expect(signoffLabel({ slot: 1, permCode: "A" }, "A. Nkosi")).toBe("Sign-off 1 of 2: Auditor — A. Nkosi");
    expect(signoffLabel({ slot: 2, permCode: "O" })).toBe("Second sign-off: Chairperson (acting auditor)");
    expect(signoffLabel({ slot: 2, permCode: "A" })).toBe("Second sign-off: Auditor");
  });
});
