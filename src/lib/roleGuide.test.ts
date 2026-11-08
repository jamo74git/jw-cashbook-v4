// PRIORITY 3 — per-role guide selection (pure content map). Verifies every role has a
// guide and that the capture/audit-touching roles surface the independence note.
import { describe, it, expect } from "vitest";
import { getRoleGuide, CASHBOOK_FLOW } from "@/lib/roleGuide";
import { ROLES } from "@/lib/types";

describe("getRoleGuide (per-role selection)", () => {
  it("returns a guide for every canonical role", () => {
    for (const role of ROLES) {
      const guide = getRoleGuide(role);
      expect(guide.role).toBe(role);
      expect(guide.summary.length).toBeGreaterThan(0);
      expect(guide.bullets.length).toBeGreaterThan(0);
    }
  });

  it("Treasurer is the default sign-off and cannot approve its own capture", () => {
    const g = getRoleGuide("Treasurer");
    expect(g.bullets.join(" ")).toMatch(/default sign-off/i);
    expect(g.note).toMatch(/cannot approve a capture you prepared/i);
  });

  it("Chairperson is an exception path with a recorded-reason / independence note", () => {
    const g = getRoleGuide("Chairperson");
    expect(g.bullets.join(" ")).toMatch(/exception/i);
    expect(g.note).toMatch(/no part in preparing/i);
  });

  it("Auditor cannot sign off a capture they prepared, nor sign twice", () => {
    const g = getRoleGuide("Auditor");
    expect(g.note).toMatch(/cannot sign off a capture you prepared/i);
    expect(g.note).toMatch(/same person cannot sign it twice/i);
  });

  it("Elder oversight is explicitly not an audit signature", () => {
    const g = getRoleGuide("Elder");
    expect(g.note).toMatch(/not an audit signature/i);
  });

  it("Secretary guide reflects totals-only (no line items / proof images)", () => {
    const g = getRoleGuide("Secretary");
    expect(g.note).toMatch(/totals only/i);
  });

  it("exposes the canonical capture -> submit -> audit flow", () => {
    expect(CASHBOOK_FLOW.length).toBe(3);
    expect(CASHBOOK_FLOW[0]).toMatch(/capture/i);
    expect(CASHBOOK_FLOW[2]).toMatch(/sign off|auditor/i);
  });
});
