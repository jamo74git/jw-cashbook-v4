"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import {
  getUserAccess,
  hasPermission,
  isOverrideAction,
  logSelfReviewException,
  logAuditAction,
} from "@/lib/permissions";
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
import type { Role, UserHierarchyAccess, CashbookLineItem } from "@/lib/types";

interface ServiceData {
  id: string;
  congregation_id: string;
  year: number;
  month: number;
  week: number;
  service_type: string;
  service_date: string;
  status: string;
  submitted_at: string | null;
  expenses_total: number;
  requestor_comment: string | null;
  elder_approval_comment: string | null;
}

interface BankingRow {
  id: string;
  payment_date: string;
  payment_type: string;
  amount: number;
  proof_status: string;
  proof_image_url: string | null;
}

export default function AuditReviewPage() {
  const params = useParams();
  const router = useRouter();
  const serviceId = params.service_id as string;
  const supabase = createClient();

  const [access, setAccess] = useState<UserHierarchyAccess | null>(null);
  const [service, setService] = useState<ServiceData | null>(null);
  const [lineItems, setLineItems] = useState<CashbookLineItem[]>([]);
  const [banking, setBanking] = useState<BankingRow[]>([]);
  const [comment, setComment] = useState("");
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const role = access?.role as Role | undefined;

  const loadData = useCallback(async () => {
    setLoading(true);
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

    // Fetch line items (read-only view for auditor)
    const { data: items } = await supabase
      .from("cashbook_line_item")
      .select("*")
      .eq("service_id", serviceId)
      .order("section");
    setLineItems((items as CashbookLineItem[]) ?? []);

    // Fetch banking
    const { data: bankingData } = await supabase
      .from("banking")
      .select("*")
      .eq("service_id", serviceId)
      .order("payment_date");
    setBanking(bankingData ?? []);

    setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serviceId]);

  useEffect(() => { loadData(); }, [loadData]);

  // ── Approve Handler ─────────────────────────────────────────────────────
  async function handleApprove() {
    if (!role || !access || !service) return;
    if (!hasPermission(role, "audit.approve")) return;

    // Chairperson override confirmation
    if (isOverrideAction(role, "audit.approve")) {
      const confirmed = window.confirm(
        "You are approving as Auditor. This will be logged as SELF_REVIEW_EXCEPTION. Continue?"
      );
      if (!confirmed) return;
    }

    setProcessing(true);
    setError(null);

    // Log override for Chairperson
    if (isOverrideAction(role, "audit.approve")) {
      await logSelfReviewException({
        userId: access.user_id,
        entityType: "cashbook_service",
        entityId: serviceId,
        assumedRole: "Auditor",
        comment: `${role} approved audit (SELF_REVIEW_EXCEPTION)`,
      });
    }

    // Update status
    const { error: updateError } = await supabase
      .from("cashbook_service")
      .update({ status: "AuditApproved" })
      .eq("id", serviceId);

    if (updateError) {
      setError(updateError.message);
      setProcessing(false);
      return;
    }

    // Audit log
    await logAuditAction({
      userId: access.user_id,
      actionType: "AUDIT_APPROVE",
      entityType: "cashbook_service",
      entityId: serviceId,
      assumedRole: isOverrideAction(role, "audit.approve") ? "Auditor" : undefined,
      comment: comment || "Approved",
    });

    setProcessing(false);
    router.push("/audit");
  }

  // ── Reject Handler ──────────────────────────────────────────────────────
  async function handleReject() {
    if (!role || !access || !service) return;
    if (!hasPermission(role, "audit.reject")) return;
    if (!comment.trim()) return; // Mandatory comment

    // Chairperson override confirmation
    if (isOverrideAction(role, "audit.reject")) {
      const confirmed = window.confirm(
        "You are rejecting as Auditor. This will be logged as SELF_REVIEW_EXCEPTION. Continue?"
      );
      if (!confirmed) return;
    }

    setProcessing(true);
    setError(null);

    // Log override for Chairperson
    if (isOverrideAction(role, "audit.reject")) {
      await logSelfReviewException({
        userId: access.user_id,
        entityType: "cashbook_service",
        entityId: serviceId,
        assumedRole: "Auditor",
        comment: `${role} rejected audit (SELF_REVIEW_EXCEPTION): ${comment}`,
      });
    }

    // Update status back to Draft (rejected)
    const { error: updateError } = await supabase
      .from("cashbook_service")
      .update({ status: "AuditRejected" })
      .eq("id", serviceId);

    if (updateError) {
      setError(updateError.message);
      setProcessing(false);
      return;
    }

    // Audit log
    await logAuditAction({
      userId: access.user_id,
      actionType: "AUDIT_REJECT",
      entityType: "cashbook_service",
      entityId: serviceId,
      assumedRole: isOverrideAction(role, "audit.reject") ? "Auditor" : undefined,
      comment: comment,
    });

    setProcessing(false);
    router.push("/audit");
  }

  // ── Totals Calculation ──────────────────────────────────────────────────
  const membersTotal = lineItems.filter((i) => i.section === "Members").reduce((s, i) => s + (i.amount ?? 0), 0);
  const officersTotal = lineItems.filter((i) => i.section === "Officers").reduce((s, i) => s + (i.amount ?? 0), 0);
  const burialTotal = lineItems.filter((i) => i.section === "Burial").reduce((s, i) => s + (i.amount ?? 0), 0);
  const expensesTotal = lineItems.filter((i) => i.section === "Expenses").reduce((s, i) => s + (i.amount ?? 0), 0);
  const totalIncome = membersTotal + officersTotal + burialTotal;
  const bankingTotalCalc = banking.reduce((s, b) => s + (b.amount ?? 0), 0);
  const isBalanced = Math.abs(totalIncome - (bankingTotalCalc + expensesTotal)) < 0.01;

  const canApprove = role ? hasPermission(role, "audit.approve") : false;
  const canReject = role ? hasPermission(role, "audit.reject") : false;
  const isPendingAudit = service?.status === "PendingAudit";

  // ── Loading / Error States ──────────────────────────────────────────────
  if (loading) {
    return (
      <main className="min-h-screen bg-muted/40 px-4 py-12">
        <div className="mx-auto max-w-4xl">
          <p className="text-muted-foreground">Loading audit review...</p>
        </div>
      </main>
    );
  }

  if (!service || !access || !role) {
    return (
      <main className="min-h-screen bg-muted/40 px-4 py-12">
        <div className="mx-auto max-w-4xl">
          <p className="text-destructive">Service not found or access denied.</p>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-muted/40 px-4 py-6">
      <div className="mx-auto max-w-4xl space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <h1 className="text-xl font-bold tracking-tight sm:text-2xl">
              Audit Review — Week {service.week} {service.service_type}
            </h1>
            <p className="text-sm text-muted-foreground">
              {service.service_date} · Status: {service.status}
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={() => router.push("/audit")}>
            Back to Queue
          </Button>
        </div>

        {/* Balance Banner */}
        <div className={`rounded-md border p-4 ${
          isBalanced
            ? "border-green-300 bg-green-50 text-green-800"
            : "border-destructive/50 bg-destructive/10 text-destructive"
        }`}>
          <p className="text-sm font-medium">
            {isBalanced ? "Balanced" : "NOT BALANCED — Review Required"}
          </p>
          <p className="text-xs mt-1">
            Income: R{totalIncome.toFixed(2)} | Banking: R{bankingTotalCalc.toFixed(2)} | Expenses: R{expensesTotal.toFixed(2)}
          </p>
        </div>

        {/* Totals Summary */}
        <div className="grid gap-4 sm:grid-cols-4">
          <Card>
            <CardHeader className="pb-1"><CardDescription>Members</CardDescription></CardHeader>
            <CardContent><p className="text-lg font-semibold">R{membersTotal.toFixed(2)}</p></CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-1"><CardDescription>Officers</CardDescription></CardHeader>
            <CardContent><p className="text-lg font-semibold">R{officersTotal.toFixed(2)}</p></CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-1"><CardDescription>Burial</CardDescription></CardHeader>
            <CardContent><p className="text-lg font-semibold">R{burialTotal.toFixed(2)}</p></CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-1"><CardDescription>Expenses</CardDescription></CardHeader>
            <CardContent><p className="text-lg font-semibold">R{expensesTotal.toFixed(2)}</p></CardContent>
          </Card>
        </div>

        {/* Line Items (read-only detail) */}
        {["Members", "Officers", "Burial", "Expenses"].map((section) => {
          const sectionItems = lineItems.filter((i) => i.section === section);
          if (sectionItems.length === 0) return null;
          return (
            <Card key={section}>
              <CardHeader className="pb-2">
                <CardTitle className="text-base">{section} Tithing</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="space-y-2">
                  {sectionItems.map((item) => (
                    <div key={item.id} className="flex items-center justify-between border-b pb-2 last:border-0">
                      <div className="space-y-0.5">
                        {item.officer_code && (
                          <p className="text-sm font-medium">{item.officer_code}</p>
                        )}
                        <p className="text-xs text-muted-foreground">
                          {item.income_type ?? "N/A"}
                          {item.item_count ? ` · Count: ${item.item_count}` : ""}
                          {item.manual_reference ? ` · Ref: ${item.manual_reference}` : ""}
                        </p>
                      </div>
                      <div className="text-right space-y-0.5">
                        <p className="text-sm font-semibold">R{(item.amount ?? 0).toFixed(2)}</p>
                        {/* Proof image thumbnail */}
                        {item.proof_image_url ? (
                          <a
                            href={item.proof_image_url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-xs text-primary underline"
                          >
                            View Proof
                          </a>
                        ) : (
                          item.income_type !== "Cash" && (
                            <span className="text-xs text-destructive">No Proof</span>
                          )
                        )}
                      </div>
                    </div>
                  ))}
                  <div className="pt-2 flex justify-between text-sm font-medium">
                    <span>Total:</span>
                    <span>R{sectionItems.reduce((s, i) => s + (i.amount ?? 0), 0).toFixed(2)}</span>
                  </div>
                </div>
              </CardContent>
            </Card>
          );
        })}

        {/* Banking Detail */}
        {banking.length > 0 && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Banking</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {banking.map((b) => (
                  <div key={b.id} className="flex items-center justify-between border-b pb-2 last:border-0">
                    <div>
                      <p className="text-sm">{b.payment_date} · {b.payment_type}</p>
                      <p className="text-xs text-muted-foreground">{b.proof_status}</p>
                    </div>
                    <div className="text-right space-y-0.5">
                      <p className="text-sm font-semibold">R{b.amount.toFixed(2)}</p>
                      {b.proof_image_url && (
                        <a href={b.proof_image_url} target="_blank" rel="noopener noreferrer" className="text-xs text-primary underline">
                          View Proof
                        </a>
                      )}
                    </div>
                  </div>
                ))}
                <div className="pt-2 flex justify-between text-sm font-medium">
                  <span>Banking Total:</span>
                  <span>R{bankingTotalCalc.toFixed(2)}</span>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Expense Governance Info */}
        {service.expenses_total > 500 && (
          <Card className="border-orange-300">
            <CardHeader className="pb-2">
              <CardTitle className="text-base text-orange-700">Expense Governance (R500 Exceeded)</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2">
              <p className="text-sm"><span className="font-medium">Requestor:</span> {service.requestor_comment ?? "—"}</p>
              <p className="text-sm"><span className="font-medium">Elder Approval:</span> {service.elder_approval_comment ?? "—"}</p>
            </CardContent>
          </Card>
        )}

        {/* Approve / Reject Section */}
        {isPendingAudit && (canApprove || canReject) && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">Audit Decision</CardTitle>
              <CardDescription>
                Review all line items, proof images, and banking above. Then approve or reject.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="audit-comment">
                  Comment {canReject ? "(mandatory for rejection)" : "(optional for approval)"}
                </Label>
                <Input
                  id="audit-comment"
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  placeholder="Enter audit comment..."
                />
              </div>

              {error && (
                <p className="text-sm text-destructive">{error}</p>
              )}

              <div className="flex gap-3">
                {canApprove && (
                  <Button
                    onClick={handleApprove}
                    disabled={processing}
                    className="bg-green-700 hover:bg-green-800"
                  >
                    {processing ? "Processing..." : "Approve"}
                  </Button>
                )}
                {canReject && (
                  <Button
                    variant="destructive"
                    onClick={handleReject}
                    disabled={processing || !comment.trim()}
                  >
                    {processing ? "Processing..." : "Reject"}
                  </Button>
                )}
              </div>

              {canReject && !comment.trim() && (
                <p className="text-xs text-muted-foreground">
                  A comment is mandatory before you can reject.
                </p>
              )}
            </CardContent>
          </Card>
        )}

        {/* Already processed */}
        {!isPendingAudit && (
          <Card>
            <CardContent className="py-6 text-center">
              <p className="text-muted-foreground">
                This service has already been processed. Status: <span className="font-medium">{service.status}</span>
              </p>
            </CardContent>
          </Card>
        )}
      </div>
    </main>
  );
}
