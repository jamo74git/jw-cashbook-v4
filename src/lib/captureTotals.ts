// ─────────────────────────────────────────────────────────────────────────────
// CAPTURE TOTALS, BANKING VIEW, BALANCING & CASH-PROOF INVARIANTS (pure logic).
// Grounded in product.md rules and the f6145ff1 capture pages.
//
// NOTE on balancing: product.md states "Total Income = Banked Amount + Expenses".
// The meaningful (non-tautological) reading, used here, is:
//   income (Members+Officers+Burial) === banked (EFT+DirectDebit+CashBanked) + expenses
// i.e. everything collected must be accounted for as banked funds plus expenses; cash
// that is still pending (not yet CashBanked) leaves the period unbalanced until banked.
// The exact submit/balance logic in the historical page was beyond the read window and
// should be reconfirmed against the real submit handler / DB constraint in the sync slice.
// ─────────────────────────────────────────────────────────────────────────────

import type { LineSection } from "@/lib/types";

export type ItemType =
  | "EFT"
  | "DirectDebit"
  | "Cash"
  | "CashPending"
  | "CashBanked"
  | "Burial"
  | "Expense";

export interface CaptureItem {
  section: LineSection; // Members | Officers | Burial | Expenses
  item_type: ItemType;
  amount: number;
  proof_status: string | null;
  item_count: number | null;
}

const INCOME_SECTIONS: LineSection[] = ["Members", "Officers", "Burial"];
const BANKED_TYPES: ItemType[] = ["EFT", "DirectDebit", "CashBanked"];
const CASH_PENDING_TYPES: ItemType[] = ["Cash", "CashPending"];

const cents = (n: number): number => Math.round(n * 100);
const sum = (items: CaptureItem[]): number => items.reduce((s, i) => s + Number(i.amount || 0), 0);

/** Per-section totals. */
export function sectionTotals(items: CaptureItem[]): Record<LineSection, number> {
  return {
    Members: sum(items.filter((i) => i.section === "Members")),
    Officers: sum(items.filter((i) => i.section === "Officers")),
    Burial: sum(items.filter((i) => i.section === "Burial")),
    Expenses: sum(items.filter((i) => i.section === "Expenses")),
  };
}

export function incomeTotal(items: CaptureItem[]): number {
  return sum(items.filter((i) => INCOME_SECTIONS.includes(i.section)));
}

export function bankedTotal(items: CaptureItem[]): number {
  return sum(items.filter((i) => BANKED_TYPES.includes(i.item_type)));
}

export function expensesTotal(items: CaptureItem[]): number {
  return sum(items.filter((i) => i.section === "Expenses"));
}

export interface BankingView {
  directDebit: number;
  eft: number;
  cashBanked: number;
  bankingTotal: number;
  cashPending: number;
  expenses: number;
}

/** Computed Banking-tab view (read-only summary). */
export function bankingView(items: CaptureItem[]): BankingView {
  const directDebit = sum(items.filter((i) => i.item_type === "DirectDebit"));
  const eft = sum(items.filter((i) => i.item_type === "EFT"));
  const cashBanked = sum(items.filter((i) => i.item_type === "CashBanked"));
  const cashPending = sum(
    items.filter((i) => INCOME_SECTIONS.includes(i.section) && CASH_PENDING_TYPES.includes(i.item_type))
  );
  return {
    directDebit,
    eft,
    cashBanked,
    bankingTotal: directDebit + eft + cashBanked,
    cashPending,
    expenses: expensesTotal(items),
  };
}

/** Balancing rule: income === banked + expenses (compared at cent precision). */
export function isBalanced(items: CaptureItem[]): boolean {
  return cents(incomeTotal(items)) === cents(bankedTotal(items) + expensesTotal(items));
}

/** Governance: monthly expenses over the threshold require Elder approval (Req 1.15). */
export function monthlyExpensesExceedThreshold(items: CaptureItem[], threshold = 500): boolean {
  return expensesTotal(items) > threshold;
}

/**
 * Cash-proof invariant (Req 1.5, 1.8): a Cash item carries no item_count and no proof.
 * Returns the item with those fields nulled when the type is Cash; otherwise unchanged.
 */
export function applyCashRule(item: CaptureItem): CaptureItem {
  if (item.item_type === "Cash") {
    return { ...item, item_count: null, proof_status: null };
  }
  return item;
}

/** Predicate form of the invariant, for validation/tests. */
export function cashProofInvariantHolds(item: CaptureItem): boolean {
  if (item.item_type !== "Cash") return true;
  return item.item_count === null && item.proof_status === null;
}
