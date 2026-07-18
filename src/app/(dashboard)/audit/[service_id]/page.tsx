"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { getUserAccess, hasPermission, isOverrideAction, logSelfReviewException, logAuditAction } from "@/lib/permissions";
import { AppHeader } from "@/components/AppHeader";
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

  const role = access?.role as Role | undefined;
  const canApprove = role ? hasPermission(role, "audit.approve") : false;
  const canReject = role ? hasPermission(role, "audit.reject") : false;

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

  // Masked officer display (code only, no name)
  const maskedOfficer = (officerId: string | null) => {
    if (!officerId) return "—";
    const off = officers.find(o => o.id === officerId);
    return off?.officer_code ?? "Officer";
  };

  const hasProof = (id: string) => attachments.some(a => a.line_item_id === id);
  const getAtt = (id: string) => attachments.find(a => a.line_item_id === id);

  // Totals
  const membersT = items.filter(i => !i.is_officer && ["EFT","Cash","DirectDebit","CashBanked"].includes(i.item_type)).reduce((s,i)=>s+Number(i.amount),0);
  const officersT = items.filter(i => i.is_officer && ["EFT","Cash","DirectDebit","CashBanked"].includes(i.item_type)).reduce((s,i)=>s+Number(i.amount),0);
  const burialT = items.filter(i => i.item_type === "Burial").reduce((s,i)=>s+Number(i.amount),0);
  const expensesT = items.filter(i => i.item_type === "Expense").reduce((s,i)=>s+Number(i.amount),0);
  const grandIncome = membersT + officersT + burialT;

  // Banking items sorted
  const bankingItems = items.filter(i => ["EFT","DirectDebit","CashBanked"].includes(i.item_type))
    .sort((a, b) => { const o = (t: string) => t === "DirectDebit" ? 0 : t === "EFT" ? 1 : 2; return o(a.item_type) - o(b.item_type); });

  async function handleApprove() {
    if (!period || !access || !canApprove) return;
    if (isOverrideAction(role!, "audit.approve")) {
      if (!window.confirm("SELF_REVIEW_EXCEPTION will be logged. Continue?")) return;
      await logSelfReviewException({ userId: access.user_id, entityType: "cashbook_period", entityId: period.id, assumedRole: "Auditor" });
    }
    setProcessing(true);
    await supabase.from("cashbook_period").update({ status: "AuditApproved", audit_comment: comment || "Approved" }).eq("id", period.id);
    await logAuditAction({ userId: access.user_id, actionType: "AUDIT_APPROVE", entityType: "cashbook_period", entityId: period.id, comment: comment || "Approved" });
    setProcessing(false);
    router.push("/audit");
  }

  async function handleReject() {
    if (!period || !access || !canReject || !comment.trim()) return;
    if (isOverrideAction(role!, "audit.reject")) {
      if (!window.confirm("SELF_REVIEW_EXCEPTION will be logged. Continue?")) return;
      await logSelfReviewException({ userId: access.user_id, entityType: "cashbook_period", entityId: period.id, assumedRole: "Auditor" });
    }
    setProcessing(true);
    await supabase.from("cashbook_period").update({ status: "Rejected", audit_comment: comment }).eq("id", period.id);
    await logAuditAction({ userId: access.user_id, actionType: "AUDIT_REJECT", entityType: "cashbook_period", entityId: period.id, comment });
    setProcessing(false);
    router.push("/audit");
  }

  if (loading) return <><AppHeader /><div className="p-6 text-sm text-muted-foreground">Loading audit...</div></>;
  if (!period) return <><AppHeader /><div className="p-6 text-sm text-destructive">Period not found.</div></>;

  return (
    <>
      <AppHeader />
      <div className="max-w-5xl mx-auto px-4 py-4 space-y-4">
        {/* Audit Banner */}
        <div className="rounded-md bg-orange-50 border border-orange-200 px-4 py-3 flex items-center justify-between">
          <div>
            <p className="text-sm font-bold text-orange-800">Audit in Progress</p>
            <p className="text-[10px] text-orange-600">Week {period.week} · {period.service} · {period.year}/{String(period.month).padStart(2,"0")}</p>
          </div>
          <Badge variant="secondary" className="text-[10px]">{period.status}</Badge>
        </div>

        {/* Summary Cards */}
        <div className="grid grid-cols-3 gap-2">
          {["EFT", "DirectDebit", "Cash"].map(t => {
            const filtered = items.filter(i => ["Members","Officers"].includes(i.section) && i.item_type === t);
            return (
              <Card key={t} className="bg-blue-50 border-blue-200">
                <CardContent className="py-2 px-3 text-center">
                  <p className="text-[10px] uppercase text-blue-600 font-medium">{t === "DirectDebit" ? "Direct Deposit" : t}</p>
                  <p className="text-sm font-bold text-blue-900">R{filtered.reduce((s,i)=>s+Number(i.amount),0).toFixed(2)}</p>
                  <p className="text-[10px] text-blue-500">{filtered.length} entries</p>
                </CardContent>
              </Card>
            );
          })}
        </div>

        <div className="grid gap-4 md:grid-cols-[1fr_260px]">
          {/* Left: Banking Detail (read-only, masked officers) */}
          <div className="space-y-4">
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-xs">Banking Detail</CardTitle></CardHeader>
              <CardContent>
                {bankingItems.length === 0 ? <p className="text-xs text-muted-foreground">No electronic items.</p> : (
                  <table className="w-full text-xs">
                    <thead><tr className="border-b text-muted-foreground text-left">
                      <th className="pb-1 pr-2">Date on Proof</th><th className="pb-1 pr-2">Type</th><th className="pb-1 pr-2 text-right">Amount</th><th className="pb-1 pr-2">Officer</th><th className="pb-1">Proof</th>
                    </tr></thead>
                    <tbody>
                      {bankingItems.map(item => { const att = getAtt(item.id); return (
                        <tr key={item.id} className="border-b last:border-0">
                          <td className="py-1.5 pr-2">{att?.transaction_date ?? item.transaction_date ?? "—"}</td>
                          <td className="py-1.5 pr-2">{item.item_type === "DirectDebit" ? "Direct Debit" : item.item_type}</td>
                          <td className="py-1.5 pr-2 text-right font-medium">R{Number(item.amount).toFixed(2)}</td>
                          <td className="py-1.5 pr-2">{maskedOfficer(item.officer_id)}</td>
                          <td className="py-1.5">
                            {att ? <a href={att.file_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-green-600"><svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg></a> : <span className="text-destructive text-[10px]">Missing</span>}
                          </td>
                        </tr>); })}
                      <tr className="font-bold border-t"><td colSpan={2} className="py-2">TOTAL</td><td className="py-2 text-right">R{bankingItems.reduce((s,i)=>s+Number(i.amount),0).toFixed(2)}</td><td colSpan={2}></td></tr>
                    </tbody>
                  </table>
                )}
              </CardContent>
            </Card>

            {/* Burial */}
            {items.filter(i => i.item_type === "Burial").length > 0 && (
              <Card>
                <CardHeader className="pb-2"><CardTitle className="text-xs">Burial</CardTitle></CardHeader>
                <CardContent>
                  {items.filter(i => i.item_type === "Burial").map(item => { const att = getAtt(item.id); return (
                    <div key={item.id} className="flex items-center gap-3 py-1.5 border-b last:border-0 text-xs">
                      <span className="w-20 font-medium">{item.receipt_number ?? "—"}</span>
                      <span className="flex-1 text-right font-medium">R{Number(item.amount).toFixed(2)}</span>
                      {att ? <a href={att.file_url} target="_blank" rel="noopener noreferrer" className="text-green-600"><svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg></a> : <span className="text-destructive text-[10px]">—</span>}
                    </div>); })}
                </CardContent>
              </Card>
            )}

            {/* Expenses */}
            {items.filter(i => i.item_type === "Expense").length > 0 && (
              <Card>
                <CardHeader className="pb-2"><CardTitle className="text-xs">Expenses</CardTitle></CardHeader>
                <CardContent>
                  {items.filter(i => i.item_type === "Expense").map(item => { const att = getAtt(item.id); return (
                    <div key={item.id} className="flex items-center gap-3 py-1.5 border-b last:border-0 text-xs">
                      <span className="flex-1 truncate">{item.manual_reference ?? "—"}</span>
                      <span className="w-24 text-right font-medium">R{Number(item.amount).toFixed(2)}</span>
                      {att ? <a href={att.file_url} target="_blank" rel="noopener noreferrer" className="text-green-600"><svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg></a> : <span className="text-destructive text-[10px]">—</span>}
                    </div>); })}
                </CardContent>
              </Card>
            )}

            {/* Approve / Reject */}
            {period.status === "Submitted" && (canApprove || canReject) && (
              <Card>
                <CardHeader className="pb-2"><CardTitle className="text-xs">Audit Decision</CardTitle></CardHeader>
                <CardContent className="space-y-3">
                  <div className="space-y-1">
                    <Label className="text-xs">Comment {canReject ? "(mandatory for rejection)" : "(optional)"}</Label>
                    <Input className="h-9 text-xs" value={comment} onChange={e => setComment(e.target.value)} placeholder="Audit comment..." />
                  </div>
                  {error && <p className="text-xs text-destructive">{error}</p>}
                  <div className="flex gap-3">
                    {canApprove && <Button size="sm" className="bg-green-700 hover:bg-green-800" onClick={handleApprove} disabled={processing}>{processing ? "..." : "Approve"}</Button>}
                    {canReject && <Button size="sm" variant="destructive" onClick={handleReject} disabled={processing || !comment.trim()}>{processing ? "..." : "Reject"}</Button>}
                  </div>
                  {canReject && !comment.trim() && <p className="text-[10px] text-muted-foreground">Comment required to reject.</p>}
                </CardContent>
              </Card>
            )}
          </div>

          {/* Right: Totals */}
          <div className="hidden md:block space-y-3">
            <Card className="sticky top-14">
              <CardHeader className="pb-1 px-3"><CardTitle className="text-[10px] uppercase tracking-wider text-muted-foreground">Totals</CardTitle></CardHeader>
              <CardContent className="px-3 space-y-1 text-xs">
                <div className="flex justify-between"><span>Members</span><b>R{membersT.toFixed(2)}</b></div>
                <div className="flex justify-between"><span>Officers</span><b>R{officersT.toFixed(2)}</b></div>
                <div className="flex justify-between"><span>Burial</span><b>R{burialT.toFixed(2)}</b></div>
                <div className="flex justify-between border-t pt-1 font-bold"><span>Income</span><span>R{grandIncome.toFixed(2)}</span></div>
                <div className="flex justify-between text-muted-foreground"><span>Expenses</span><span>R{expensesT.toFixed(2)}</span></div>
                <div className="flex justify-between border-t pt-1 font-bold text-primary"><span>Grand Total</span><span>R{(grandIncome - expensesT).toFixed(2)}</span></div>
              </CardContent>
            </Card>
            <div className="w-full rounded-md bg-orange-50 border border-orange-200 py-2 text-center">
              <span className="text-xs font-bold text-orange-700">Audit in Progress</span>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
