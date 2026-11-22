// ─────────────────────────────────────────────────────────────────────────────
// BANKED-CASH DEPOSIT COMBINATION (pure, testable) — design §4.1.
//
// Cash is collected per service (AM/PM). Each cash-bearing period must be covered by a
// banked-cash deposit slip. A slip may cover ONE service's cash, or be a COMBINED slip
// covering the AM+PM cash of the SAME week. The combine/separate choice is made in the PM
// capture: when the PM has cash AND the same-week AM also had cash with no slip selected
// yet, prompt to COMBINE (one slip for both) or KEEP SEPARATE (PM captures its own). If the
// AM already has its own slip, the PM just captures its own.
//
// A combined slip must NOT span beyond the same week — it binds to a single
// (congregation_id, year, month, week). `canCombineSameWeek` is the client mirror of the
// server-side same-week safeguard (20261105140000 trigger); the server remains authoritative.
// ─────────────────────────────────────────────────────────────────────────────

export type DepositCoverage = "OwnService" | "CombinedWeek";

export type DepositPrompt = "combine-or-separate" | "none";

export interface DepositDecisionInput {
  currentService: "AM" | "PM";
  currentHasCash: boolean; // the current period has eligible/banked cash
  sameWeekAmExists: boolean; // an AM period exists for the same (cong, year, month, week)
  sameWeekAmHasCash: boolean; // that AM period had cash
  sameWeekAmHasSlip: boolean; // that AM cash is already covered by a slip
}

/**
 * Prompt to combine or keep separate ONLY in the PM capture, and only when the PM has cash
 * AND the same-week AM had cash with no covering slip yet. Otherwise capture the PM's own
 * slip without prompting (and the AM capture never prompts — the choice is made in the PM).
 */
export function resolveDepositPrompt(i: DepositDecisionInput): DepositPrompt {
  if (i.currentService !== "PM") return "none"; // the choice is made in the PM capture
  if (!i.currentHasCash) return "none";
  if (!i.sameWeekAmExists || !i.sameWeekAmHasCash) return "none";
  if (i.sameWeekAmHasSlip) return "none"; // AM already banked separately
  return "combine-or-separate";
}

export interface CombinablePeriod {
  congregationId: string;
  year: number;
  month: number;
  week: number;
  service: "AM" | "PM";
}

/**
 * Client mirror of the §2 same-week safeguard: two periods may be covered by one combined
 * slip ONLY when they share (congregationId, year, month, week) and are the AM + PM services
 * of that week. The server trigger remains the authority.
 */
export function canCombineSameWeek(am: CombinablePeriod, pm: CombinablePeriod): boolean {
  return (
    am.service === "AM" &&
    pm.service === "PM" &&
    am.congregationId === pm.congregationId &&
    am.year === pm.year &&
    am.month === pm.month &&
    am.week === pm.week
  );
}
