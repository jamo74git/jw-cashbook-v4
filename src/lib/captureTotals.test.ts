import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { isBalanced, applyCashRule, cashProofInvariantHolds, type CaptureItem } from "@/lib/captureTotals";

// Amounts generated at cent precision to avoid float noise.
const money = () => fc.integer({ min: 0, max: 1_000_000 }).map((c) => c / 100);

describe("captureTotals", () => {
  // Feature: restore-to-vite, Property 2: applying the cash rule yields NULL item_count
  // and NULL proof_status for any Cash item.
  it("Property 2: cash-proof invariant holds after applyCashRule", () => {
    fc.assert(
      fc.property(
        money(),
        fc.option(fc.integer({ min: 1, max: 50 }), { nil: null }),
        fc.option(fc.constant("uploaded"), { nil: null }),
        (amount, item_count, proof_status) => {
          const item: CaptureItem = { section: "Members", item_type: "Cash", amount, item_count, proof_status };
          const normalized = applyCashRule(item);
          expect(normalized.item_count).toBeNull();
          expect(normalized.proof_status).toBeNull();
          expect(cashProofInvariantHolds(normalized)).toBe(true);
        }
      )
    );
  });

  // Feature: restore-to-vite, Property 3: a period is balanced when income === banked +
  // expenses. An all-EFT (fully banked) ledger with no expenses is balanced; adding an
  // unoffset expense makes it unbalanced.
  it("Property 3: balancing rule (income === banked + expenses)", () => {
    fc.assert(
      fc.property(
        fc.array(money(), { minLength: 1, maxLength: 12 }),
        money().filter((e) => e > 0),
        (amounts, expense) => {
          const eftLedger: CaptureItem[] = amounts.map((a) => ({
            section: "Members",
            item_type: "EFT",
            amount: a,
            item_count: 1,
            proof_status: "uploaded",
          }));
          // income === banked, no expenses -> balanced
          expect(isBalanced(eftLedger)).toBe(true);

          // add an expense with no offsetting reduction in banking -> unbalanced
          const withExpense: CaptureItem[] = [
            ...eftLedger,
            { section: "Expenses", item_type: "Expense", amount: expense, item_count: null, proof_status: "uploaded" },
          ];
          expect(isBalanced(withExpense)).toBe(false);
        }
      )
    );
  });
});
