"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { getUserAccess, hasPermission, isOverrideAction, logSelfReviewException, logAuditAction } from "@/lib/permissions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import type { Role, UserHierarchyAccess } from "@/lib/types";

interface Period { id: string; congregation_id: string; year: number; month: number; week: number; service: string; status: string; week_key: string | null; submitted_at: string | null; }
interface LineItem { id: string; period_id: string; section: string; officer_id: string | null; item_type: string; amount: number; is_officer: boolean; receipt_number: string | null; manual_reference: string | null; transaction_date: string | null; }
interface Attachment { id: string; line_item_id: string; file_url: string; transaction_date: string | null; bank_reference: string | null; }
interface Officer { id: string; officer_code: string; }

const Clip = ({ has, url }: { has: boolean; url?: string }) => has ? (
  <a href={url} target="_blank" rel="noopener noreferrer" className="text-green-600 hover:text-green-700">
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>
  </a>
) : (
  <svg className="w-4 h-4 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>
);

export default function AuditReviewPage() {
  const params = useParams();
  const router = useRouter();
  const serviceId = params.service_id as string;
  const supabase = createClient();

  const [access, setAccess] = useState<UserHierarchyAccess | null>(null);
  const [period, setPeriod] = useState<Period | null>(null);
  const [items, setItems] = useState<LineItem[]>([]);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [officers, setOfficers] = useState<Officer[]>([]);
  const [loading, setLoading] = useState(true);
  const [comment, setComment] = useState("");
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Audit checkboxes
  const [checkedBanking, setCheckedBanking] = useState(false);
  const [checkedCash, setCheckedCash] = useState(false);
  const [checkedBurial, setCheckedBurial] = useState(false);
  const [checkedExpenses, setCheckedExpenses] = useState(false);

  const role = access?.role as Role | undefined;
  const canApprove = role ? hasPermission(role, "audit.approve") : false;
  const canReject = role ? hasPermission(role, "audit.reject") : false;
  const allChecked = checkedBanking && checkedCash && checkedBurial && checkedExpenses;

  const load = useCallback(async () => {
    setLoading(true);
    const ua = await getUserAccess();
    if (!ua) { setLoading(false); return; }
    setAccess(ua);
    const { data: p } = await supabase.from("cashbook_period").select("*").eq("id", serviceId).single();
    if (!p) { setLoading(false); return; }
    setPeriod(p);
    const [li, att, off] = await Promise.all([
      supabase.from("cashbook_line_item").select("id, period_id, section, officer_id, item_type, amount, is_officer, receipt_number, manual_reference, transaction_date").eq("period_id", serviceId),
      supabase.from("cashbook_attachment").select("id, line_item_id, file_url, transaction_date, bank_reference"),
      supabase.from("officers").select("id, officer_code").eq("congregation_id", p.congregation_id).eq("is_active", true),
    ]);
    setItems(li.data ?? []);
    const ids = new Set((li.data ?? []).map((i: LineItem) => i.id));
    setAttachments((att.data ?? []).filter((a: Attachment) => ids.has(a.line_item_id)));
    setOfficers(off.data ?? []);
    setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serviceId]);

  useEffect(() => { load(); }, [load]);

  const maskedOfficer = (id: string | null) => { if (!id) return "—"; const o = officers.find(x => x.id === id); return o?.officer_code ?? "Officer"; };
  const getAtt = (id: string) => attachments.find(a => a.line_item_id === id);

  // Totals
  const ddItems = items.filter(i => i.item_type === "DirectDebit" && ["Members","Officers"].includes(i.section));
  const eftItems = items.filter(i => i.item_type === "EFT" && ["Members","Officers"].includes(i.section));
  const cashBankedItems = items.filter(i => i.item_type === "CashBanked");
  const cashPendingItems = items.filter(i => ["Cash","CashPending"].includes(i.item_type));
  const burialItems = items.filter(i => i.item_type === "Burial");
  const expenseItems = items.filter(i => i.item_type === "Expense");

  const bankingTotal = [...ddItems, ...eftItems, ...cashBankedItems].reduce((s, i) => s + Number(i.amount), 0);
  const cashTotal = cashPendingItems.reduce((s, i) => s + Number(i.amount), 0) + burialItems.reduce((s, i) => s + Number(i.amount), 0);
  const burialTotal = burialItems.reduce((s, i) => s + Number(i.amount), 0);
  const expensesTotal = expenseItems.reduce((s, i) => s + Number(i.amount), 0);
  const membersT = items.filter(i => !i.is_officer && ["EFT","Cash","DirectDebit","CashBanked","CashPending"].includes(i.item_type)).reduce((s,i)=>s+Number(i.amount),0);
  const officersT = items.filter(i => i.is_officer && ["EFT","Cash","DirectDebit","CashBanked","CashPending"].includes(i.item_type)).reduce((s,i)=>s+Number(i.amount),0);
  const grandIncome = membersT + officersT + burialTotal;

  async function handleApprove() {
    if (!period || !access || !canApprove) return;
    if (isOverrideAction(role!, "audit.approve")) {
      if (!window.confirm("SELF_REVIEW_EXCEPTION will be logged. Continue?")) return;
      await logSelfReviewException({ userId: access.user_id, entityType: "cashbook_period", entityId: period.id, assumedRole: "Auditor" });
    }
    setProcessing(true); setError(null);
    const { error: e } = await supabase.from("cashbook_period").update({ status: "AuditApproved", audit_comment: comment || "Approved" }).eq("id", period.id);
    if (e) { setError(e.message); setProcessing(false); return; }
    await logAuditAction({ userId: access.user_id, actionType: "AUDIT_APPROVE", entityType: "cashbook_period", entityId: period.id, comment: comment || "Approved" });
    setProcessing(false); handleBack();
  }

  async function handleReject() {
    if (!period || !access || !canReject || !comment.trim()) return;
    if (isOverrideAction(role!, "audit.reject")) {
      if (!window.confirm("SELF_REVIEW_EXCEPTION will be logged. Continue?")) return;
      await logSelfReviewException({ userId: access.user_id, entityType: "cashbook_period", entityId: period.id, assumedRole: "Auditor" });
    }
    setProcessing(true); setError(null);
    const { error: e } = await supabase.from("cashbook_period").update({ status: "Rejected", audit_comment: comment }).eq("id", period.id);
    if (e) { setError(e.message); setProcessing(false); return; }
    await logAuditAction({ userId: access.user_id, actionType: "AUDIT_REJECT", entityType: "cashbook_period", entityId: period.id, comment });
    setProcessing(false); handleBack();
  }

  // Role-based back navigation
  function handleBack() {
    const r = access?.role;
    if (r === "Elder") router.push("/elder");
    else if (r === "Chairperson") router.push("/chairperson");
    else router.push("/audit");
  }

  if (loading) return <div className="p-6 text-sm text-muted-foreground">Loading audit...</div>;
  if (!period) return <div className="p-6 text-sm text-destructive">Period not found.</div>;

  const renderGroup = (groupItems: LineItem[], label: string) => groupItems.length === 0 ? null : (<>
    {groupItems.map(item => { const att = getAtt(item.id); return (
      <tr key={item.id} className="border-b last:border-0">
        <td className="py-1.5 pr-2">{att?.transaction_date ?? item.transaction_date ?? "—"}</td>
        <td className="py-1.5 pr-2">{item.item_type === "DirectDebit" ? "Direct Debit" : item.item_type}</td>
        <td className="py-1.5 pr-2 text-right font-medium">R{Number(item.amount).toFixed(2)}</td>
        <td className="py-1.5 pr-2">{maskedOfficer(item.officer_id)}</td>
        <td className="py-1.5"><Clip has={!!att} url={att?.file_url} /></td>
      </tr>); })}
    <tr className="bg-muted/50 font-bold border-t"><td colSpan={2} className="py-1.5 pl-2 text-[11px]">Subtotal {label}</td><td className="py-1.5 text-right text-[11px]">R{groupItems.reduce((s,i)=>s+Number(i.amount),0).toFixed(2)}</td><td colSpan={2}></td></tr>
  </>);

  return (
    <div className="max-w-5xl mx-auto px-4 py-4 space-y-4">
      <Button variant="outline" size="sm" onClick={handleBack}>← Back</Button>

      {/* Audit Banner */}
      <div className="rounded-md bg-orange-50 border border-orange-200 px-4 py-3 flex items-center justify-between">
        <div>
          <p className="text-sm font-bold text-orange-800">Audit Review</p>
          <p className="text-[10px] text-orange-600">Week {period.week} · {period.service} · {period.year}/{String(period.month).padStart(2,"0")}</p>
        </div>
        <Badge variant="secondary" className="text-[10px]">{period.status}</Badge>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-3 gap-2">
        {[{ label: "EFT", items: eftItems }, { label: "Direct Debit", items: ddItems }, { label: "Cash", items: [...cashBankedItems, ...cashPendingItems] }].map(({ label, items: gi }) => (
          <Card key={label} className="bg-blue-50 border-blue-200">
            <CardContent className="py-2 px-3 text-center">
              <p className="text-[10px] uppercase text-blue-600 font-medium">{label}</p>
              <p className="text-sm font-bold text-blue-900">R{gi.reduce((s,i)=>s+Number(i.amount),0).toFixed(2)}</p>
              <p className="text-[10px] text-blue-500">{gi.length} entries</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Banking Section */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-xs">Banking Detail</CardTitle>
            <label className="flex items-center gap-1.5 text-xs cursor-pointer">
              <input type="checkbox" checked={checkedBanking} onChange={e => setCheckedBanking(e.target.checked)} className="rounded accent-green-600" />
              <span className={checkedBanking ? "text-green-700 font-medium" : "text-muted-foreground"}>Verified</span>
            </label>
          </div>
        </CardHeader>
        <CardContent>
          {[...ddItems, ...eftItems, ...cashBankedItems].length === 0 ? <p className="text-xs text-muted-foreground">No electronic banking items.</p> : (
            <table className="w-full text-xs">
              <thead><tr className="border-b text-muted-foreground text-left"><th className="pb-1 pr-2">Date</th><th className="pb-1 pr-2">Type</th><th className="pb-1 pr-2 text-right">Amount</th><th className="pb-1 pr-2">Officer</th><th className="pb-1">Proof</th></tr></thead>
              <tbody>
                {renderGroup(ddItems, "Direct Debit")}
                {renderGroup(eftItems, "EFT")}
                {renderGroup(cashBankedItems, "Cash Banked")}
                <tr className="font-bold border-t"><td colSpan={2} className="py-2">BANKING TOTAL</td><td className="py-2 text-right">R{bankingTotal.toFixed(2)}</td><td colSpan={2}></td></tr>
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {/* Cash Pending Section */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-xs">Cash Pending</CardTitle>
            <label className="flex items-center gap-1.5 text-xs cursor-pointer">
              <input type="checkbox" checked={checkedCash} onChange={e => setCheckedCash(e.target.checked)} className="rounded accent-green-600" />
              <span className={checkedCash ? "text-green-700 font-medium" : "text-muted-foreground"}>Verified</span>
            </label>
          </div>
        </CardHeader>
        <CardContent>
          {cashPendingItems.length === 0 && burialItems.length === 0 ? <p className="text-xs text-muted-foreground">No pending cash.</p> : (
            <table className="w-full text-xs">
              <thead><tr className="border-b text-muted-foreground text-left"><th className="pb-1 pr-2">Source</th><th className="pb-1 pr-2">Entries</th><th className="pb-1 text-right">Amount</th></tr></thead>
              <tbody>
                {cashPendingItems.length > 0 && <tr className="border-b"><td className="py-2 font-medium">Cash Income</td><td className="py-2 text-muted-foreground">{cashPendingItems.length}</td><td className="py-2 text-right font-medium">R{cashPendingItems.reduce((s,i)=>s+Number(i.amount),0).toFixed(2)}</td></tr>}
                {burialItems.length > 0 && <tr className="border-b"><td className="py-2 font-medium">Cash Burial</td><td className="py-2 text-muted-foreground">{burialItems.length} ({burialItems.map(i=>i.receipt_number||"—").join(", ")})</td><td className="py-2 text-right font-medium">R{burialTotal.toFixed(2)}</td></tr>}
                <tr className="font-bold border-t bg-muted/30"><td className="py-2">TOTAL CASH</td><td></td><td className="py-2 text-right">R{cashTotal.toFixed(2)}</td></tr>
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {/* Burial Section - always show */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-xs">Burial</CardTitle>
            <label className="flex items-center gap-1.5 text-xs cursor-pointer">
              <input type="checkbox" checked={checkedBurial} onChange={e => setCheckedBurial(e.target.checked)} className="rounded accent-green-600" />
              <span className={checkedBurial ? "text-green-700 font-medium" : "text-muted-foreground"}>Verified</span>
            </label>
          </div>
        </CardHeader>
        <CardContent>
          {burialItems.length === 0 ? <p className="text-xs text-muted-foreground">No burial entries this period.</p> : (
            <table className="w-full text-xs">
              <thead><tr className="border-b text-muted-foreground text-left"><th className="pb-1 pr-2">Receipt</th><th className="pb-1 pr-2 text-right">Amount</th><th className="pb-1">Proof</th></tr></thead>
              <tbody>
                {burialItems.map(item => { const att = getAtt(item.id); return (
                  <tr key={item.id} className="border-b last:border-0">
                    <td className="py-1.5 pr-2 font-medium">{item.receipt_number || "—"}</td>
                    <td className="py-1.5 pr-2 text-right font-medium">R{Number(item.amount).toFixed(2)}</td>
                    <td className="py-1.5"><Clip has={!!att} url={att?.file_url} /></td>
                  </tr>); })}
                <tr className="font-bold border-t"><td className="py-2">TOTAL BURIAL</td><td className="py-2 text-right">R{burialTotal.toFixed(2)}</td><td></td></tr>
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {/* Expenses Section - always show */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-xs">Expenses</CardTitle>
            <label className="flex items-center gap-1.5 text-xs cursor-pointer">
              <input type="checkbox" checked={checkedExpenses} onChange={e => setCheckedExpenses(e.target.checked)} className="rounded accent-green-600" />
              <span className={checkedExpenses ? "text-green-700 font-medium" : "text-muted-foreground"}>Verified</span>
            </label>
          </div>
        </CardHeader>
        <CardContent>
          {expenseItems.length === 0 ? <p className="text-xs text-muted-foreground">No expenses this period.</p> : (
            <table className="w-full text-xs">
              <thead><tr className="border-b text-muted-foreground text-left"><th className="pb-1">Description</th><th className="pb-1 text-right pr-2">Amount</th><th className="pb-1">Proof</th></tr></thead>
              <tbody>
                {expenseItems.map(item => { const att = getAtt(item.id); return (
                  <tr key={item.id} className="border-b last:border-0">
                    <td className="py-1.5 pr-2">{item.manual_reference || "—"}</td>
                    <td className="py-1.5 pr-2 text-right font-medium">R{Number(item.amount).toFixed(2)}</td>
                    <td className="py-1.5"><Clip has={!!att} url={att?.file_url} /></td>
                  </tr>); })}
                <tr className="font-bold border-t"><td className="py-2">TOTAL EXPENSES</td><td className="py-2 text-right">R{expensesTotal.toFixed(2)}</td><td></td></tr>
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>

      {/* Grand Total */}
      <Card className="bg-muted/30">
        <CardContent className="py-3">
          <div className="flex items-center justify-between text-sm">
            <span className="font-bold">Grand Total (Income - Expenses)</span>
            <span className="font-bold text-lg text-primary">R{(grandIncome - expensesTotal).toFixed(2)}</span>
          </div>
          <div className="flex gap-4 mt-2 text-[10px] text-muted-foreground">
            <span>Members: R{membersT.toFixed(2)}</span>
            <span>Officers: R{officersT.toFixed(2)}</span>
            <span>Burial: R{burialTotal.toFixed(2)}</span>
            <span>Expenses: R{expensesTotal.toFixed(2)}</span>
          </div>
        </CardContent>
      </Card>

      {/* Audit Decision */}
      {period.status === "Submitted" && (canApprove || canReject) && (
        <Card className={allChecked ? "border-green-300" : "border-orange-200"}>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs">Audit Decision</CardTitle>
            {!allChecked && <p className="text-[10px] text-orange-600">Please verify all sections above before approving.</p>}
          </CardHeader>
          <CardContent className="space-y-3">
            {/* Checklist summary */}
            <div className="flex gap-3 text-[10px]">
              <span className={checkedBanking ? "text-green-700" : "text-muted-foreground"}>✓ Banking</span>
              <span className={checkedCash ? "text-green-700" : "text-muted-foreground"}>✓ Cash</span>
              <span className={checkedBurial ? "text-green-700" : "text-muted-foreground"}>✓ Burial</span>
              <span className={checkedExpenses ? "text-green-700" : "text-muted-foreground"}>✓ Expenses</span>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Comment {canReject ? "(mandatory for rejection)" : "(optional)"}</Label>
              <Input className="h-9 text-xs" value={comment} onChange={e => setComment(e.target.value)} placeholder="Audit comment..." />
            </div>
            {error && <p className="text-xs text-destructive">{error}</p>}
            <div className="flex gap-3">
              {canApprove && <Button size="sm" className="bg-green-700 hover:bg-green-800" onClick={handleApprove} disabled={processing || !allChecked}>{processing ? "..." : "Approve"}</Button>}
              {canReject && <Button size="sm" variant="destructive" onClick={handleReject} disabled={processing || !comment.trim()}>{processing ? "..." : "Reject"}</Button>}
            </div>
            {canApprove && !allChecked && <p className="text-[10px] text-muted-foreground">All 4 section checkboxes must be verified to approve.</p>}
            {canReject && !comment.trim() && <p className="text-[10px] text-muted-foreground">Comment required to reject.</p>}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
