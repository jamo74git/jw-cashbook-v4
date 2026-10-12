import { describe, it, expect } from "vitest";
import {
  soulsBreakdownTotal,
  checkSoulsBalance,
  checkPriestshipSplit,
  daysSince,
  inactivityStatus,
  type SoulsBreakdown,
  type PriestshipMetrics,
} from "@/lib/censusBalancing";

function breakdown(partial: Partial<SoulsBreakdown>): SoulsBreakdown {
  return {
    adults: 0,
    children_0_15: 0,
    unconfirmed_youth: 0,
    confirmed_youth: 0,
    seniors: 0,
    ...partial,
  };
}

describe("checkSoulsBalance", () => {
  it("balanced when total equals the breakdown sum", () => {
    const b = breakdown({ adults: 50, children_0_15: 20, unconfirmed_youth: 10, confirmed_youth: 15, seniors: 5 });
    expect(soulsBreakdownTotal(b)).toBe(100);
    const r = checkSoulsBalance(100, b);
    expect(r.balanced).toBe(true);
    expect(r.expected).toBe(100);
    expect(r.actual).toBe(100);
    expect(r.diff).toBe(0);
  });

  it("over: breakdown exceeds total by +N (diff = actual - expected)", () => {
    const b = breakdown({ adults: 60, children_0_15: 20, unconfirmed_youth: 10, confirmed_youth: 15, seniors: 5 });
    const r = checkSoulsBalance(100, b);
    expect(r.balanced).toBe(false);
    expect(r.actual).toBe(110);
    expect(r.expected).toBe(100);
    expect(r.diff).toBe(10);
  });

  it("under: breakdown short of total by -N", () => {
    const b = breakdown({ adults: 40, children_0_15: 20, unconfirmed_youth: 10, confirmed_youth: 15, seniors: 5 });
    const r = checkSoulsBalance(100, b);
    expect(r.balanced).toBe(false);
    expect(r.actual).toBe(90);
    expect(r.expected).toBe(100);
    expect(r.diff).toBe(-10);
  });

  it("coerces NaN/invalid numeric inputs to 0", () => {
    const b = breakdown({ adults: Number.NaN as unknown as number, children_0_15: 20 });
    const r = checkSoulsBalance(20, b);
    expect(r.actual).toBe(20);
    expect(r.balanced).toBe(true);
  });
});

describe("checkPriestshipSplit", () => {
  const totals: PriestshipMetrics = { families: 30, contact_points: 45, souls: 100 };

  it("allBalanced when every metric sums to the congregation totals", () => {
    const rows: PriestshipMetrics[] = [
      { families: 10, contact_points: 15, souls: 40 },
      { families: 20, contact_points: 30, souls: 60 },
    ];
    const r = checkPriestshipSplit(rows, totals);
    expect(r.allBalanced).toBe(true);
    expect(r.families.diff).toBe(0);
    expect(r.contact_points.diff).toBe(0);
    expect(r.souls.diff).toBe(0);
  });

  it("mismatched: allBalanced=false with exact per-metric diffs", () => {
    const rows: PriestshipMetrics[] = [
      { families: 10, contact_points: 15, souls: 40 },
      { families: 15, contact_points: 35, souls: 55 },
    ];
    const r = checkPriestshipSplit(rows, totals);
    expect(r.allBalanced).toBe(false);
    // families: 25 vs 30 -> -5
    expect(r.families.actual).toBe(25);
    expect(r.families.diff).toBe(-5);
    // contact_points: 50 vs 45 -> +5
    expect(r.contact_points.actual).toBe(50);
    expect(r.contact_points.diff).toBe(5);
    // souls: 95 vs 100 -> -5
    expect(r.souls.actual).toBe(95);
    expect(r.souls.diff).toBe(-5);
  });

  it("empty split sums to 0 for every metric", () => {
    const r = checkPriestshipSplit([], totals);
    expect(r.families.actual).toBe(0);
    expect(r.souls.diff).toBe(-100);
    expect(r.allBalanced).toBe(false);
  });
});

describe("daysSince / inactivityStatus (fixed now)", () => {
  const now = new Date("2024-06-01T00:00:00.000Z");
  const isoDaysAgo = (days: number): string =>
    new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString();

  it("daysSince returns null for null/invalid, 0 for future", () => {
    expect(daysSince(null, now)).toBeNull();
    expect(daysSince("not-a-date", now)).toBeNull();
    expect(daysSince(isoDaysAgo(-5), now)).toBe(0);
  });

  it("day 0 -> green Verified", () => {
    const r = inactivityStatus(isoDaysAgo(0), now);
    expect(r.status).toBe("green");
    expect(r.days).toBe(0);
    expect(r.label).toBe("Verified");
  });

  it("day 89 -> green Verified", () => {
    expect(inactivityStatus(isoDaysAgo(89), now).status).toBe("green");
  });

  it("day 90 -> amber Update due — 3 month flag", () => {
    const r = inactivityStatus(isoDaysAgo(90), now);
    expect(r.status).toBe("amber");
    expect(r.days).toBe(90);
    expect(r.label).toBe("Update due — 3 month flag");
  });

  it("day 180 -> amber (boundary inclusive)", () => {
    const r = inactivityStatus(isoDaysAgo(180), now);
    expect(r.status).toBe("amber");
    expect(r.days).toBe(180);
  });

  it("day 181 -> red Overdue — 6 month flag", () => {
    const r = inactivityStatus(isoDaysAgo(181), now);
    expect(r.status).toBe("red");
    expect(r.days).toBe(181);
    expect(r.label).toBe("Overdue — 6 month flag");
  });

  it("null -> red Overdue — 6 month flag (never verified)", () => {
    const r = inactivityStatus(null, now);
    expect(r.status).toBe("red");
    expect(r.days).toBeNull();
    expect(r.label).toBe("Overdue — 6 month flag");
  });
});
