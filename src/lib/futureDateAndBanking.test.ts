// Task 1 (future-date guard, pure) + Task 5 (banking view separates EFT / DD / Cash banked /
// Cash pending). Pure logic, no IndexedDB/Supabase.
import { describe, it, expect } from "vitest";
import { isFutureDate, localTodayISO, bankingView, type CaptureItem } from "@/lib/captureTotals";

describe("isFutureDate", () => {
  const today = "2026-11-02";
  it("flags a date after the local device date", () => {
    expect(isFutureDate("2026-11-03", today)).toBe(true);
    expect(isFutureDate("2999-01-01", today)).toBe(true);
  });
  it("allows today and earlier dates", () => {
    expect(isFutureDate("2026-11-02", today)).toBe(false);
    expect(isFutureDate("2026-11-01", today)).toBe(false);
    expect(isFutureDate("2000-01-01", today)).toBe(false);
  });
  it("treats null/empty as not-future", () => {
    expect(isFutureDate(null, today)).toBe(false);
    expect(isFutureDate(undefined, today)).toBe(false);
    expect(isFutureDate("", today)).toBe(false);
  });
  it("localTodayISO returns a yyyy-mm-dd string", () => {
    expect(localTodayISO(new Date(2026, 0, 5))).toBe("2026-01-05");
  });
});

const ci = (p: Partial<CaptureItem>): CaptureItem => ({
  section: "Members", item_type: "Cash", amount: 0, proof_status: null, item_count: null, ...p,
});

describe("bankingView separation (Task 5)", () => {
  it("separates EFT, Direct Deposit, Cash banked and Cash pending; reports expenses", () => {
    const items = [
      ci({ section: "Members", item_type: "EFT", amount: 800 }),
      ci({ section: "Members", item_type: "DirectDebit", amount: 750 }),
      ci({ section: "Officers", item_type: "CashBanked", amount: 300 }),
      ci({ section: "Members", item_type: "Cash", amount: 120 }), // pending
      ci({ section: "Expenses", item_type: "Expense", amount: 60 }),
    ];
    const bv = bankingView(items);
    expect(bv.eft).toBe(800);
    expect(bv.directDebit).toBe(750);
    expect(bv.cashBanked).toBe(300);
    expect(bv.cashPending).toBe(120);
    expect(bv.expenses).toBe(60);
    // EFT/DD/CashBanked are the recorded "banking total" - NOT a statement match.
    expect(bv.bankingTotal).toBe(1850);
  });
});

describe("Task 2 - isFutureOacService", () => {
  it("flags a service whose OAC week opens after today; allows current/past", async () => {
    const { isFutureOacService } = await import("@/lib/oacWeeks");
    expect(isFutureOacService(2999, 1, 1)).toBe(true);   // far future
    expect(isFutureOacService(2020, 1, 1)).toBe(false);  // past
  });
});
