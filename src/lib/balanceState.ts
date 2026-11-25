// Display-only helper. Does NOT alter isBalanced or any submission logic.
import { incomeTotal, bankedTotal, expensesTotal, bankingView, type CaptureItem } from "@/lib/captureTotals";

const cents = (n: number): number => Math.round(n * 100);

/**
 * True when the period is out of balance only because cash is not yet marked banked:
 * the shortfall (income - banked - expenses) is positive and equals the pending cash.
 * Any other imbalance (e.g. an unnetted expense, over-banking) stays a real imbalance.
 */
export function isAwaitingBankingOnly(items: CaptureItem[]): boolean {
  const shortfall = cents(incomeTotal(items)) - cents(bankedTotal(items)) - cents(expensesTotal(items));
  const pending = cents(bankingView(items).cashPending);
  return shortfall > 0 && shortfall === pending;
}
