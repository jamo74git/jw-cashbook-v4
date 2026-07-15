"use client";

import { useEffect, useState, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import { getUserAccess, hasPermission, isOverrideAction, logSelfReviewException } from "@/lib/permissions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import type { Role, UserHierarchyAccess } from "@/lib/types";

// ─── Types ──────────────────────────────────────────────────────────────────
interface Period { id: string; congregation_id: string; year: number; month: number; week: number; service: string; status: string; }
interface LineItem { id: string; period_id: string; section: string; officer_id: string | null; item_type: string; amount: number; proof_status: string | null; payment_type: string | null; manual_reference: string | null; receipt_number: string | null; is_officer: boolean; }
interface Attachment { id: string; line_item_id: string; file_url: string; transaction_date: string | null; bank_reference: string | null; }
interface Officer { id: string; officer_code: string; first_name: string; last_name: string | null; }

type TabKey = "Members" | "Officers" | "Burial" | "Expenses" | "Banking";
const TABS: TabKey[] = ["Members", "Officers", "Burial", "Expenses", "Banking"];

function calcWeek() {
  const today = new Date(), y = today.getFullYear(), m = today.getMonth() + 1;
  const sundays: Date[] = [];
  for (let d = 1; d <= new Date(y, m, 0).getDate(); d++) { if (new Date(y, m - 1, d).getDay() === 0) sundays.push(new Date(y, m - 1, d)); }
  let week = 1;
  for (let i = 1; i < sundays.length; i++) { if (today >= sundays[i]) week = i; }
  return { year: y, month: m, week };
}

function needsProof(item: LineItem): boolean {
  return ["EFT", "DirectDeposit", "Burial", "Expense"].includes(item.item_type);
}

export default function CapturePage() {
  const supabase = createClient();
  const [access, setAccess] = useState<UserHierarchyAccess | null>(null);
  const [period, setPeriod] = useState<Period | null>(null);
  const [items, setItems] = useState<LineItem[]>([]);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [officers, setOfficers] = useState<Officer[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [isMobile, setIsMobile] = useState(false);
  const [activeTab, setActiveTab] = useState<TabKey>("Members");

  // Capture bar state
  const [capOfficerId, setCapOfficerId] = useState("");
  const [capType, setCapType] = useState("Cash");
  const [capAmount, setCapAmount] = useState("");
  const [capRef, setCapRef] = useState("");
  const [activeOfficerId, setActiveOfficerId] = useState<string | null>(null);

  // Proof modal state
  const [proofModal, setProofModal] = useState<{ itemId: string; type: string } | null>(null);
  const [proofDate, setProofDate] = useState("");
  const [proofBankRef, setProofBankRef] = useState("");
  const [proofFile, setProofFile] = useState<File | null>(null);

  const role = access?.role as Role | undefined;
  const isDraft = period?.status === "Draft";
  const canEdit = !!(role && hasPermission(role, "capture.edit") && isDraft);
  const canSubmit = !!(role && hasPermission(role, "capture.submit") && isDraft);

  useEffect(() => { const c = () => setIsMobile(window.innerWidth < 768); c(); window.addEventListener("resize", c); return () => window.removeEventListener("resize", c); }, []);

  // ── Load ──────────────────────────────────────────────────────────────────
  const load = useCallback(async () => {
    setLoading(true); setError(null);
    const ua = await getUserAccess();
    if (!ua?.congregation_id) { setError("No congregation assigned."); setLoading(false); return; }
    setAccess(ua);
    const { year, month, week } = calcWeek();
    let { data: p } = await supabase.from("cashbook_period").select("*").eq("congregation_id", ua.congregation_id).eq("year", year).eq("month", month).eq("week", week).eq("service", "AM").maybeSingle();
    if (!p) {
      const { data: { user } } = await supabase.auth.getUser();
      const { data: np } = await supabase.from("cashbook_period").insert({ congregation_id: ua.congregation_id, year, month, week, service: "AM", status: "Draft", submitted_by: user?.id }).select("*").single();
      p = np;
    }
    if (!p) { setError("Failed to load period."); setLoading(false); return; }
    setPeriod(p);
    const [li, att, off] = await Promise.all([
      supabase.from("cashbook_line_item").select("*").eq("period_id", p.id),
      supabase.from("cashbook_attachment").select("*"),
      supabase.from("officers").select("id, officer_code, first_name, last_name").eq("congregation_id", ua.congregation_id).eq("is_active", true).order("officer_code"),
    ]);
    setItems(li.data ?? []);
    const ids = new Set((li.data ?? []).map((i: LineItem) => i.id));
    setAttachments((att.data ?? []).filter((a: Attachment) => ids.has(a.line_item_id)));
    setOfficers(off.data ?? []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  // ── Tab Filter Logic ──────────────────────────────────────────────────────
  function tabItems(tab: TabKey): LineItem[] {
    switch (tab) {
      case "Members": return items.filter(i => !i.is_officer && ["EFT", "Cash", "DirectDeposit"].includes(i.item_type));
      case "Officers": return items.filter(i => i.is_officer && ["EFT", "Cash", "DirectDeposit"].includes(i.item_type));
      case "Burial": return items.filter(i => i.item_type === "Burial");
      case "Expenses": return items.filter(i => i.item_type === "Expense");
      case "Banking": return items.filter(i => ["EFT", "DirectDeposit", "CashBanked"].includes(i.item_type));
      default: return [];
    }
  }

  // ── CRUD ──────────────────────────────────────────────────────────────────
  async function handleAddCapture() {
    if (!period || !canEdit || !capAmount) return;
    const amt = parseFloat(capAmount);
    if (isNaN(amt) || amt <= 0) return;
    const isOfficerTab = activeTab === "Officers";
    const itemType = activeTab === "Burial" ? "Burial" : activeTab === "Expenses" ? "Expense" : capType;
    await supabase.from("cashbook_line_item").insert({
      period_id: period.id, section: isOfficerTab ? "Officers" : activeTab === "Burial" ? "Burial" : activeTab === "Expenses" ? "Expenses" : "Members",
      item_type: itemType, amount: amt, officer_id: capOfficerId || null, is_officer: isOfficerTab,
      payment_type: itemType, receipt_number: activeTab === "Burial" ? capRef : null,
      manual_reference: activeTab === "Expenses" ? capRef : null, proof_status: null,
    });
    setCapAmount(""); setCapRef("");
    if (capOfficerId) setActiveOfficerId(capOfficerId);
    await load();
  }

  async function deleteRow(id: string) {
    if (!canEdit) return;
    await supabase.from("cashbook_attachment").delete().eq("line_item_id", id);
    await supabase.from("cashbook_line_item").delete().eq("id", id);
    await load();
  }

  // ── Proof Modal Save ──────────────────────────────────────────────────────
  async function saveProof() {
    if (!proofModal || !proofFile || !period || !canEdit) return;
    const { itemId, type } = proofModal;
    // Require date for EFT/DD/Cash
    if (["EFT", "DirectDeposit", "Cash", "CashPending"].includes(type) && !proofDate) return;
    const path = `proofs/${period.id}/${itemId}_${Date.now()}.jpg`;
    await supabase.storage.from("burial_proofs").upload(path, proofFile);
    const { data: u } = supabase.storage.from("burial_proofs").getPublicUrl(path);
    const { data: { user } } = await supabase.auth.getUser();
    await supabase.from("cashbook_attachment").insert({
      line_item_id: itemId, file_url: u.publicUrl, uploaded_by: user?.id,
      transaction_date: proofDate || null, bank_reference: proofBankRef || null,
    });
    await supabase.from("cashbook_line_item").update({ proof_status: "uploaded" }).eq("id", itemId);
    // If Cash proof with date → mark as CashBanked
    if (type === "Cash" || type === "CashPending") {
      await supabase.from("cashbook_line_item").update({ item_type: "CashBanked", payment_type: "CashBanked" }).eq("id", itemId);
    }
    setProofModal(null); setProofDate(""); setProofBankRef(""); setProofFile(null);
    await load();
  }

  async function handleSubmit() {
    if (!period || !access || !canSubmit) return;
    if (role && isOverrideAction(role, "capture.submit")) {
      if (!window.confirm("You are submitting as Treasurer. SELF_REVIEW_EXCEPTION will be logged. Continue?")) return;
      await logSelfReviewException({ userId: access.user_id, entityType: "cashbook_period", entityId: period.id, assumedRole: "Treasurer" });
    }
    setSubmitting(true);
    await supabase.from("cashbook_period").update({ status: "Submitted", submitted_at: new Date().toISOString() }).eq("id", period.id);
    setSuccess("Submitted for Audit."); setSubmitting(false); await load();
  }

  // ── Computed ──────────────────────────────────────────────────────────────
  const hasProof = (id: string) => attachments.some(a => a.line_item_id === id);
  const getAttachment = (id: string) => attachments.find(a => a.line_item_id === id);
  const missingProofs = items.filter(i => needsProof(i) && !hasProof(i.id));
  const sumByType = (t: string) => items.filter(i => i.item_type === t).reduce((s, i) => s + Number(i.amount), 0);
  const membersTotal = items.filter(i => !i.is_officer && ["EFT","Cash","DirectDeposit","CashBanked"].includes(i.item_type)).reduce((s,i)=>s+Number(i.amount),0);
  const officersTotal = items.filter(i => i.is_officer && ["EFT","Cash","DirectDeposit","CashBanked"].includes(i.item_type)).reduce((s,i)=>s+Number(i.amount),0);
  const burialTotal = items.filter(i => i.item_type === "Burial").reduce((s,i)=>s+Number(i.amount),0);
  const expensesTotal = items.filter(i => i.item_type === "Expense").reduce((s,i)=>s+Number(i.amount),0);
  const grandIncome = membersTotal + officersTotal + burialTotal;

  // Grouped for Members/Officers tally
  const grouped = (tab: TabKey) => {
    const map = new Map<string, { officer: Officer | null; items: LineItem[] }>();
    tabItems(tab).forEach(item => {
      const key = item.officer_id ?? "__none__";
      if (!map.has(key)) map.set(key, { officer: officers.find(o => o.id === item.officer_id) ?? null, items: [] });
      map.get(key)!.items.push(item);
    });
    return Array.from(map.values());
  };

  const activeOfficer = officers.find(o => o.id === activeOfficerId);
  const activeItems = activeOfficerId ? tabItems(activeTab).filter(i => i.officer_id === activeOfficerId) : [];

  if (loading) return <div className="p-6 text-muted-foreground text-sm">Loading...</div>;
  if (error) return <div className="p-6 text-destructive text-sm">{error}</div>;

  // ═══════════════════════════════════════════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════════════════════════════════════════
  return (
    <div className="max-w-[1400px] mx-auto px-2 sm:px-4 py-2 pb-24">
      {/* Header */}
      <div className="flex items-center justify-between mb-2 text-xs">
        <span className="font-medium">Week {period?.week} · {period?.service} · {period?.year}/{String(period?.month).padStart(2,"0")}</span>
        <Badge variant={isDraft ? "outline" : "secondary"} className="text-[10px]">{period?.status}</Badge>
      </div>
      {success && <div className="rounded border border-green-300 bg-green-50 p-2 text-xs text-green-800 mb-2">{success}</div>}

      {/* ═══ TABS ═══ */}
      <div className="flex gap-1 overflow-x-auto mb-3 pb-1">
        {TABS.map(tab => (
          <button key={tab} onClick={() => { setActiveTab(tab); setActiveOfficerId(null); }}
            className={`px-3 py-1.5 rounded-md text-xs font-medium whitespace-nowrap transition-colors ${activeTab === tab ? "bg-blue-600 text-white font-bold shadow-sm" : "bg-muted text-muted-foreground hover:bg-muted/80"}`}>
            {tab} ({tabItems(tab).length})
          </button>
        ))}
      </div>

      {/* ═══ MAIN LAYOUT ═══ */}
      <div className="grid gap-3 md:grid-cols-[1fr_280px]">
        {/* LEFT: Active Tab Content */}
        <div className="min-w-0 space-y-3">

          {/* ─── CAPTURE BAR (not for Banking tab) ─── */}
          {canEdit && activeTab !== "Banking" && (
            <div className="sticky top-12 z-30 bg-background border rounded-lg p-2 shadow-sm">
              <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto_auto_auto] gap-2 items-end">
                {/* Members/Officers: Officer select */}
                {(activeTab === "Members" || activeTab === "Officers") && (
                  <select className="h-9 rounded border border-input bg-background px-2 text-xs" value={capOfficerId} onChange={e => { setCapOfficerId(e.target.value); setActiveOfficerId(e.target.value || null); }}>
                    <option value="">Select Officer...</option>
                    {officers.map(o => <option key={o.id} value={o.id}>{o.officer_code} - {o.first_name}</option>)}
                  </select>
                )}
                {/* Burial: Receipt # */}
                {activeTab === "Burial" && (
                  <Input className="h-9 text-xs" placeholder="Receipt Number" value={capRef} onChange={e => setCapRef(e.target.value)} />
                )}
                {/* Expenses: Description */}
                {activeTab === "Expenses" && (
                  <Input className="h-9 text-xs" placeholder="Description" value={capRef} onChange={e => setCapRef(e.target.value)} />
                )}
                {/* Type (Members/Officers only) */}
                {(activeTab === "Members" || activeTab === "Officers") && (
                  <select className="h-9 w-28 rounded border border-input bg-background px-2 text-xs" value={capType} onChange={e => setCapType(e.target.value)}>
                    <option value="EFT">EFT</option><option value="Cash">Cash</option><option value="DirectDeposit">DirectDeposit</option>
                  </select>
                )}
                {/* Amount */}
                <div className="relative w-28">
                  <span className="absolute left-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">R</span>
                  <Input type="number" step="0.01" className="h-9 text-xs pl-5 text-right" placeholder="0.00" value={capAmount} onChange={e => setCapAmount(e.target.value)} onKeyDown={e => { if (e.key === "Enter") handleAddCapture(); }} />
                </div>
                {/* Add */}
                <Button size="sm" className="h-9 text-xs" onClick={handleAddCapture}>+ Add</Button>
              </div>
            </div>
          )}

          {/* ─── RUNNING TALLY ─── */}
          {activeOfficerId && activeItems.length > 0 && (activeTab === "Members" || activeTab === "Officers") && (
            <Card className="border-blue-200 bg-blue-50/30">
              <CardHeader className="py-2 px-3"><CardTitle className="text-xs">Capturing: <span className="text-blue-700">{activeOfficer?.officer_code} - {activeOfficer?.first_name}</span></CardTitle></CardHeader>
              <CardContent className="px-3 pb-3 space-y-1">
                {activeItems.map(item => (
                  <div key={item.id} className="flex items-center gap-2 py-1 border-b last:border-0 text-xs">
                    <span className="w-20 font-medium">{item.item_type}</span>
                    <span className="flex-1">R{Number(item.amount).toFixed(2)}</span>
                    <ProofButton item={item} />
                    {canEdit && <button className="text-destructive" onClick={() => deleteRow(item.id)}>✕</button>}
                  </div>
                ))}
                <div className="flex justify-between pt-1 border-t text-xs font-medium">
                  <span>Subtotal: R{activeItems.reduce((s,i)=>s+Number(i.amount),0).toFixed(2)}</span>
                  <Button size="sm" variant="ghost" className="h-6 text-[10px]" onClick={() => setActiveOfficerId(null)}>Done</Button>
                </div>
              </CardContent>
            </Card>
          )}

          {/* ─── TAB CONTENT: Members / Officers ─── */}
          {(activeTab === "Members" || activeTab === "Officers") && (
            <div className="space-y-2">
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] bg-muted/50 rounded px-2 py-1.5">
                {["EFT","Cash","DirectDeposit"].map(t => { const c = tabItems(activeTab).filter(i => i.item_type === t); return <span key={t}>{t}: <b>R{c.reduce((s,i)=>s+Number(i.amount),0).toFixed(2)}</b> ({c.length})</span>; })}
                <span className="ml-auto font-bold">Total: R{tabItems(activeTab).reduce((s,i)=>s+Number(i.amount),0).toFixed(2)}</span>
              </div>
              {grouped(activeTab).map(({ officer, items: gi }) => (
                <details key={officer?.id ?? "none"} className="border rounded-lg overflow-hidden">
                  <summary className="flex items-center justify-between px-3 py-2 bg-muted/20 cursor-pointer text-xs">
                    <span className="font-medium truncate">{officer ? `${officer.officer_code} - ${officer.first_name}` : "Unassigned"}</span>
                    <b className="shrink-0">R{gi.reduce((s,i)=>s+Number(i.amount),0).toFixed(2)}</b>
                  </summary>
                  <div className="px-2 pb-2 pt-1 space-y-1">
                    {gi.map(item => (
                      <div key={item.id} className="flex items-center gap-2 py-1 border-b last:border-0 text-xs">
                        <span className="w-20">{item.item_type}</span>
                        <span className="flex-1 font-medium">R{Number(item.amount).toFixed(2)}</span>
                        <ProofButton item={item} />
                        {canEdit && <button className="text-destructive text-[10px]" onClick={() => deleteRow(item.id)}>✕</button>}
                      </div>
                    ))}
                  </div>
                </details>
              ))}
            </div>
          )}

          {/* ─── TAB CONTENT: Burial ─── */}
          {activeTab === "Burial" && (
            <div className="space-y-2">
              <div className="flex justify-between text-[11px] bg-muted/50 rounded px-2 py-1.5">
                <span>Burial Offerings: <b>{tabItems("Burial").length}</b></span>
                <span className="font-bold">Total: R{tabItems("Burial").reduce((s,i)=>s+Number(i.amount),0).toFixed(2)}</span>
              </div>
              {tabItems("Burial").map(item => (
                <div key={item.id} className="flex items-center gap-2 py-2 border-b last:border-0 text-xs">
                  <span className="w-20 font-medium">{item.receipt_number || "—"}</span>
                  <span className="flex-1">R{Number(item.amount).toFixed(2)}</span>
                  <ProofButton item={item} />
                  {canEdit && <button className="text-destructive" onClick={() => deleteRow(item.id)}>✕</button>}
                </div>
              ))}
            </div>
          )}

          {/* ─── TAB CONTENT: Expenses ─── */}
          {activeTab === "Expenses" && (
            <div className="space-y-2">
              <div className="flex justify-between text-[11px] bg-muted/50 rounded px-2 py-1.5">
                <span>Expenses: <b>{tabItems("Expenses").length}</b></span>
                <span className="font-bold">Total: R{tabItems("Expenses").reduce((s,i)=>s+Number(i.amount),0).toFixed(2)}</span>
              </div>
              {tabItems("Expenses").map(item => (
                <div key={item.id} className="flex items-center gap-2 py-2 border-b last:border-0 text-xs">
                  <span className="flex-1 truncate">{item.manual_reference || "—"}</span>
                  <span className="w-20 text-right font-medium">R{Number(item.amount).toFixed(2)}</span>
                  <ProofButton item={item} />
                  {canEdit && <button className="text-destructive" onClick={() => deleteRow(item.id)}>✕</button>}
                </div>
              ))}
            </div>
          )}

          {/* ─── TAB CONTENT: Banking ─── */}
          {activeTab === "Banking" && (
            <div className="space-y-4">
              {/* Section A: Banking Detail */}
              <Card>
                <CardHeader className="pb-2"><CardTitle className="text-xs">Banking Detail Report</CardTitle></CardHeader>
                <CardContent>
                  <table className="w-full text-xs">
                    <thead><tr className="border-b text-muted-foreground text-left"><th className="pb-1">Date</th><th className="pb-1">Type</th><th className="pb-1 text-right">Amount</th><th className="pb-1">Officer</th><th className="pb-1">Ref</th><th className="pb-1">Proof</th></tr></thead>
                    <tbody>
                      {tabItems("Banking").map(item => {
                        const att = getAttachment(item.id);
                        const off = officers.find(o => o.id === item.officer_id);
                        return (
                          <tr key={item.id} className="border-b last:border-0">
                            <td className="py-1">{att?.transaction_date ?? "—"}</td>
                            <td className="py-1">{item.item_type}</td>
                            <td className="py-1 text-right font-medium">R{Number(item.amount).toFixed(2)}</td>
                            <td className="py-1">{off?.officer_code ?? "—"}</td>
                            <td className="py-1">{att?.bank_reference ?? "—"}</td>
                            <td className="py-1">{att ? <a href={att.file_url} target="_blank" rel="noopener noreferrer" className="text-green-600">📷</a> : <span className="text-destructive">✗</span>}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </CardContent>
              </Card>
              {/* Section B: Cash Management */}
              <Card>
                <CardHeader className="pb-2"><CardTitle className="text-xs">Cash Management</CardTitle></CardHeader>
                <CardContent>
                  {items.filter(i => i.item_type === "Cash" && !i.is_officer).length === 0 && items.filter(i => i.item_type === "Cash" && i.is_officer).length === 0 ? (
                    <p className="text-xs text-muted-foreground">No cash pending.</p>
                  ) : (
                    <div className="space-y-1">
                      {items.filter(i => i.item_type === "Cash").map(item => (
                        <div key={item.id} className="flex items-center gap-2 text-xs py-1 border-b last:border-0">
                          <span className="flex-1">{officers.find(o => o.id === item.officer_id)?.officer_code ?? "Cash"} — R{Number(item.amount).toFixed(2)}</span>
                          <Button size="sm" variant="outline" className="h-7 text-[10px]" onClick={() => setProofModal({ itemId: item.id, type: "Cash" })} disabled={!canEdit}>
                            Mark as Banked
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </CardContent>
              </Card>
            </div>
          )}
        </div>

        {/* ═══ RIGHT PANEL (desktop) ═══ */}
        <div className="hidden md:block space-y-3">
          <Card className="sticky top-14">
            <CardHeader className="pb-1 px-3"><CardTitle className="text-[10px] uppercase tracking-wider text-muted-foreground">Banking Summary</CardTitle></CardHeader>
            <CardContent className="px-3 space-y-2 text-xs">
              <p className="font-bold text-sm">INCOME: R{grandIncome.toFixed(2)}</p>
              <div className="pl-2 space-y-0.5 text-muted-foreground">
                <p>EFT: R{sumByType("EFT").toFixed(2)} ({items.filter(i=>i.item_type==="EFT").length})</p>
                <p>DirectDeposit: R{sumByType("DirectDeposit").toFixed(2)} ({items.filter(i=>i.item_type==="DirectDeposit").length})</p>
                <p>Cash Pending: R{sumByType("Cash").toFixed(2)} ({items.filter(i=>i.item_type==="Cash").length})</p>
                <p>Cash Banked: R{sumByType("CashBanked").toFixed(2)} ({items.filter(i=>i.item_type==="CashBanked").length})</p>
              </div>
              <div className="border-t pt-1"><p className="font-bold text-sm">EXPENSES: R{expensesTotal.toFixed(2)}</p></div>
              <div className="border-t pt-1"><p className="font-bold text-sm text-primary">BALANCE: R{(grandIncome - expensesTotal).toFixed(2)}</p></div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-1 px-3"><CardTitle className="text-[10px] uppercase tracking-wider text-muted-foreground">Totals</CardTitle></CardHeader>
            <CardContent className="px-3 space-y-1 text-xs">
              <div className="flex justify-between"><span>Members</span><b>R{membersTotal.toFixed(2)}</b></div>
              <div className="flex justify-between"><span>Officers</span><b>R{officersTotal.toFixed(2)}</b></div>
              <div className="flex justify-between"><span>Burial</span><b>R{burialTotal.toFixed(2)}</b></div>
              <div className="flex justify-between border-t pt-1 font-bold"><span>Income</span><span>R{grandIncome.toFixed(2)}</span></div>
              <div className="flex justify-between text-muted-foreground"><span>Expenses</span><span>R{expensesTotal.toFixed(2)}</span></div>
              <div className="mt-2"><Badge variant={period?.status === "AuditApproved" ? "default" : "outline"} className="text-[10px]">{period?.status}</Badge></div>
              {missingProofs.length > 0 && isDraft && <p className="text-destructive text-[10px] mt-1">{missingProofs.length} proof(s) missing</p>}
            </CardContent>
          </Card>
        </div>
      </div>

      {/* ═══ MOBILE SUMMARY ═══ */}
      <div className="md:hidden mt-3 rounded bg-muted/50 px-3 py-2 flex justify-between text-xs">
        <span>Income: <b>R{grandIncome.toFixed(2)}</b></span>
        {missingProofs.length > 0 ? <span className="text-destructive">{missingProofs.length} proofs</span> : <span className="text-green-700">✓</span>}
      </div>

      {/* ═══ STICKY FOOTER ═══ */}
      {isDraft && (
        <div className="fixed bottom-0 left-0 right-0 bg-background border-t px-3 py-3 z-40">
          <div className="max-w-[1400px] mx-auto flex items-center justify-between gap-2">
            <span className="text-[11px] text-muted-foreground hidden sm:inline">
              {grandIncome === 0 ? "Add items" : missingProofs.length > 0 ? `${missingProofs.length} proof(s) needed` : "Ready"}
            </span>
            <Button onClick={handleSubmit} disabled={submitting || grandIncome === 0 || missingProofs.length > 0} size="sm" className="flex-1 sm:flex-none">
              {submitting ? "..." : "Submit for Audit"}
            </Button>
          </div>
        </div>
      )}

      {/* ═══ PROOF MODAL ═══ */}
      {proofModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/50" onClick={() => setProofModal(null)} />
          <Card className="relative z-10 w-full max-w-sm">
            <CardHeader className="pb-2"><CardTitle className="text-sm">Capture Proof</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              {["EFT", "DirectDeposit", "Cash", "CashPending"].includes(proofModal.type) && (
                <>
                  <div className="space-y-1">
                    <Label className="text-xs">Date on Proof *</Label>
                    <Input type="date" className="h-9 text-xs" value={proofDate} onChange={e => setProofDate(e.target.value)} required />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Bank Reference</Label>
                    <Input className="h-9 text-xs" placeholder="Bank ref..." value={proofBankRef} onChange={e => setProofBankRef(e.target.value)} />
                  </div>
                </>
              )}
              <div className="space-y-1">
                <Label className="text-xs">Photo *</Label>
                <input type="file" accept="image/*" capture={isMobile ? "environment" : undefined} className="text-xs" onChange={e => setProofFile(e.target.files?.[0] ?? null)} />
              </div>
              <div className="flex gap-2">
                <Button size="sm" onClick={saveProof} disabled={!proofFile || (["EFT","DirectDeposit","Cash","CashPending"].includes(proofModal.type) && !proofDate)}>Save Proof</Button>
                <Button size="sm" variant="outline" onClick={() => setProofModal(null)}>Cancel</Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );

  // ── ProofButton Component ─────────────────────────────────────────────────
  function ProofButton({ item }: { item: LineItem }) {
    const att = getAttachment(item.id);
    if (att) return <a href={att.file_url} target="_blank" rel="noopener noreferrer" className="text-green-600 text-sm" title={att.transaction_date ?? "View"}>📷</a>;
    if (!needsProof(item)) return <span className="text-muted-foreground text-[10px]">—</span>;
    return (
      <button className="relative text-sm" onClick={() => setProofModal({ itemId: item.id, type: item.item_type })} disabled={!canEdit} title="Take photo">
        📷<span className="absolute -top-0.5 -right-0.5 h-1.5 w-1.5 rounded-full bg-destructive" />
      </button>
    );
  }
}
