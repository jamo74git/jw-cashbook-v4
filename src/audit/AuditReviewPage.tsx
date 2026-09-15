// ─────────────────────────────────────────────────────────────────────────────
// AUDITOR DETAIL REVIEW (online-only). Sectioned review of a submitted period with
// proof viewers, a 4-section verification hard-gate, and approve/reject writes that
// use an optimistic status="Submitted" row-lock. Supabase Realtime watches the period
// for external status changes. Reuses captureTotals for all math.
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import { createClient } from "@/lib/supabase/client";
import {
  getUserAccess,
  hasPermission,
  isOverrideAction,
  logSelfReviewException,
  logAuditAction,
} from "@/lib/permissions";
import {
  bankingView,
  sectionTotals,
  incomeTotal,
  expensesTotal,
  type CaptureItem,
  type ItemType,
} from "@/lib/captureTotals";
import { useOnlineStatus } from "@/lib/useOnlineStatus";
import { ProofLink } from "@/audit/ProofLink";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import type { Role, UserHierarchyAccess, LineSection } from "@/lib/types";

interface Period {
  id: string;
  congregation_id: string;
  year: number;
  month: number;
  week: number;
  service: string;
  status: string;
  week_key: string | null;
  submitted_at: string | null;
}
interface LineItem {
  id: string;
  period_id: string;
  section: string;
  officer_id: string | null;
  item_type: string;
  amount: number;
  is_officer: boolean;
  receipt_number: string | null;
  manual_reference: string | null;
  transaction_date: string | null;
}
interface Attachment {
  id: string;
  line_item_id: string;
  file_url: string;
  transaction_date: string | null;
  bank_reference: string | null;
}
interface Officer {
  id: string;
  officer_code: string;
}

const money = (n: number) => `R${n.toFixed(2)}`;
const OFFLINE_MSG = "Offline Unavailable — Please connect to a stable network to audit submissions.";

export function AuditReviewPage() {
  const { periodId } = useParams();
  const navigate = useNavigate();
  const supabase = createClient();
  const online = useOnlineStatus();

  const [access, setAccess] = useState<UserHierarchyAccess | null>(null);
  const [period, setPeriod] = useState<Period | null>(null);
  const [items, setItems] = useState<LineItem[]>([]);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [officers, setOfficers] = useState<Officer[]>([]);
  const [loading, setLoading] = useState(true);
  const [comment, setComment] = useState("");
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [externallyChanged, setExternallyChanged] = useState(false);

  const [checkedBanking, setCheckedBanking] = useState(false);
  const [checkedCash, setCheckedCash] = useState(false);
  const [checkedBurial, setCheckedBurial] = useState(false);
  const [checkedExpenses, setCheckedExpenses] = useState(false);
  const allChecked = checkedBanking && checkedCash && checkedBurial && checkedExpenses;

  const role = access?.role as Role | undefined;
  const canApprove = role ? hasPermission(role, "audit.approve") : false;
  const canReject = role ? hasPermission(role, "audit.reject") : false;

  const load = useCallback(async () => {
    if (!periodId) return;
    setLoading(true);
    const ua = await getUserAccess();
    if (!ua) {
      setLoading(false);
      return;
    }
    setAccess(ua);
    const { data: p } = await supabase.from("cashbook_period").select("*").eq("id", periodId).single();
    if (!p) {
      setLoading(false);
      return;
    }
    setPeriod(p as Period);
    const [li, att, off] = await Promise.all([
      supabase
        .from("cashbook_line_item")
        .select("id, period_id, section, officer_id, item_type, amount, is_officer, receipt_number, manual_reference, transaction_date")
        .eq("period_id", periodId),
      supabase.from("cashbook_attachment").select("id, line_item_id, file_url, transaction_date, bank_reference"),
      supabase.from("officers").select("id, officer_code").eq("congregation_id", (p as Period).congregation_id).eq("is_active", true),
    ]);
    const lineItems = (li.data ?? []) as LineItem[];
    setItems(lineItems);
    const ids = new Set(lineItems.map((i) => i.id));
    setAttachments(((att.data ?? []) as Attachment[]).filter((a) => ids.has(a.line_item_id)));
    setOfficers((off.data ?? []) as Officer[]);
    setLoading(false);
  }, [periodId]);

  useEffect(() => {
    void load();
  }, [load]);

  // Realtime: watch this period for external status changes (concurrency signal).
  useEffect(() => {
    if (!periodId) return;
    const channel = supabase
      .channel(`audit-period-${periodId}`)
      .on(
        "postgres_changes",
        { event: "UPDATE", schema: "public", table: "cashbook_period", filter: `id=eq.${periodId}` },
        (payload) => {
          const newStatus = (payload.new as { status?: string })?.status;
          if (newStatus && newStatus !== "Submitted") setExternallyChanged(true);
        }
      )
      .subscribe();
    return () => {
      void supabase.removeChannel(channel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [periodId]);

  if (!online) return <p className="p-6 text-sm text-amber-700">{OFFLINE_MSG}</p>;
  if (loading) return <p className="p-6 text-sm text-muted-foreground">Loading audit…</p>;
  if (role && !hasPermission(role, "audit.view_queue")) {
    return <p className="p-6 text-sm text-destructive">Access denied. Auditor role required.</p>;
  }
  if (!period) return <p className="p-6 text-sm text-destructive">Period not found.</p>;

  const maskedOfficer = (id: string | null) => (id ? officers.find((o) => o.id === id)?.officer_code ?? "Officer" : "—");
  const getAtt = (id: string) => attachments.find((a) => a.line_item_id === id);

  // Reuse captureTotals math (map server rows to the CaptureItem shape).
  const ci: CaptureItem[] = items.map((i) => ({
    section: i.section as LineSection,
    item_type: i.item_type as ItemType,
    amount: Number(i.amount),
    proof_status: null,
    item_count: null,
  }));
  const bank = bankingView(ci);
  const sec = sectionTotals(ci);
  const income = incomeTotal(ci);
  const expensesT = expensesTotal(ci);

  const ddItems = items.filter((i) => i.item_type === "DirectDebit" && ["Members", "Officers"].includes(i.section));
  const eftItems = items.filter((i) => i.item_type === "EFT" && ["Members", "Officers"].includes(i.section));
  const cashBankedItems = items.filter((i) => i.item_type === "CashBanked");
  const cashPendingItems = items.filter((i) => ["Cash", "CashPending"].includes(i.item_type));
  const burialItems = items.filter((i) => i.item_type === "Burial");
  const expenseItems = items.filter((i) => i.item_type === "Expense");

  function back() {
    const r = access?.role;
    if (r === "Elder") navigate("/elder");
    else if (r === "Chairperson") navigate("/chairperson");
    else navigate("/audit");
  }

  async function decide(kind: "approve" | "reject") {
    if (!period || !access) return;
    if (kind === "approve" && (!canApprove || !allChecked)) return;
    if (kind === "reject" && (!canReject || !comment.trim())) return;

    const permKey = kind === "approve" ? "audit.approve" : "audit.reject";
    if (role && isOverrideAction(role, permKey)) {
      if (!window.confirm("SELF_REVIEW_EXCEPTION will be logged. Continue?")) return;
      await logSelfReviewException({
        userId: access.user_id,
        entityType: "cashbook_period",
        entityId: period.id,
        assumedRole: "Auditor",
      });
    }

    setProcessing(true);
    setError(null);
    const newStatus = kind === "approve" ? "AuditApproved" : "Rejected";
    const auditComment = kind === "approve" ? comment || "Approved" : comment;

    // Optimistic row-lock: only update rows still Submitted.
    const { data, error: e } = await supabase
      .from("cashbook_period")
      .update({ status: newStatus, audit_comment: auditComment })
      .eq("id", period.id)
      .eq("status", "Submitted")
      .select("id");

    if (e) {
      setError(e.message);
      setProcessing(false);
      return;
    }
    if (!data || data.length === 0) {
      setProcessing(false);
      setError("This period was already audited elsewhere. Reloading…");
      await load();
      return;
    }
    await logAuditAction({
      userId: access.user_id,
      actionType: kind === "approve" ? "AUDIT_APPROVE" : "AUDIT_REJECT",
      entityType: "cashbook_period",
      entityId: period.id,
      comment: auditComment,
    });
    setProcessing(false);
    back();
  }

  const decisionOpen = period.status === "Submitted" && !externallyChanged && (canApprove || canReject);

  const bankingRows = (group: LineItem[], label: string) =>
    group.length === 0 ? null : (
      <>
        {group.map((item) => {
          const att = getAtt(item.id);
          return (
            <tr key={item.id} className="border-b last:border-0">
              <td className="py-1.5 pr-2">{att?.transaction_date ?? item.transaction_date ?? "—"}</td>
              <td className="py-1.5 pr-2">{item.item_type === "DirectDebit" ? "Direct Debit" : item.item_type}</td>
              <td className="py-1.5 pr-2 text-right font-medium">{money(Number(item.amount))}</td>
              <td className="py-1.5 pr-2">{maskedOfficer(item.officer_id)}</td>
              <td className="py-1.5"><ProofLink url={att?.file_url} /></td>
            </tr>
          );
        })}
        <tr className="bg-muted/50 font-bold border-t">
          <td colSpan={2} className="py-1.5 pl-2 text-[11px]">Subtotal {label}</td>
          <td className="py-1.5 text-right text-[11px]">{money(group.reduce((s, i) => s + Number(i.amount), 0))}</td>
          <td colSpan={2} />
        </tr>
      </>
    );

  const VerifyBox = ({ checked, set, label }: { checked: boolean; set: (v: boolean) => void; label: string }) => (
    <label className="flex items-center gap-1.5 text-xs cursor-pointer">
      <input type="checkbox" checked={checked} onChange={(e) => set(e.target.checked)} className="rounded accent-green-600" />
      <span className={checked ? "text-green-700 font-medium" : "text-muted-foreground"}>{label}</span>
    </label>
  );

  return (
    <div className="max-w-5xl mx-auto px-4 py-4 space-y-4">
      <Button variant="outline" size="sm" onClick={back}>← Back</Button>

      <div className="rounded-md bg-orange-50 border border-orange-200 px-4 py-3 flex items-center justify-between">
        <div>
          <p className="text-sm font-bold text-orange-800">Audit Review</p>
          <p className="text-[10px] text-orange-600">
            Week {period.week} · {period.service} · {period.year}/{String(period.month).padStart(2, "0")}
          </p>
        </div>
        <Badge variant="secondary" className="text-[10px]">{period.status}</Badge>
      </div>

      {externallyChanged && (
        <div className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800">
          This period was updated elsewhere.{" "}
          <button className="underline" onClick={() => void load()}>Reload</button>
        </div>
      )}

      {/* Summary cards */}
      <div className="grid grid-cols-3 gap-2">
        {[
          { label: "EFT", val: bank.eft, count: eftItems.length },
          { label: "Direct Debit", val: bank.directDebit, count: ddItems.length },
          { label: "Cash", val: bank.cashBanked + bank.cashPending, count: cashBankedItems.length + cashPendingItems.length },
        ].map((c) => (
          <Card key={c.label} className="bg-blue-50 border-blue-200">
            <CardContent className="py-2 px-3 text-center">
              <p className="text-[10px] uppercase text-blue-600 font-medium">{c.label}</p>
              <p className="text-sm font-bold text-blue-900">{money(c.val)}</p>
              <p className="text-[10px] text-blue-500">{c.count} entries</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Panel 1: Banking Detail */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-xs">Banking Detail</CardTitle>
            <VerifyBox checked={checkedBanking} set={setCheckedBanking} label="Verified" />
          </div>
        </CardHeader>
        <CardContent>
          {ddItems.length + eftItems.length + cashBankedItems.length === 0 ? (
            <p className="text-xs text-muted-foreground">No electronic banking items.</p>
          ) : (
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b text-muted-foreground text-left">
                  <th className="pb-1 pr-2">Date</th><th className="pb-1 pr-2">Type</th>
                  <th className="pb-1 pr-2 text-right">Amount</th><th className="pb-1 pr-2">Officer</th><th className="pb-1">Proof</th>
                </tr>
              </thead>
              <tbody>
                {bankingRows(ddItems, "Direct Debit")}
                {bankingRows(eftItems, "EFT")}
                {bankingRows(cashBankedItems, "Cash Banked")}
                <tr className="font-bold border-t">
                  <td colSpan={2} className="py-2">BANKING TOTAL</td>
                  <td className="py-2 text-right">{money(bank.bankingTotal)}</td><td colSpan={2} />
                </tr>
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {/* Panel 2: Cash Pending */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-xs">Cash Pending</CardTitle>
            <VerifyBox checked={checkedCash} set={setCheckedCash} label="Verified" />
          </div>
        </CardHeader>
        <CardContent>
          {cashPendingItems.length === 0 && burialItems.length === 0 ? (
            <p className="text-xs text-muted-foreground">No pending cash.</p>
          ) : (
            <table className="w-full text-xs">
              <thead><tr className="border-b text-muted-foreground text-left"><th className="pb-1 pr-2">Source</th><th className="pb-1 pr-2">Entries</th><th className="pb-1 text-right">Amount</th></tr></thead>
              <tbody>
                {cashPendingItems.length > 0 && (
                  <tr className="border-b"><td className="py-2 font-medium">Cash Income</td><td className="py-2 text-muted-foreground">{cashPendingItems.length}</td><td className="py-2 text-right font-medium">{money(cashPendingItems.reduce((s, i) => s + Number(i.amount), 0))}</td></tr>
                )}
                {burialItems.length > 0 && (
                  <tr className="border-b"><td className="py-2 font-medium">Cash Burial</td><td className="py-2 text-muted-foreground">{burialItems.length} ({burialItems.map((i) => i.receipt_number || "—").join(", ")})</td><td className="py-2 text-right font-medium">{money(sec.Burial)}</td></tr>
                )}
                <tr className="font-bold border-t bg-muted/30"><td className="py-2">TOTAL CASH</td><td /><td className="py-2 text-right">{money(bank.cashPending + sec.Burial)}</td></tr>
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {/* Panel 3: Burial */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-xs">Burial</CardTitle>
            <VerifyBox checked={checkedBurial} set={setCheckedBurial} label="Verified" />
          </div>
        </CardHeader>
        <CardContent>
          {burialItems.length === 0 ? (
            <p className="text-xs text-muted-foreground">No burial entries this period.</p>
          ) : (
            <table className="w-full text-xs">
              <thead><tr className="border-b text-muted-foreground text-left"><th className="pb-1 pr-2">Receipt</th><th className="pb-1 pr-2 text-right">Amount</th><th className="pb-1">Proof</th></tr></thead>
              <tbody>
                {burialItems.map((item) => {
                  const att = getAtt(item.id);
                  return (
                    <tr key={item.id} className="border-b last:border-0">
                      <td className="py-1.5 pr-2 font-medium">{item.receipt_number || "—"}</td>
                      <td className="py-1.5 pr-2 text-right font-medium">{money(Number(item.amount))}</td>
                      <td className="py-1.5"><ProofLink url={att?.file_url} /></td>
                    </tr>
                  );
                })}
                <tr className="font-bold border-t"><td className="py-2">TOTAL BURIAL</td><td className="py-2 text-right">{money(sec.Burial)}</td><td /></tr>
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {/* Panel 4: Expenses */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-xs">Expenses</CardTitle>
            <VerifyBox checked={checkedExpenses} set={setCheckedExpenses} label="Verified" />
          </div>
        </CardHeader>
        <CardContent>
          {expenseItems.length === 0 ? (
            <p className="text-xs text-muted-foreground">No expenses this period.</p>
          ) : (
            <table className="w-full text-xs">
              <thead><tr className="border-b text-muted-foreground text-left"><th className="pb-1">Description</th><th className="pb-1 text-right pr-2">Amount</th><th className="pb-1">Proof</th></tr></thead>
              <tbody>
                {expenseItems.map((item) => {
                  const att = getAtt(item.id);
                  return (
                    <tr key={item.id} className="border-b last:border-0">
                      <td className="py-1.5 pr-2">{item.manual_reference || "—"}</td>
                      <td className="py-1.5 pr-2 text-right font-medium">{money(Number(item.amount))}</td>
                      <td className="py-1.5"><ProofLink url={att?.file_url} /></td>
                    </tr>
                  );
                })}
                <tr className="font-bold border-t"><td className="py-2">TOTAL EXPENSES</td><td className="py-2 text-right">{money(expensesT)}</td><td /></tr>
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {/* Panel 5: Summary */}
      <Card className="bg-muted/30">
        <CardContent className="py-3">
          <div className="flex items-center justify-between text-sm">
            <span className="font-bold">Grand Total (Income − Expenses)</span>
            <span className="font-bold text-lg text-primary">{money(income - expensesT)}</span>
          </div>
          <div className="flex gap-4 mt-2 text-[10px] text-muted-foreground">
            <span>Members: {money(sec.Members)}</span>
            <span>Officers: {money(sec.Officers)}</span>
            <span>Burial: {money(sec.Burial)}</span>
            <span>Expenses: {money(expensesT)}</span>
          </div>
        </CardContent>
      </Card>

      {/* Audit decision */}
      {decisionOpen && (
        <Card className={allChecked ? "border-green-300" : "border-orange-200"}>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs">Audit Decision</CardTitle>
            {!allChecked && <p className="text-[10px] text-orange-600">Verify all four sections before approving.</p>}
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="flex gap-3 text-[10px]">
              <span className={checkedBanking ? "text-green-700" : "text-muted-foreground"}>✓ Banking</span>
              <span className={checkedCash ? "text-green-700" : "text-muted-foreground"}>✓ Cash</span>
              <span className={checkedBurial ? "text-green-700" : "text-muted-foreground"}>✓ Burial</span>
              <span className={checkedExpenses ? "text-green-700" : "text-muted-foreground"}>✓ Expenses</span>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Comment {canReject ? "(mandatory for rejection)" : "(optional)"}</Label>
              <Input className="h-9 text-xs" value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Audit comment…" />
            </div>
            {error && <p className="text-xs text-destructive">{error}</p>}
            <div className="flex gap-3">
              {canApprove && (
                <Button size="sm" className="bg-green-700 hover:bg-green-800" onClick={() => void decide("approve")} disabled={processing || !allChecked}>
                  {processing ? "…" : "Approve"}
                </Button>
              )}
              {canReject && (
                <Button size="sm" variant="destructive" onClick={() => void decide("reject")} disabled={processing || !comment.trim()}>
                  {processing ? "…" : "Reject"}
                </Button>
              )}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
