// ─────────────────────────────────────────────────────────────────────────────
// CENSUS BALANCING + INACTIVITY — pure, Dexie-free helpers (Phase B).
// This module holds ALL the census balancing + staleness logic so it can be
// unit-tested in isolation (mirrors oacWeeks.ts). censusRepo and CensusManager
// import from here; getInactivityStatus in the repo delegates to inactivityStatus.
//
// Balancing rule (contentious manual-docs reconciliation): a congregation's
// total_souls MUST equal the sum of its souls breakdown, and the sum of a
// congregation's priestship splits MUST equal the congregation totals.
// ─────────────────────────────────────────────────────────────────────────────

/** Coerce any numeric input (NaN/Infinity/null/undefined/non-number) to a finite number, else 0. */
function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

// ─── Souls breakdown balancing ────────────────────────────────────────────────
export interface SoulsBreakdown {
  adults: number;
  children_0_15: number;
  unconfirmed_youth: number;
  confirmed_youth: number;
  seniors: number;
}

export interface BalanceResult {
  balanced: boolean;
  expected: number;
  actual: number;
  /** actual - expected (positive = over, negative = under). */
  diff: number;
}

/** Sum the five breakdown buckets, coercing any missing/invalid value to 0. */
export function soulsBreakdownTotal(b: SoulsBreakdown): number {
  return (
    num(b.adults) +
    num(b.children_0_15) +
    num(b.unconfirmed_youth) +
    num(b.confirmed_youth) +
    num(b.seniors)
  );
}

/**
 * Check that totalSouls equals the breakdown sum.
 * expected = totalSouls, actual = breakdown sum, diff = actual - expected.
 */
export function checkSoulsBalance(totalSouls: number, b: SoulsBreakdown): BalanceResult {
  const expected = num(totalSouls);
  const actual = soulsBreakdownTotal(b);
  const diff = actual - expected;
  return { balanced: diff === 0, expected, actual, diff };
}

// ─── Priestship split balancing ───────────────────────────────────────────────
export interface PriestshipMetrics {
  families: number;
  contact_points: number;
  souls: number;
}

export interface PriestshipSplitResult {
  families: BalanceResult;
  contact_points: BalanceResult;
  souls: BalanceResult;
  allBalanced: boolean;
}

function sumMetric(rows: PriestshipMetrics[], key: keyof PriestshipMetrics): number {
  return rows.reduce((acc, r) => acc + num(r[key]), 0);
}

function metricBalance(actual: number, expected: number): BalanceResult {
  const diff = actual - expected;
  return { balanced: diff === 0, expected, actual, diff };
}

/**
 * Check that the per-priestship split sums match the congregation totals for each
 * of families / contact_points / souls. expected = congregation total,
 * actual = sum of the priestship rows, diff = actual - expected.
 */
export function checkPriestshipSplit(
  rows: PriestshipMetrics[],
  totals: PriestshipMetrics
): PriestshipSplitResult {
  const families = metricBalance(sumMetric(rows, "families"), num(totals.families));
  const contact_points = metricBalance(sumMetric(rows, "contact_points"), num(totals.contact_points));
  const souls = metricBalance(sumMetric(rows, "souls"), num(totals.souls));
  return {
    families,
    contact_points,
    souls,
    allBalanced: families.balanced && contact_points.balanced && souls.balanced,
  };
}

// ─── Inactivity / staleness flags (Decision D6) ───────────────────────────────
export type InactivityStatus = "green" | "amber" | "red";

export interface InactivityResult {
  status: InactivityStatus;
  days: number | null;
  label: string;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Whole days elapsed between `iso` and `now` (default now()). Returns null when
 * `iso` is null/invalid. Negative elapsed (future date) is clamped to 0.
 */
export function daysSince(iso: string | null, now: Date = new Date()): number | null {
  if (!iso) return null;
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const elapsed = now.getTime() - t;
  if (elapsed < 0) return 0;
  return Math.floor(elapsed / MS_PER_DAY);
}

/**
 * Map the days-since-verification to a staleness flag per Decision D6:
 *   days < 90          → green  "Verified"
 *   90 <= days <= 180  → amber  "Update due — 3 month flag"
 *   days > 180         → red    "Overdue — 6 month flag"
 *   null (never)       → red    "Overdue — 6 month flag"
 */
export function inactivityStatus(iso: string | null, now: Date = new Date()): InactivityResult {
  const days = daysSince(iso, now);
  if (days === null) {
    return { status: "red", days: null, label: "Overdue — 6 month flag" };
  }
  if (days < 90) {
    return { status: "green", days, label: "Verified" };
  }
  if (days <= 180) {
    return { status: "amber", days, label: "Update due — 3 month flag" };
  }
  return { status: "red", days, label: "Overdue — 6 month flag" };
}
