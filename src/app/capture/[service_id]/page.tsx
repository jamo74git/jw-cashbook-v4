"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import {
  getUserAccess,
  hasPermission,
  isTotalsOnly,
  isOverrideAction,
  logSelfReviewException,
  logAuditAction,
} from "@/lib/permissions";
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
import type {
  Role,
  UserHierarchyAccess,
  CashbookService,
  CashbookLineItem,
  Officer,
} from "@/lib/types";

// ─── Sequential Lock Check ──────────────────────────────────────────────────

async function checkPreviousWeekApproved(
  congregationId: string,
  year: number,
  month: number,
  week: number,
  serviceType: string
): Promise<{ locked: boolean; reason: string | null }> {
  if (week <= 1) return { locked: false, reason: null };

  const supabase = createClient();
  const { data: prevWeek } = await supabase
    .from("cashbook_service")
    .select("status")
    .eq("congregation_id", congregationId)
    .eq("year", year)
    .eq("month", month)
    .eq("week", week - 1)
    .eq("service_type", serviceType)
    .single();

  if (!prevWeek) {
    return { locked: true, reason: `Week ${week - 1} (${serviceType}) has not been captured yet.` };
  }

  if (prevWeek.status !== "AuditApproved" && prevWeek.status !== "SubmittedToOverseer" &&
      prevWeek.status !== "OverseerApproved" && prevWeek.status !== "SubmittedToHO" &&
      prevWeek.status !== "HOReviewed") {
    return {
      locked: true,
      reason: `Week ${week - 1} (${serviceType}) must be Audit Approved before Week ${week} can be captured. Current status: ${prevWeek.status}`,
    };
  }

  return { locked: false, reason: null };
}

// ─── Balance Validation ─────────────────────────────────────────────────────

interface BalanceResult {
  totalIncome: number;
  membersTotal: number;
  officersTotal: number;
  burialTotal: number;
  expensesTotal: number;
  bankingTotal: number;
  isBalanced: boolean;
  difference: number;
}

function calculateBalance(lineItems: CashbookLineItem[], bankingTotal: number): BalanceResult {
  const membersTotal = lineItems
    .filter((i) => i.section === "Members")
    .reduce((s, i) => s + (i.amount ?? 0), 0);
  const officersTotal = lineItems
    .filter((i) => i.section === "Officers")
    .reduce((s, i) => s + (i.amount ?? 0), 0);
  const burialTotal = lineItems
    .filter((i) => i.section === "Burial")
    .reduce((s, i) => s + (i.amount ?? 0), 0);
  const expensesTotal = lineItems
    .filter((i) => i.section === "Expenses")
    .reduce((s, i) => s + (i.amount ?? 0), 0);

  const totalIncome = membersTotal + officersTotal + burialTotal;
  // Balance rule: Income = Banking + Expenses
  const difference = totalIncome - (bankingTotal + expensesTotal);

  return {
    totalIncome,
    membersTotal,
    officersTotal,
    burialTotal,
    expensesTotal,
    bankingTotal,
    isBalanced: Math.abs(difference) < 0.01,
    difference,
  };
}

// ─── Main Page Component ────────────────────────────────────────────────────

export default function CaptureServicePage() {
  const params = useParams();
  const serviceId = params.service_id as string;
  const supabase = createClient();

  const [access, setAccess] = useState<UserHierarchyAccess | null>(null);
  const [service, setService] = useState<CashbookService | null>(null);
  const [lineItems, setLineItems] = useState<CashbookLineItem[]>([]);
  const [officers, setOfficers] = useState<Officer[]>([]);
  const [bankingTotal, setBankingTotal] = useState(0);
  const [balance, setBalance] = useState<BalanceResult | null>(null);
  const [seqLock, setSeqLock] = useState<{ locked: boolean; reason: string | null }>({ locked: false, reason: null });
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [expenseComment, setExpenseComment] = useState("");
  const [elderComment, setElderComment] = useState("");

  const role = access?.role as Role | undefined;

  const loadData = useCallback(async () => {
    setLoading(true);

    // Get user access
    const userAccess = await getUserAccess();
    if (!userAccess) { setLoading(false); return; }
    setAccess(userAccess);

    // Fetch service
    const { data: svc } = await supabase
      .from("cashbook_service")
      .select("*")
      .eq("id", serviceId)
      .single();

    if (!svc) { setLoading(false); return; }
    setService(svc);

    // Sequential lock check
    const lockStatus = await checkPreviousWeekApproved(
      svc.congregation_id, svc.year, svc.month, svc.week, svc.service_type
    );
    setSeqLock(lockStatus);

    // Fetch line items
    const { data: items } = await supabase
      .from("cashbook_line_item")
      .select("*")
      .eq("service_id", serviceId)
      .order("section");
    setLineItems((items as CashbookLineItem[]) ?? []);

    // Fetch banking total
    const { data: banking } = await supabase
      .from("banking")
      .select("amount")
      .eq("service_id", serviceId);
    const bTotal = (banking ?? []).reduce((s, b) => s + (b.amount ?? 0), 0);
    setBankingTotal(bTotal);

    // Calculate balance
    setBalance(calculateBalance((items as CashbookLineItem[]) ?? [], bTotal));

    // Fetch officers for this congregation
    const { data: officerData } = await supabase
      .from("officers")
      .select("*")
      .eq("congregation_id", svc.congregation_id)
      .eq("is_active", true)
      .order("officer_code");
    setOfficers((officerData as Officer[]) ?? []);

    setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serviceId]);

  useEffect(() => { loadData(); }, [loadData]);

  // Recalculate balance when lineItems change
  useEffect(() => {
    setBalance(calculateBalance(lineItems, bankingTotal));
  }, [lineItems, bankingTotal]);

  // ── Submit for Audit ────────────────────────────────────────────────────
  async function handleSubmitForAudit() {
    if (!service || !role || !access) return;

    // Permission check
    if (!hasPermission(role, "capture.submit")) {
      setSubmitError("You do not have permission to submit.");
      return;
    }

    // Balance check
    if (!balance?.isBalanced) {
      setSubmitError(
        `Cannot submit. Income (R${balance?.totalIncome.toFixed(2)}) must equal Banking (R${balance?.bankingTotal.toFixed(2)}) + Expenses (R${balance?.expensesTotal.toFixed(2)}). Difference: R${Math.abs(balance?.difference ?? 0).toFixed(2)}`
      );
      return;
    }

    // Proof check: all EFT/DirectDebit lines must have proof uploaded
    const missingProof = lineItems.filter(
      (i) => i.income_type !== "Cash" && i.section !== "Expenses" && !i.proof_image_url
    );
    if (missingProof.length > 0) {
      setSubmitError(`${missingProof.length} line(s) with EFT/DirectDebit require proof photo upload before submission.`);
      return;
    }

    // Expense > R500 check
    const expTotal = lineItems
      .filter((i) => i.section === "Expenses")
      .reduce((s, i) => s + (i.amount ?? 0), 0);
    if (expTotal > 500) {
      if (!expenseComment.trim() || !elderComment.trim()) {
        setSubmitError("Expenses exceed R500. Both requestor comment and Elder approval comment are required.");
        return;
      }
    }

    setSubmitting(true);
    setSubmitError(null);

    // Chairperson override confirmation modal
    if (role === "Chairperson" && isOverrideAction(role, "capture.submit")) {
      const confirmed = window.confirm(
        "You are submitting as Treasurer. This will be logged as SELF_REVIEW_EXCEPTION. Continue?"
      );
      if (!confirmed) {
        setSubmitting(false);
        return;
      }
    }

    // Log override if Chair/Elder is submitting
    if (isOverrideAction(role, "capture.submit")) {
      await logSelfReviewException({
        userId: access.user_id,
        entityType: "cashbook_service",
        entityId: serviceId,
        assumedRole: "Treasurer",
        comment: `${role} submitted service for audit (override)`,
      });
    }

    // Update status
    const updateData: Record<string, unknown> = {
      status: "PendingAudit",
      submitted_at: new Date().toISOString(),
      expenses_total: expTotal,
    };
    if (expTotal > 500) {
      updateData.requestor_comment = expenseComment;
      updateData.elder_approval_comment = elderComment;
    }

    const { error } = await supabase
      .from("cashbook_service")
      .update(updateData)
      .eq("id", serviceId);

    if (error) {
      setSubmitError(error.message);
      setSubmitting(false);
      return;
    }

    // Audit log
    await logAuditAction({
      userId: access.user_id,
      actionType: "SUBMIT",
      entityType: "cashbook_service",
      entityId: serviceId,
      comment: "Service submitted for audit",
    });

    setSubmitting(false);
    await loadData();
  }

  // ── Render ──────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <main className="min-h-screen bg-muted/40 px-4 py-12">
        <div className="mx-auto max-w-5xl">
          <p className="text-muted-foreground">Loading service...</p>
        </div>
      </main>
    );
  }

  if (!service || !access || !role) {
    return (
      <main className="min-h-screen bg-muted/40 px-4 py-12">
        <div className="mx-auto max-w-5xl">
          <p className="text-destructive">Service not found or access denied.</p>
        </div>
      </main>
    );
  }

  const isDraft = service.status === "Draft";
  const canEdit = isDraft && !seqLock.locked && hasPermission(role, "capture.edit");
  const canSubmit = isDraft && !seqLock.locked && hasPermission(role, "capture.submit");
  const viewOnly = isTotalsOnly(role, "capture.view");

  return (
    <main className="min-h-screen bg-muted/40 px-4 py-6">
      <div className="mx-auto max-w-5xl space-y-6">
        {/* Header */}
        <div className="space-y-1">
          <h1 className="text-xl font-bold tracking-tight sm:text-2xl">
            Capture — {service.service_date} {service.service_type} (Week {service.week})
          </h1>
          <p className="text-sm text-muted-foreground">
            Status: <span className="font-medium">{service.status}</span>
            {" · "}Role: <span className="font-medium">{role}</span>
          </p>
        </div>

        {/* Sequential Lock Banner */}
        {seqLock.locked && (
          <div className="rounded-md border border-orange-300 bg-orange-50 p-4">
            <p className="text-sm text-orange-800 font-medium">Sequential Lock Active</p>
            <p className="text-sm text-orange-700">{seqLock.reason}</p>
          </div>
        )}

        {/* Balance Banner */}
        {balance && !viewOnly && (
          <div
            className={`rounded-md border p-4 ${
              balance.isBalanced
                ? "border-green-300 bg-green-50 text-green-800"
                : "border-destructive/50 bg-destructive/10 text-destructive"
            }`}
          >
            <p className="text-sm font-medium">
              {balance.isBalanced
                ? "Balanced: Income = Banking + Expenses"
                : `Not Balanced. Difference: R${Math.abs(balance.difference).toFixed(2)}`}
            </p>
            <p className="text-xs mt-1 opacity-80">
              Income: R{balance.totalIncome.toFixed(2)} | Banking: R{balance.bankingTotal.toFixed(2)} | Expenses: R{balance.expensesTotal.toFixed(2)}
            </p>
          </div>
        )}

        {/* Secretary Totals Only View */}
        {viewOnly && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Service Totals</CardTitle>
              <CardDescription>You have view-totals-only access.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <div>
                  <p className="text-xs text-muted-foreground">Members</p>
                  <p className="text-lg font-semibold">R{balance?.membersTotal.toFixed(2)}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Officers</p>
                  <p className="text-lg font-semibold">R{balance?.officersTotal.toFixed(2)}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Burial</p>
                  <p className="text-lg font-semibold">R{balance?.burialTotal.toFixed(2)}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground">Expenses</p>
                  <p className="text-lg font-semibold">R{balance?.expensesTotal.toFixed(2)}</p>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Expenses Progress Bar (R500 governance) */}
        {!viewOnly && balance && (
          <div className="space-y-1">
            <p className="text-sm text-muted-foreground">
              Expenses MTD: R{balance.expensesTotal.toFixed(2)} / R500
            </p>
            <div className="h-2 w-full rounded-full bg-muted">
              <div
                className={`h-2 rounded-full transition-all ${
                  balance.expensesTotal > 500 ? "bg-destructive" : "bg-primary"
                }`}
                style={{ width: `${Math.min((balance.expensesTotal / 500) * 100, 100)}%` }}
              />
            </div>
            {balance.expensesTotal > 500 && (
              <p className="text-xs text-destructive">
                Expenses exceed R500 monthly limit. Elder approval required per HO governance.
              </p>
            )}
          </div>
        )}

        {/* Cashbook Form (full detail) — hidden from Secretary */}
        {!viewOnly && (
          <CashbookForm
            serviceId={serviceId}
            lineItems={lineItems}
            officers={officers}
            isLocked={!canEdit}
            role={role}
            onUpdate={loadData}
          />
        )}

        {/* Elder Approval Section (expenses > R500) */}
        {!viewOnly && balance && balance.expensesTotal > 500 && canSubmit && (
          <Card className="border-orange-300">
            <CardHeader>
              <CardTitle className="text-base text-orange-700">
                Elder Approval Required (Expenses &gt; R500)
              </CardTitle>
              <CardDescription>
                Both comments are required before submission per HO governance.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="expense-comment">Requestor Comment</Label>
                <Input
                  id="expense-comment"
                  value={expenseComment}
                  onChange={(e) => setExpenseComment(e.target.value)}
                  placeholder="Reason for expenses exceeding R500..."
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="elder-comment">Elder Approval Comment</Label>
                <Input
                  id="elder-comment"
                  value={elderComment}
                  onChange={(e) => setElderComment(e.target.value)}
                  placeholder="Elder approval reason..."
                />
              </div>
            </CardContent>
          </Card>
        )}

        {/* Submit Button */}
        {canSubmit && !viewOnly && (
          <div className="space-y-2">
            {submitError && (
              <p className="text-sm text-destructive">{submitError}</p>
            )}
            <Button
              onClick={handleSubmitForAudit}
              disabled={submitting || !balance?.isBalanced}
              className="w-full sm:w-auto"
            >
              {submitting ? "Submitting..." : "Submit Service for Audit"}
            </Button>
          </div>
        )}
      </div>
    </main>
  );
}
