"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import {
  getCongregationCensusTotal,
  validateCashbookBeforeSubmit,
  checkExpenseLimit,
  submitCashbookForAudit,
  type CashbookValidationResult,
  type ExpenseLimitResult,
} from "@/lib/supabase/queries";
import { CashbookForm } from "@/components/CashbookForm";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface Period {
  id: string;
  congregation_id: string;
  year: number;
  month: number;
  week: number;
  service: string;
  status: string;
  requestor_comment?: string;
  elder_approval_comment?: string;
}

interface LineItem {
  id: string;
  period_id: string;
  section: string;
  officer_id: string;
  payment_type: "EFT" | "DirectDebit" | "Cash" | null;
  item_count: number | null;
  amount: number;
  manual_reference: string | null;
  proof_status: string | null;
}

export default function OacPeriodPage() {
  const params = useParams();
  const periodId = params.period as string;
  const supabase = createClient();

  const [period, setPeriod] = useState<Period | null>(null);
  const [lineItems, setLineItems] = useState<LineItem[]>([]);
  const [censusTotal, setCensusTotal] = useState<number>(0);
  const [validation, setValidation] = useState<CashbookValidationResult | null>(null);
  const [expenseCheck, setExpenseCheck] = useState<ExpenseLimitResult | null>(null);
  const [requestorComment, setRequestorComment] = useState("");
  const [elderComment, setElderComment] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [periodId]);

  async function loadData() {
    setLoading(true);

    // Fetch period
    const { data: periodData } = await supabase
      .from("cashbook_period")
      .select("*")
      .eq("id", periodId)
      .single();

    if (!periodData) {
      setLoading(false);
      return;
    }
    setPeriod(periodData);

    // Fetch line items
    const { data: items } = await supabase
      .from("cashbook_line_item")
      .select("*")
      .eq("period_id", periodId)
      .order("section");

    setLineItems(items ?? []);

    // Census total
    const total = await getCongregationCensusTotal(
      periodData.congregation_id,
      periodData.year,
      periodData.month
    );
    setCensusTotal(total);

    // Validation
    const val = await validateCashbookBeforeSubmit(periodId);
    setValidation(val);

    // Expense check
    const exp = await checkExpenseLimit(periodId);
    setExpenseCheck(exp);

    setLoading(false);
  }

  async function handleSubmitForAudit() {
    if (!period) return;
    setSubmitError(null);

    const result = await submitCashbookForAudit(
      periodId,
      period.congregation_id,
      period.year,
      period.month,
      expenseCheck?.requiresApproval ? requestorComment : undefined,
      expenseCheck?.requiresApproval ? elderComment : undefined
    );

    if (!result.success) {
      setSubmitError(result.error ?? "Submission failed");
      return;
    }

    // Reload data to reflect new status
    await loadData();
  }

  // Calculate section totals from line items
  const sectionTotals = lineItems.reduce(
    (acc, item) => {
      const section = item.section;
      acc[section] = (acc[section] ?? 0) + (item.amount ?? 0);
      return acc;
    },
    {} as Record<string, number>
  );

  const totalIncome =
    (sectionTotals["Members"] ?? 0) +
    (sectionTotals["Officers"] ?? 0) +
    (sectionTotals["Burial"] ?? 0);
  const totalDeductions = sectionTotals["Expenses"] ?? 0;
  const banked = totalIncome - totalDeductions;

  const canSubmit =
    validation?.isBalanced &&
    period?.status === "Draft" &&
    (!expenseCheck?.requiresApproval ||
      (requestorComment.trim().length > 0 && elderComment.trim().length > 0));

  if (loading) {
    return (
      <main className="min-h-screen bg-muted/40 px-4 py-12">
        <div className="mx-auto max-w-5xl">
          <p className="text-muted-foreground">Loading cashbook...</p>
        </div>
      </main>
    );
  }

  if (!period) {
    return (
      <main className="min-h-screen bg-muted/40 px-4 py-12">
        <div className="mx-auto max-w-5xl">
          <p className="text-destructive">Period not found.</p>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-muted/40 px-4 py-8">
      <div className="mx-auto max-w-5xl space-y-6">
        {/* Header */}
        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight">
            OAC Cashbook - {period.year}/{String(period.month).padStart(2, "0")} Week {period.week} ({period.service})
          </h1>
          <p className="text-sm text-muted-foreground">
            Status: <span className="font-medium">{period.status}</span>
          </p>
        </div>

        {/* Validation Banner */}
        {validation && (
          <div
            className={`rounded-md border p-4 ${
              validation.isBalanced
                ? "border-green-300 bg-green-50 text-green-800"
                : "border-destructive/50 bg-destructive/10 text-destructive"
            }`}
          >
            <p className="text-sm font-medium">
              {validation.isBalanced
                ? "Balanced: Ready for Audit"
                : `Not Balanced. Difference: R${Math.abs(validation.difference).toFixed(2)}`}
            </p>
          </div>
        )}

        {/* Expenses Progress Bar */}
        {expenseCheck && (
          <div className="space-y-1">
            <p className="text-sm text-muted-foreground">
              Expenses MTD: R{expenseCheck.expenseTotal.toFixed(2)} / R500
            </p>
            <div className="h-2 w-full rounded-full bg-muted">
              <div
                className={`h-2 rounded-full transition-all ${
                  expenseCheck.exceedsLimit ? "bg-destructive" : "bg-primary"
                }`}
                style={{
                  width: `${Math.min((expenseCheck.expenseTotal / 500) * 100, 100)}%`,
                }}
              />
            </div>
            {expenseCheck.exceedsLimit && (
              <p className="text-xs text-destructive">
                Expenses of R{expenseCheck.expenseTotal.toFixed(2)} exceed R500 monthly limit.
                Elder approval and reason required per HO governance.
              </p>
            )}
          </div>
        )}

        {/* Census Total Card */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Congregation Census Total</CardTitle>
            <CardDescription>Working members for this period</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold">{censusTotal}</p>
          </CardContent>
        </Card>

        {/* Totals Summary */}
        <div className="grid gap-4 sm:grid-cols-3">
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Total Income</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-xl font-semibold">R{totalIncome.toFixed(2)}</p>
              <p className="text-xs text-muted-foreground">Members + Officers + Burial</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Total Deductions</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-xl font-semibold">R{totalDeductions.toFixed(2)}</p>
              <p className="text-xs text-muted-foreground">Expenses</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardDescription>Banked</CardDescription>
            </CardHeader>
            <CardContent>
              <p className="text-xl font-semibold">R{banked.toFixed(2)}</p>
              <p className="text-xs text-muted-foreground">Income - Deductions</p>
            </CardContent>
          </Card>
        </div>

        {/* Cashbook Form */}
        <CashbookForm
          periodId={periodId}
          lineItems={lineItems}
          isLocked={period.status !== "Draft"}
          onUpdate={loadData}
        />

        {/* Elder Approval Section (when expenses > R500) */}
        {expenseCheck?.requiresApproval && period.status === "Draft" && (
          <Card className="border-orange-300">
            <CardHeader>
              <CardTitle className="text-base text-orange-700">
                Elder Approval Required
              </CardTitle>
              <CardDescription>
                Expenses exceed R500. Both comments are required before submission.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="requestor-comment">Requestor Comment (reason for expenses)</Label>
                <Input
                  id="requestor-comment"
                  value={requestorComment}
                  onChange={(e) => setRequestorComment(e.target.value)}
                  placeholder="Explain the expenses..."
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="elder-comment">Elder Approval Comment</Label>
                <Input
                  id="elder-comment"
                  value={elderComment}
                  onChange={(e) => setElderComment(e.target.value)}
                  placeholder="Elder approval reason..."
                  required
                />
              </div>
            </CardContent>
          </Card>
        )}

        {/* Submit Section */}
        {period.status === "Draft" && (
          <div className="space-y-2">
            {submitError && (
              <p className="text-sm text-destructive">{submitError}</p>
            )}
            <Button
              onClick={handleSubmitForAudit}
              disabled={!canSubmit}
              className="w-full sm:w-auto"
            >
              Submit for Audit
            </Button>
          </div>
        )}
      </div>
    </main>
  );
}
