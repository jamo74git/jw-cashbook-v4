import { createClient } from "@/lib/supabase/client";

// ─── Census Queries ─────────────────────────────────────────────────────────

/**
 * Get the total working_members for a congregation in a given year/month.
 * Used as the "Congregation Census Total" card on the cashbook page.
 */
export async function getCongregationCensusTotal(
  congregation_id: string,
  year: number,
  month: number
): Promise<number> {
  const supabase = createClient();

  const { data, error } = await supabase
    .from("priest_census")
    .select("working_members")
    .eq("congregation_id", congregation_id)
    .eq("year", year)
    .eq("month", month);

  if (error) throw new Error(error.message);

  return (data ?? []).reduce(
    (sum, row) => sum + (row.working_members ?? 0),
    0
  );
}

/**
 * Upsert a priest census row. Conflicts on (priest_id, year, month).
 * Automatically sets updated_at = now().
 */
export async function upsertPriestCensus(data: {
  congregation_id: string;
  priest_id: string;
  year: number;
  month: number;
  underdeacon_count: number;
  children_under_15: number;
  youth_under_26: number;
  youth_under_35: number;
  adults_under_60: number;
  seniors_60_plus: number;
  working_members: number;
  captured_by: string;
}) {
  const supabase = createClient();

  const { data: result, error } = await supabase
    .from("priest_census")
    .upsert(
      {
        ...data,
        captured_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      },
      { onConflict: "priest_id,year,month" }
    )
    .select()
    .single();

  if (error) throw new Error(error.message);
  return result;
}

/**
 * Lock all census rows for a congregation/year/month when cashbook is approved.
 */
export async function lockCensusForMonth(
  congregation_id: string,
  year: number,
  month: number
) {
  const supabase = createClient();

  const { error } = await supabase
    .from("priest_census")
    .update({ locked: true })
    .eq("congregation_id", congregation_id)
    .eq("year", year)
    .eq("month", month);

  if (error) throw new Error(error.message);
}

// ─── Cashbook Validation ────────────────────────────────────────────────────

export interface CashbookValidationResult {
  totalIncome: number;
  totalDeductions: number;
  banked: number;
  difference: number;
  isBalanced: boolean;
}

/**
 * Validate that cashbook balances before submission.
 * Formula: Banked = (Members + Officers + Burial) - Expenses
 * Validation: total_income === banked + total_deductions
 */
export async function validateCashbookBeforeSubmit(
  period_id: string
): Promise<CashbookValidationResult> {
  const supabase = createClient();

  const { data: items, error } = await supabase
    .from("cashbook_line_item")
    .select("section, amount")
    .eq("period_id", period_id);

  if (error) throw new Error(error.message);

  const rows = items ?? [];

  const totalIncome = rows
    .filter((r) => ["Members", "Officers", "Burial"].includes(r.section))
    .reduce((sum, r) => sum + (r.amount ?? 0), 0);

  const totalDeductions = rows
    .filter((r) => r.section === "Expenses")
    .reduce((sum, r) => sum + (r.amount ?? 0), 0);

  const banked = totalIncome - totalDeductions;
  const difference = totalIncome - (banked + totalDeductions);

  return {
    totalIncome,
    totalDeductions,
    banked,
    difference,
    isBalanced: difference === 0,
  };
}

// ─── Expense Governance (R500 limit) ────────────────────────────────────────

export interface ExpenseLimitResult {
  expenseTotal: number;
  exceedsLimit: boolean;
  requiresApproval: boolean;
}

/**
 * Check whether expenses for a period exceed R500 monthly limit.
 * If so, elder approval + requestor comment required before audit submission.
 */
export async function checkExpenseLimit(
  period_id: string
): Promise<ExpenseLimitResult> {
  const supabase = createClient();

  const { data: items, error } = await supabase
    .from("cashbook_line_item")
    .select("amount")
    .eq("period_id", period_id)
    .eq("section", "Expenses");

  if (error) throw new Error(error.message);

  const expenseTotal = (items ?? []).reduce(
    (sum, r) => sum + (r.amount ?? 0),
    0
  );

  // Update the period record with the calculated expenses total
  await supabase
    .from("cashbook_period")
    .update({ expenses_total: expenseTotal })
    .eq("id", period_id);

  const exceedsLimit = expenseTotal > 500;

  return {
    expenseTotal,
    exceedsLimit,
    requiresApproval: exceedsLimit,
  };
}

/**
 * Submit cashbook for audit. Validates balance and expense limit first.
 * Also locks census for the congregation/year/month.
 */
export async function submitCashbookForAudit(
  period_id: string,
  congregation_id: string,
  year: number,
  month: number,
  requestor_comment?: string,
  elder_approval_comment?: string
): Promise<{ success: boolean; error?: string }> {
  // 1. Validate balance
  const validation = await validateCashbookBeforeSubmit(period_id);
  if (!validation.isBalanced) {
    return {
      success: false,
      error: `Cannot submit for audit. Cashbook does not balance. Difference: R${Math.abs(validation.difference).toFixed(2)}`,
    };
  }

  // 2. Check expense limit
  const expenseCheck = await checkExpenseLimit(period_id);
  if (expenseCheck.requiresApproval) {
    if (!requestor_comment || !elder_approval_comment) {
      return {
        success: false,
        error: `Expenses of R${expenseCheck.expenseTotal.toFixed(2)} exceed R500 monthly limit. Elder approval and reason required per HO governance.`,
      };
    }
  }

  // 3. Lock census
  await lockCensusForMonth(congregation_id, year, month);

  // 4. Update status
  const supabase = createClient();
  const updateData: Record<string, unknown> = { status: "AuditSubmitted" };
  if (requestor_comment) updateData.requestor_comment = requestor_comment;
  if (elder_approval_comment) updateData.elder_approval_comment = elder_approval_comment;

  const { error } = await supabase
    .from("cashbook_period")
    .update(updateData)
    .eq("id", period_id);

  if (error) return { success: false, error: error.message };

  return { success: true };
}
