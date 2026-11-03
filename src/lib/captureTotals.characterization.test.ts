// Characterization / regression baseline (Tranche 1, Task 1.3).
// Captures CURRENT behaviour as a regression guard. KNOWN-DEFECT notes reference Findings
// for later (Task 3) fixes; they are NOT assertions of desired permanent behaviour.
import { describe, it, expect } from "vitest";
import {
  isBalanced,
  expensesTotal,
  monthlyExpensesExceedThreshold,
  type CaptureItem,
} from "@/lib/captureTotals";

function item(partial: Partial<CaptureItem>): CaptureItem {
  return {
    section: "Members",
    item_type: "EFT",
    amount: 0,
    proof_status: null,
    item_count: null,
    ...partial,
  };
}

describe("captureTotals — characterization baseline (current behaviour)", () => {
  it("isBalanced: income === banked + expenses at cent precision", () => {
    expect(isBalanced([item({ section: "Members", item_type: "EFT", amount: 100 })])).toBe(true);
    expect(isBalanced([item({ section: "Members", item_type: "Cash", amount: 100 })])).toBe(false);
  });

  it("KNOWN DEFECT (Finding 28 / OBD-b): monthlyExpensesExceedThreshold is PER-PERIOD, not monthly", () => {
    const over = [item({ section: "Expenses", item_type: "Expense", amount: 600 })];
    const under = [item({ section: "Expenses", item_type: "Expense", amount: 300 })];
    expect(monthlyExpensesExceedThreshold(over, 500)).toBe(true);
    // Only the items passed are summed (current period); not aggregated across the month.
    expect(monthlyExpensesExceedThreshold(under, 500)).toBe(false);
    expect(expensesTotal(under)).toBe(300);
  });
});
