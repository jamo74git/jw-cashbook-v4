import { describe, it, expect } from "vitest";
import { isAwaitingBankingOnly } from "@/lib/balanceState";
import type { CaptureItem } from "@/lib/captureTotals";

const item = (section: CaptureItem["section"], item_type: CaptureItem["item_type"], amount: number): CaptureItem => ({
  section,
  item_type,
  amount,
  proof_status: null,
  item_count: null,
});

describe("isAwaitingBankingOnly", () => {
  it("is true when the only shortfall is unbanked cash", () => {
    expect(isAwaitingBankingOnly([item("Members", "Cash", 100)])).toBe(true);
  });
  it("is true with EFT already banked and cash still pending", () => {
    expect(isAwaitingBankingOnly([item("Members", "EFT", 50), item("Officers", "Cash", 40)])).toBe(true);
  });
  it("is false when balanced", () => {
    expect(isAwaitingBankingOnly([item("Members", "CashBanked", 100)])).toBe(false);
  });
  it("is false for a real imbalance (expense not netted after banking)", () => {
    expect(isAwaitingBankingOnly([item("Members", "CashBanked", 100), item("Expenses", "Expense", 20)])).toBe(false);
  });
  it("is false when the shortfall differs from pending cash", () => {
    expect(isAwaitingBankingOnly([item("Members", "Cash", 100), item("Expenses", "Expense", 20)])).toBe(false);
  });
  it("is false when there are no items", () => {
    expect(isAwaitingBankingOnly([])).toBe(false);
  });
});
