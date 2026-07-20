"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { getUserAccess } from "@/lib/permissions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { UserHierarchyAccess } from "@/lib/types";

interface Period { id: string; congregation_id: string; year: number; month: number; week: number; service: string; status: string; }
interface LineItem { id: string; section: string; officer_id: string | null; item_type: string; amount: number; is_officer: boolean; receipt_number: string | null; manual_reference: string | null; transaction_date: string | null; payment_type: string | null; }
interface Attachment { id: string; line_item_id: string; file_url: string; transaction_date: string | null; bank_reference: string | null; }
interface Officer { id: string; officer_code: string; }

type TabKey = "Members" | "Officers" | "Burial" | "Expenses" | "Banking";
const TABS: TabKey[] = ["Members", "Officers", "Burial", "Expenses", "Banking"];

const Clip = ({ has, url }: { has: boolean; url?: string }) => has ? (
  <a href={url} target="_blank" rel="noopener noreferrer" className="text-green-600">
    <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>
  </a>
) : <svg className="w-4 h-4 text-red-400" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>;

export default function CaptureViewPage() {
  const params = useParams();
  const router = useRouter();
  const periodId = params.service_id as string;
  const supabase = createClient();

  const [access, setAccess] = useState<UserHierarchyAccess | null>(null);
  const [period, setPeriod] = useState<Period | null>(null);
  const [items, setItems] = useState<LineItem[]>([]);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [officers, setOfficers] = useState<Officer[]>([]);
  const [activeTab, setActiveTab] = useState<TabKey>("Members");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const ua = await getUserAccess();
      if (!ua) { setLoading(false); return; }
      setAccess(ua);

      const { data: p } = await supabase.from("cashbook_period").select("*").eq("id", periodId).single();
      if (!p) { setLoading(false); return; }
      setPeriod(p);

      const [li, att, off] = await Promise.all([
        supabase.from("cashbook_line_item").select("id, section, officer_id, item_type, amount, is_officer, receipt_number, manual_reference, transaction_date, payment_type").eq("period_id", periodId),
        supabase.from("cashbook_attachment").select("id, line_item_id, file_url, transaction_date, bank_reference"),
        supabase.from("officers").select("id, officer_code").eq("congregation_id", p.congregation_id).eq("is_active", true),
      ]);
      setItems(li.data ?? []);
      const ids = new Set((li.data ?? []).map((i: LineItem) => i.id));
      setAttachments((att.data ?? []).filter((a: Attachment) => ids.has(a.line_item_id)));
      setOfficers(off.data ?? []);
      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [periodId]);

  const getAtt = (id: string) => attachments.find(a => a.line_item_id === id);
  const getOfficerCode = (id: string | null) => { if (!id) return "—"; return officers.find(o => o.id === id)?.officer_code ?? "—"; };

  const tabItems = (tab: TabKey) => {
    switch (tab) {
      case "Members": return items.filter(i => i.section === "Members" && !i.is_officer);
      case "Officers": return items.filter(i => i.section === "Officers" && i.is_officer);
      case "Burial": return items.filter(i => i.item_type === "Burial");
      case "Expenses": return items.filter(i => i.item_type === "Expense");
      case "Banking": return items.filter(i => ["EFT","DirectDebit","CashBanked"].includes(i.item_type));
      default: return [];
    }
  };

  // Totals
  const membersT = items.filter(i => !i.is_officer && ["EFT","Cash","DirectDebit","CashBanked","CashPending"].includes(i.item_type)).reduce((s,i)=>s+Number(i.amount),0);
  const officersT = items.filter(i => i.is_officer && ["EFT","Cash","DirectDebit","CashBanked","CashPending"].includes(i.item_type)).reduce((s,i)=>s+Number(i.amount),0);
  const burialT = items.filter(i => i.item_type === "Burial").reduce((s,i)=>s+Number(i.amount),0);
  const expensesT = items.filter(i => i.item_type === "Expense").reduce((s,i)=>s+Number(i.amount),0);
  const grandIncome = membersT + officersT + burialT;

  // Back navigation based on role
  function handleBack() {
    const role = access?.role;
    if (role === "Elder") router.push("/elder");
    else if (role === "Chairperson") router.push("/chairperson");
    else router.push("/treasurer");
  }

  if (loading) return <div className="p-6 text-sm text-muted-foreground">Loading...</div>;
  if (!period) return <div className="p-6 text-sm text-destructive">Period not found.</div>;

  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

  return (
    <div className="max-w-5xl mx-auto px-4 py-4 space-y-4">
      <div className="flex items-center justify-between">
        <Button variant="outline" size="sm" onClick={handleBack}>← Back</Button>
        <Badge variant={period.status === "AuditApproved" ? "default" : "secondary"} className="text-[10px]">
          {period.status === "AuditApproved" ? "Approved" : period.status}
        </Badge>
      </div>

      {/* Period Info */}
      <div className="rounded-md bg-blue-50 border border-blue-200 px-4 py-3">
        <p className="text-sm font-bold text-blue-800">
          {months[period.month - 1]} {period.year} — Week {period.week} ({period.service})
        </p>
        <p className="text-[10px] text-blue-600">Read-only view</p>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-3 gap-2">
        <Card className="bg-blue-50 border-blue-200"><CardContent className="py-2 px-3 text-center"><p className="text-[10px] uppercase text-blue-600 font-medium">EFT</p><p className="text-sm font-bold text-blue-900">R{items.filter(i=>i.item_type==="EFT").reduce((s,i)=>s+Number(i.amount),0).toFixed(2)}</p></CardContent></Card>
        <Card className="bg-blue-50 border-blue-200"><CardContent className="py-2 px-3 text-center"><p className="text-[10px] uppercase text-blue-600 font-medium">Direct Debit</p><p className="text-sm font-bold text-blue-900">R{items.filter(i=>i.item_type==="DirectDebit").reduce((s,i)=>s+Number(i.amount),0).toFixed(2)}</p></CardContent></Card>
        <Card className="bg-blue-50 border-blue-200"><CardContent className="py-2 px-3 text-center"><p className="text-[10px] uppercase text-blue-600 font-medium">Cash</p><p className="text-sm font-bold text-blue-900">R{items.filter(i=>["Cash","CashBanked","CashPending"].includes(i.item_type)).reduce((s,i)=>s+Number(i.amount),0).toFixed(2)}</p></CardContent></Card>
      </div>

      {/* Tabs */}
      <div className="flex gap-1 border-b">
        {TABS.map(t => (
          <button key={t} onClick={() => setActiveTab(t)} className={`px-4 py-2 text-xs font-medium border-b-2 transition-colors ${activeTab === t ? "border-primary font-bold text-primary" : "border-transparent text-muted-foreground hover:text-foreground"}`}>
            {t} ({tabItems(t).length})
          </button>
        ))}
      </div>

      {/* Tab Content */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-xs">{activeTab}</CardTitle></CardHeader>
        <CardContent>
          {tabItems(activeTab).length === 0 && activeTab !== "Banking" ? (
            <p className="text-xs text-muted-foreground">No {activeTab.toLowerCase()} entries.</p>
          ) : activeTab === "Banking" ? (
            <div className="space-y-4">
              {/* Electronic Banking */}
              {(() => {
                const ddItems = items.filter(i => i.item_type === "DirectDebit" && ["Members","Officers"].includes(i.section));
                const eftItems = items.filter(i => i.item_type === "EFT" && ["Members","Officers"].includes(i.section));
                const cbItems = items.filter(i => i.item_type === "CashBanked");
                const renderGroup = (groupItems: LineItem[], label: string) => groupItems.length === 0 ? null : (<>
                  {groupItems.map(item => { const att = getAtt(item.id); return (
                    <tr key={item.id} className="border-b last:border-0">
                      <td className="py-1.5 pr-2">{att?.transaction_date ?? item.transaction_date ?? "—"}</td>
                      <td className="py-1.5 pr-2">{item.item_type === "DirectDebit" ? "Direct Debit" : item.item_type}</td>
                      <td className="py-1.5 pr-2 text-right font-medium">R{Number(item.amount).toFixed(2)}</td>
                      <td className="py-1.5 pr-2">{getOfficerCode(item.officer_id)}</td>
                      <td className="py-1.5"><Clip has={!!att} url={att?.file_url} /></td>
                    </tr>); })}
                  <tr className="bg-muted/50 font-bold border-t"><td colSpan={2} className="py-1.5 pl-2 text-[11px]">Subtotal {label}</td><td className="py-1.5 text-right text-[11px]">R{groupItems.reduce((s,i)=>s+Number(i.amount),0).toFixed(2)}</td><td colSpan={2}></td></tr>
                </>);
                const bankingTotal = [...ddItems, ...eftItems, ...cbItems].reduce((s,i)=>s+Number(i.amount),0);
                return (
                  <table className="w-full text-xs">
                    <thead><tr className="border-b text-muted-foreground text-left"><th className="pb-1 pr-2">Date on Proof</th><th className="pb-1 pr-2">Type</th><th className="pb-1 pr-2 text-right">Amount</th><th className="pb-1 pr-2">Officer</th><th className="pb-1">Proof</th></tr></thead>
                    <tbody>
                      {renderGroup(ddItems, "Direct Debit")}
                      {renderGroup(eftItems, "EFT")}
                      {renderGroup(cbItems, "Cash Banked")}
                      <tr className="font-bold border-t"><td colSpan={2} className="py-2">BANKING TOTAL</td><td className="py-2 text-right">R{bankingTotal.toFixed(2)}</td><td colSpan={2}></td></tr>
                    </tbody>
                  </table>
                );
              })()}

              {/* Cash Pending */}
              {(() => {
                const cashIncomeItems = items.filter(i => ["Cash","CashPending"].includes(i.item_type) && ["Members","Officers"].includes(i.section));
                const cashBurialItems = items.filter(i => i.item_type === "Burial");
                const cashIncomeTotal = cashIncomeItems.reduce((s, i) => s + Number(i.amount), 0);
                const cashBurialTotal = cashBurialItems.reduce((s, i) => s + Number(i.amount), 0);
                const cashTotal = cashIncomeTotal + cashBurialTotal;
                if (cashIncomeItems.length === 0 && cashBurialItems.length === 0) return null;
                return (
                  <div className="border-t pt-3">
                    <p className="text-xs font-bold mb-2">Cash Pending</p>
                    <table className="w-full text-xs">
                      <thead><tr className="border-b text-muted-foreground text-left"><th className="pb-1 pr-2">Source</th><th className="pb-1 pr-2">Entries</th><th className="pb-1 text-right">Amount</th></tr></thead>
                      <tbody>
                        {cashIncomeItems.length > 0 && <tr className="border-b"><td className="py-2 font-medium">Cash Income</td><td className="py-2 text-muted-foreground">{cashIncomeItems.length}</td><td className="py-2 text-right font-medium">R{cashIncomeTotal.toFixed(2)}</td></tr>}
                        {cashBurialItems.length > 0 && <tr className="border-b"><td className="py-2 font-medium">Cash Burial</td><td className="py-2 text-muted-foreground">{cashBurialItems.length} ({cashBurialItems.map(i=>i.receipt_number||"—").join(", ")})</td><td className="py-2 text-right font-medium">R{cashBurialTotal.toFixed(2)}</td></tr>}
                        <tr className="font-bold border-t bg-muted/30"><td className="py-2">TOTAL CASH</td><td></td><td className="py-2 text-right">R{cashTotal.toFixed(2)}</td></tr>
                      </tbody>
                    </table>
                  </div>
                );
              })()}
            </div>
          ) : activeTab === "Burial" ? (
            <table className="w-full text-xs">
              <thead><tr className="border-b text-muted-foreground text-left"><th className="pb-1 pr-2">Receipt</th><th className="pb-1 pr-2 text-right">Amount</th><th className="pb-1">Proof</th></tr></thead>
              <tbody>
                {tabItems("Burial").map(item => { const att = getAtt(item.id); return (
                  <tr key={item.id} className="border-b last:border-0">
                    <td className="py-1.5 pr-2 font-medium">{item.receipt_number ?? "—"}</td>
                    <td className="py-1.5 pr-2 text-right font-medium">R{Number(item.amount).toFixed(2)}</td>
                    <td className="py-1.5"><Clip has={!!att} url={att?.file_url} /></td>
                  </tr>); })}
                <tr className="font-bold border-t"><td className="py-2">TOTAL</td><td className="py-2 text-right">R{burialT.toFixed(2)}</td><td></td></tr>
              </tbody>
            </table>
          ) : activeTab === "Expenses" ? (
            <table className="w-full text-xs">
              <thead><tr className="border-b text-muted-foreground text-left"><th className="pb-1">Description</th><th className="pb-1 text-right pr-2">Amount</th><th className="pb-1">Proof</th></tr></thead>
              <tbody>
                {tabItems("Expenses").map(item => { const att = getAtt(item.id); return (
                  <tr key={item.id} className="border-b last:border-0">
                    <td className="py-1.5 pr-2">{item.manual_reference ?? "—"}</td>
                    <td className="py-1.5 pr-2 text-right font-medium">R{Number(item.amount).toFixed(2)}</td>
                    <td className="py-1.5"><Clip has={!!att} url={att?.file_url} /></td>
                  </tr>); })}
                <tr className="font-bold border-t"><td className="py-2">TOTAL</td><td className="py-2 text-right">R{expensesT.toFixed(2)}</td><td></td></tr>
              </tbody>
            </table>
          ) : (
            /* Members / Officers */
            <table className="w-full text-xs">
              <thead><tr className="border-b text-muted-foreground text-left"><th className="pb-1 pr-2">Officer</th><th className="pb-1 pr-2">Type</th><th className="pb-1 pr-2 text-right">Amount</th><th className="pb-1">Proof</th></tr></thead>
              <tbody>
                {tabItems(activeTab).map(item => { const att = getAtt(item.id); return (
                  <tr key={item.id} className="border-b last:border-0">
                    <td className="py-1.5 pr-2">{getOfficerCode(item.officer_id)}</td>
                    <td className="py-1.5 pr-2">{item.item_type === "DirectDebit" ? "Direct Debit" : item.item_type}</td>
                    <td className="py-1.5 pr-2 text-right font-medium">R{Number(item.amount).toFixed(2)}</td>
                    <td className="py-1.5"><Clip has={!!att} url={att?.file_url} /></td>
                  </tr>); })}
                <tr className="font-bold border-t"><td colSpan={2} className="py-2">TOTAL</td><td className="py-2 text-right">R{tabItems(activeTab).reduce((s,i)=>s+Number(i.amount),0).toFixed(2)}</td><td></td></tr>
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
            <span className="font-bold text-lg text-primary">R{(grandIncome - expensesT).toFixed(2)}</span>
          </div>
          <div className="flex gap-4 mt-1 text-[10px] text-muted-foreground">
            <span>Members: R{membersT.toFixed(2)}</span>
            <span>Officers: R{officersT.toFixed(2)}</span>
            <span>Burial: R{burialT.toFixed(2)}</span>
            <span>Expenses: R{expensesT.toFixed(2)}</span>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
