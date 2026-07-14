"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { getUserAccess, hasPermission, logAuditAction } from "@/lib/permissions";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Role, UserHierarchyAccess } from "@/lib/types";

interface PendingMonth {
  congregation_id: string;
  congregation_name: string;
  congregation_code: string;
  year: number;
  month: number;
  service_count: number;
  total_income: number;
  total_expenses: number;
}

export default function OverseerReviewPage() {
  const supabase = createClient();

  const [access, setAccess] = useState<UserHierarchyAccess | null>(null);
  const [pendingMonths, setPendingMonths] = useState<PendingMonth[]>([]);
  const [selectedMonth, setSelectedMonth] = useState<PendingMonth | null>(null);
  const [comment, setComment] = useState("");
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const role = access?.role as Role | undefined;

  useEffect(() => {
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadData() {
    setLoading(true);
    setError(null);
    setSuccess(null);

    const userAccess = await getUserAccess();
    if (!userAccess) { setLoading(false); return; }
    setAccess(userAccess);

    // Fetch months with SubmittedToOverseer services (grouped)
    const { data: services } = await supabase
      .from("cashbook_service")
      .select("congregation_id, year, month")
      .eq("status", "SubmittedToOverseer");

    if (!services || services.length === 0) {
      setPendingMonths([]);
      setLoading(false);
      return;
    }

    // Group by congregation + year + month
    const grouped = new Map<string, { congregation_id: string; year: number; month: number; count: number }>();
    for (const s of services) {
      const key = `${s.congregation_id}_${s.year}_${s.month}`;
      const existing = grouped.get(key);
      if (existing) {
        existing.count++;
      } else {
        grouped.set(key, { congregation_id: s.congregation_id, year: s.year, month: s.month, count: 1 });
      }
    }

    // Fetch congregation names
    const congIds = Array.from(new Set(Array.from(grouped.values()).map((g) => g.congregation_id)));
    const { data: congregations } = await supabase
      .from("congregations")
      .select("id, name, code")
      .in("id", congIds);

    const congMap = new Map((congregations ?? []).map((c) => [c.id, c]));

    // Build pending months with totals from view
    const months: PendingMonth[] = [];
    for (const g of Array.from(grouped.values())) {
      const cong = congMap.get(g.congregation_id);
      const { data: monthView } = await supabase
        .from("v_cashbook_month")
        .select("month_income, month_expenses")
        .eq("congregation_id", g.congregation_id)
        .eq("year", g.year)
        .eq("month", g.month)
        .single();

      months.push({
        congregation_id: g.congregation_id,
        congregation_name: cong?.name ?? "Unknown",
        congregation_code: cong?.code ?? "",
        year: g.year,
        month: g.month,
        service_count: g.count,
        total_income: monthView?.month_income ?? 0,
        total_expenses: monthView?.month_expenses ?? 0,
      });
    }

    setPendingMonths(months);
    setLoading(false);
  }

  // ── Approve Month ─────────────────────────────────────────────────────────
  async function handleApprove(pm: PendingMonth) {
    if (!access || !role) return;
    if (!hasPermission(role, "month.overseer_approve")) return;

    setProcessing(true);
    setError(null);
    setSuccess(null);

    // Update all SubmittedToOverseer services → OverseerApproved
    const { error: updateError } = await supabase
      .from("cashbook_service")
      .update({ status: "OverseerApproved" })
      .eq("congregation_id", pm.congregation_id)
      .eq("year", pm.year)
      .eq("month", pm.month)
      .eq("status", "SubmittedToOverseer");

    if (updateError) {
      setError(updateError.message);
      setProcessing(false);
      return;
    }

    // Audit log
    await logAuditAction({
      userId: access.user_id,
      actionType: "OVERSEER_APPROVE",
      entityType: "monthly_close",
      entityId: `${pm.congregation_id}_${pm.year}_${pm.month}`,
      comment: comment || `Overseer approved ${pm.congregation_name} ${pm.year}/${String(pm.month).padStart(2, "0")}`,
      metadata: { year: pm.year, month: pm.month, congregation_id: pm.congregation_id },
    });

    // Now submit to HO (status: SubmittedToHO)
    await supabase
      .from("cashbook_service")
      .update({ status: "SubmittedToHO" })
      .eq("congregation_id", pm.congregation_id)
      .eq("year", pm.year)
      .eq("month", pm.month)
      .eq("status", "OverseerApproved");

    setProcessing(false);
    setSuccess(`${pm.congregation_name} ${pm.year}/${String(pm.month).padStart(2, "0")} approved and submitted to HO.`);
    setSelectedMonth(null);
    setComment("");
    await loadData();
  }

  // ── Reject Month ──────────────────────────────────────────────────────────
  async function handleReject(pm: PendingMonth) {
    if (!access || !role) return;
    if (!hasPermission(role, "month.overseer_reject")) return;
    if (!comment.trim()) return; // Mandatory comment

    setProcessing(true);
    setError(null);
    setSuccess(null);

    // Reject → back to AuditApproved so Elder can re-review and re-submit
    const { error: updateError } = await supabase
      .from("cashbook_service")
      .update({ status: "AuditApproved" })
      .eq("congregation_id", pm.congregation_id)
      .eq("year", pm.year)
      .eq("month", pm.month)
      .eq("status", "SubmittedToOverseer");

    if (updateError) {
      setError(updateError.message);
      setProcessing(false);
      return;
    }

    // Audit log
    await logAuditAction({
      userId: access.user_id,
      actionType: "OVERSEER_REJECT",
      entityType: "monthly_close",
      entityId: `${pm.congregation_id}_${pm.year}_${pm.month}`,
      comment: comment,
      metadata: { year: pm.year, month: pm.month, congregation_id: pm.congregation_id },
    });

    setProcessing(false);
    setSuccess(`${pm.congregation_name} ${pm.year}/${String(pm.month).padStart(2, "0")} rejected. Returned to Elder.`);
    setSelectedMonth(null);
    setComment("");
    await loadData();
  }

  // ── Render ──────────────────────────────────────────────────────────────────

  if (loading) {
    return (
      <main className="min-h-screen bg-muted/40 px-4 py-12">
        <div className="mx-auto max-w-4xl">
          <p className="text-muted-foreground">Loading review queue...</p>
        </div>
      </main>
    );
  }

  if (!role || (!hasPermission(role, "month.overseer_approve") && !hasPermission(role, "month.view"))) {
    return (
      <main className="min-h-screen bg-muted/40 px-4 py-12">
        <div className="mx-auto max-w-4xl">
          <p className="text-destructive">Access denied.</p>
        </div>
      </main>
    );
  }

  const canApprove = hasPermission(role, "month.overseer_approve");
  const canReject = hasPermission(role, "month.overseer_reject");

  return (
    <main className="min-h-screen bg-muted/40 px-4 py-6">
      <div className="mx-auto max-w-4xl space-y-6">
        {/* Header */}
        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight">Overseer Review</h1>
          <p className="text-sm text-muted-foreground">
            {pendingMonths.length} month(s) pending Overseer review
          </p>
        </div>

        {success && (
          <div className="rounded-md border border-green-300 bg-green-50 p-3">
            <p className="text-sm text-green-800">{success}</p>
          </div>
        )}
        {error && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3">
            <p className="text-sm text-destructive">{error}</p>
          </div>
        )}

        {/* Queue */}
        {pendingMonths.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-center">
              <p className="text-muted-foreground">No months pending review.</p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-4">
            {pendingMonths.map((pm) => (
              <Card key={`${pm.congregation_id}_${pm.year}_${pm.month}`}>
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base">
                      {pm.congregation_name} ({pm.congregation_code})
                    </CardTitle>
                    <span className="text-xs bg-blue-100 text-blue-800 px-2 py-1 rounded-full font-medium">
                      Pending Review
                    </span>
                  </div>
                  <CardDescription>
                    {pm.year}/{String(pm.month).padStart(2, "0")} · {pm.service_count} services
                  </CardDescription>
                </CardHeader>
                <CardContent>
                  <div className="grid gap-3 sm:grid-cols-3 mb-4">
                    <div>
                      <p className="text-xs text-muted-foreground">Total Income</p>
                      <p className="text-sm font-semibold">R{pm.total_income.toFixed(2)}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Total Expenses</p>
                      <p className="text-sm font-semibold">R{pm.total_expenses.toFixed(2)}</p>
                    </div>
                    <div>
                      <p className="text-xs text-muted-foreground">Services</p>
                      <p className="text-sm font-semibold">{pm.service_count}</p>
                    </div>
                  </div>

                  {/* Expand for action */}
                  {selectedMonth?.congregation_id === pm.congregation_id &&
                   selectedMonth?.year === pm.year &&
                   selectedMonth?.month === pm.month ? (
                    <div className="space-y-3 pt-3 border-t">
                      <div className="space-y-2">
                        <Label htmlFor={`comment-${pm.congregation_id}`}>
                          Comment {canReject ? "(mandatory for rejection)" : "(optional)"}
                        </Label>
                        <Input
                          id={`comment-${pm.congregation_id}`}
                          value={comment}
                          onChange={(e) => setComment(e.target.value)}
                          placeholder="Enter review comment..."
                        />
                      </div>
                      <div className="flex gap-3">
                        {canApprove && (
                          <Button
                            onClick={() => handleApprove(pm)}
                            disabled={processing}
                            className="bg-green-700 hover:bg-green-800"
                          >
                            {processing ? "..." : "Approve & Submit to HO"}
                          </Button>
                        )}
                        {canReject && (
                          <Button
                            variant="destructive"
                            onClick={() => handleReject(pm)}
                            disabled={processing || !comment.trim()}
                          >
                            {processing ? "..." : "Reject"}
                          </Button>
                        )}
                        <Button
                          variant="outline"
                          onClick={() => { setSelectedMonth(null); setComment(""); }}
                        >
                          Cancel
                        </Button>
                      </div>
                      {canReject && !comment.trim() && (
                        <p className="text-xs text-muted-foreground">Comment is mandatory for rejection.</p>
                      )}
                    </div>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setSelectedMonth(pm)}
                    >
                      Review
                    </Button>
                  )}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
