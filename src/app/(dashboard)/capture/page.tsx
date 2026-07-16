"use client";

import { useEffect, useState, useCallback, useRef } from "react";
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
type FormState = { officerId: string; type: string; amount: string; ref: string; error: string; };

const TABS: TabKey[] = ["Members", "Officers", "Burial", "Expenses", "Banking"];
const EMPTY_FORM: FormState = { officerId: "", type: "Cash", amount: "", ref: "", error: "" };

// ─── OAC Week Logic ─────────────────────────────────────────────────────────
// Week 1 = 2nd Sunday of the month
// Week 2 = 3rd Sunday ... up to Week 4/5
// Last Week of month = 1st Sunday of NEXT month
interface OacWeek { weekKey: string; weekNum: number; date: Date; label: string; }

function getOacWeeks(year: number, month: number): OacWeek[] {
  // Get all Sundays in this month
  const sundays: Date[] = [];
  const daysInMonth = new Date(year, month, 0).getDate();
  for (let d = 1; d <= daysInMonth; d++) {
    const dt = new Date(year, month - 1, d);
    if (dt.getDay() === 0) sundays.push(dt);
  }

  // Get 1st Sunday of NEXT month (last capture week)
  const nextMonth = month === 12 ? 1 : month + 1;
  const nextYear = month === 12 ? year + 1 : year;
  for (let d = 1; d <= 7; d++) {
    const dt = new Date(nextYear, nextMonth - 1, d);
    if (dt.getDay() === 0) { sundays.push(dt); break; }
  }

  // Week 1 starts at 2nd Sunday (index 1), last week = 1st Sunday of next month
  const weeks: OacWeek[] = [];
  for (let i = 1; i < sundays.length; i++) {
    const dt = sundays[i];
    const weekNum = i; // Week 1, 2, 3, 4, (5)
    const monthNames = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    const label = `${monthNames[month - 1]} ${year} - Week ${weekNum} [${String(dt.getDate()).padStart(2,"0")} ${monthNames[dt.getMonth()]}]`;
    weeks.push({
      weekKey: `${year}-${String(month).padStart(2,"0")}-W${weekNum}`,
      weekNum, date: dt, label,
    });
  }
  return weeks;
}

function getCurrentWeekKey(): { year: number; month: number; weekKey: string } {
  const today = new Date();
  const y = today.getFullYear(), m = today.getMonth() + 1;
  const weeks = getOacWeeks(y, m);
  // Find the week where today >= that Sunday but < next Sunday
  let current = weeks[0];
  for (let i = 0; i < weeks.length; i++) {
    if (today >= weeks[i].date) current = weeks[i];
  }
  return { year: y, month: m, weekKey: current?.weekKey ?? `${y}-${String(m).padStart(2,"0")}-W1` };
}

function needsProof(item: LineItem): boolean { return ["EFT", "DirectDeposit", "Burial", "Expense"].includes(item.item_type); }
function officerLabel(o: Officer): string { return `${o.officer_code} - ${o.first_name}${o.last_name ? " " + o.last_name : ""}`; }

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
  const [selectedService, setSelectedService] = useState<"AM" | "PM">("AM");
  const [selectedWeekKey, setSelectedWeekKey] = useState<string>("");
  const [availableWeeks, setAvailableWeeks] = useState<OacWeek[]>([]);
  const [activeOfficerId, setActiveOfficerId] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  // ── Per-tab isolated form state ───────────────────────────────────────────
  const [forms, setForms] = useState<Record<TabKey, FormState>>({
    Members: { ...EMPTY_FORM, type: "Cash" },
    Officers: { ...EMPTY_FORM, type: "Cash" },
    Burial: { ...EMPTY_FORM },
    Expenses: { ...EMPTY_FORM },
    Banking: { ...EMPTY_FORM },
  });
  const form = forms[activeTab];
  const setForm = (patch: Partial<FormState>) => setForms(prev => ({ ...prev, [activeTab]: { ...prev[activeTab], ...patch } }));

  // Proof modal
  const [proofModal, setProofModal] = useState<{ itemId: string; type: string } | null>(null);
  const [proofDate, setProofDate] = useState("");
  const [proofBankRef, setProofBankRef] = useState("");
  const [proofFile, setProofFile] = useState<File | null>(null);

  const role = access?.role as Role | undefined;
  const isDraft = period?.status === "Draft";
  const canEdit = !!(role && hasPermission(role, "capture.edit") && isDraft);
  const canSubmit = !!(role && hasPermission(role, "capture.submit") && isDraft);
  const congIdRef = useRef<string | null>(null);

  useEffect(() => { const c = () => setIsMobile(window.innerWidth < 768); c(); window.addEventListener("resize", c); return () => window.removeEventListener("resize", c); }, []);

  // Toast auto-dismiss
  useEffect(() => { if (toast) { const t = setTimeout(() => setToast(null), 3000); return () => clearTimeout(t); } }, [toast]);

  // ── Load via RPC ──────────────────────────────────────────────────────────
  const load = useCallback(async (svc?: "AM" | "PM", wk?: string) => {
    setLoading(true); setError(null);
    const ua = await getUserAccess();
    if (!ua?.congregation_id) { setError("No congregation assigned."); setLoading(false); return; }
    setAccess(ua);
    congIdRef.current = ua.congregation_id;
    const service = svc ?? selectedService;

    // Calculate available weeks + current week
    const { year, month, weekKey: currentWk } = getCurrentWeekKey();
    const weeks = getOacWeeks(year, month);
    setAvailableWeeks(weeks);
    const weekKey = wk ?? (selectedWeekKey || currentWk);
    if (!selectedWeekKey) setSelectedWeekKey(weekKey);

    // Use RPC to get or create period
    const { data: { user } } = await supabase.auth.getUser();
    const { data: p, error: rpcErr } = await supabase.rpc("get_or_create_period", {
      p_congregation_id: ua.congregation_id,
      p_week_key: weekKey,
      p_service: service,
      p_user_id: user?.id,
    });

    if (rpcErr || !p) {
      // Fallback if RPC not deployed
      setError(`Period error: ${rpcErr?.message ?? "RPC not found"}. Run rpc_get_or_create_period.sql.`);
      setLoading(false);
      return;
    }
    setPeriod(p);

    const [li, att, off] = await Promise.all([
      supabase.from("cashbook_line_item").select("*").eq("period_id", p.id),
      supabase.from("cashbook_attachment").select("*"),
      supabase.from("officers").select("id, officer_code, first_name, last_name").eq("congregation_id", ua.congregation_id).eq("is_active", true).order("officer_code"),
    ]);
    // Filter out orphan rows (officer_id=null for Members/Officers)
    const validItems = (li.data ?? []).filter((i: LineItem) =>
      !(i.officer_id === null && ["EFT","Cash","DirectDeposit"].includes(i.item_type) && ["Members","Officers"].includes(i.section))
    );
    setItems(validItems);
    const ids = new Set(validItems.map((i: LineItem) => i.id));
    setAttachments((att.data ?? []).filter((a: Attachment) => ids.has(a.line_item_id)));
    setOfficers(off.data ?? []);
    setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => { load(); }, [load]);

  function handleServiceChange(svc: "AM" | "PM") {
    setSelectedService(svc);
    setActiveOfficerId(null);
    load(svc, selectedWeekKey);
  }

  function handleWeekChange(wk: string) {
    setSelectedWeekKey(wk);
    setActiveOfficerId(null);
    load(selectedService, wk);
  }

  function handleTabChange(tab: TabKey) {
    setActiveTab(tab);
    setActiveOfficerId(null);
    // Form state is already isolated per tab - no reset needed
  }

  // ── Tab filter ────────────────────────────────────────────────────────────
  function tabItems(tab: TabKey): LineItem[] {
    switch (tab) {
      case "Members": return items.filter(i => !i.is_officer && ["EFT","Cash","DirectDeposit","CashBanked","CashPending"].includes(i.item_type));
      case "Officers": return items.filter(i => i.is_officer && ["EFT","Cash","DirectDeposit","CashBanked","CashPending"].includes(i.item_type));
      case "Burial": return items.filter(i => i.item_type === "Burial");
      case "Expenses": return items.filter(i => i.item_type === "Expense");
      case "Banking": return items.filter(i => ["EFT","DirectDeposit","CashBanked"].includes(i.item_type));
      default: return [];
    }
  }

  // ── Validation (per tab, uses isolated form state) ────────────────────────
  function getValidationError(): string | null {
    const amt = parseFloat(form.amount);
    if (activeTab === "Members" || activeTab === "Officers") {
      if (!form.officerId) return "Please select Officer before adding amount";
      if (!form.amount || isNaN(amt) || amt <= 0) return "Amount must be greater than 0";
    }
    if (activeTab === "Burial") {
      if (!form.ref.trim()) return "Receipt Number is required";
      if (!form.amount || isNaN(amt) || amt <= 0) return "Amount must be greater than 0";
    }
    if (activeTab === "Expenses") {
      if (!form.ref.trim()) return "Description is required";
      if (!form.amount || isNaN(amt) || amt <= 0) return "Amount must be greater than 0";
    }
    return null;
  }

  // ── Fast refetch (line items only, no full reload) ─────────────────────────
  async function refetchItems() {
    if (!period) return;
    const { data: li } = await supabase.from("cashbook_line_item").select("*").eq("period_id", period.id);
    const validItems = (li ?? []).filter((i: LineItem) =>
      !(i.officer_id === null && ["EFT","Cash","DirectDeposit"].includes(i.item_type) && ["Members","Officers"].includes(i.section))
    );
    setItems(validItems);
    const ids = new Set(validItems.map((i: LineItem) => i.id));
    const { data: att } = await supabase.from("cashbook_attachment").select("*");
    setAttachments((att ?? []).filter((a: Attachment) => ids.has(a.line_item_id)));
  }

  // ── CRUD ──────────────────────────────────────────────────────────────────
  async function handleAddCapture() {
    if (!period || !canEdit) return;
    const err = getValidationError();
    if (err) { setForm({ error: err }); setToast(err); return; }
    setForm({ error: "" });
    const amt = parseFloat(form.amount);
    const isOfficerTab = activeTab === "Officers";
    const itemType = activeTab === "Burial" ? "Burial" : activeTab === "Expenses" ? "Expense" : form.type;

    await supabase.from("cashbook_line_item").insert({
      period_id: period.id,
      section: isOfficerTab ? "Officers" : activeTab === "Burial" ? "Burial" : activeTab === "Expenses" ? "Expenses" : "Members",
      item_type: itemType, amount: amt, officer_id: form.officerId || null, is_officer: isOfficerTab,
      payment_type: itemType, receipt_number: activeTab === "Burial" ? form.ref.trim() : null,
      manual_reference: activeTab === "Expenses" ? form.ref.trim() : null, proof_status: null,
    });
    // Reset amount + ref (keep officer for rapid entry)
    setForm({ amount: "", ref: "", error: "" });
    if (form.officerId) setActiveOfficerId(form.officerId);
    // Fast refetch for immediate totals update
    await refetchItems();
  }

  async function deleteRow(id: string) {
    if (!canEdit) return;
    await supabase.from("cashbook_attachment").delete().eq("line_item_id", id);
    await supabase.from("cashbook_line_item").delete().eq("id", id);
    await refetchItems();
  }

  // ── Proof Modal ───────────────────────────────────────────────────────────
  async function saveProof() {
    if (!proofModal || !proofFile || !period || !canEdit) return;
    const { itemId, type } = proofModal;
    if (["EFT","DirectDeposit","Cash","CashPending"].includes(type) && !proofDate) return;
    const path = `proofs/${period.id}/${itemId}_${Date.now()}.jpg`;
    await supabase.storage.from("burial_proofs").upload(path, proofFile);
    const { data: u } = supabase.storage.from("burial_proofs").getPublicUrl(path);
    const { data: { user } } = await supabase.auth.getUser();
    await supabase.from("cashbook_attachment").insert({
      line_item_id: itemId, file_url: u.publicUrl, uploaded_by: user?.id,
      transaction_date: proofDate || null, bank_reference: proofBankRef || null,
    });
    await supabase.from("cashbook_line_item").update({ proof_status: "uploaded" }).eq("id", itemId);
    // Cash/CashPending → CashBanked on proof upload
    if (type === "Cash" || type === "CashPending") {
      await supabase.from("cashbook_line_item").update({ item_type: "CashBanked", payment_type: "CashBanked" }).eq("id", itemId);
    }
    setProofModal(null); setProofDate(""); setProofBankRef(""); setProofFile(null);
    await refetchItems();
  }

  async function handleSubmit() {
    if (!period || !access || !canSubmit) return;
    if (role && isOverrideAction(role, "capture.submit")) {
      if (!window.confirm("SELF_REVIEW_EXCEPTION will be logged. Continue?")) return;
      await logSelfReviewException({ userId: access.user_id, entityType: "cashbook_period", entityId: period.id, assumedRole: "Treasurer" });
    }
    setSubmitting(true);
    await supabase.from("cashbook_period").update({ status: "Submitted", submitted_at: new Date().toISOString() }).eq("id", period.id);
    setSuccess("Submitted for Audit."); setSubmitting(false); await load();
  }

  // ── Computed ──────────────────────────────────────────────────────────────
  const hasProof = (id: string) => attachments.some(a => a.line_item_id === id);
  const getAtt = (id: string) => attachments.find(a => a.line_item_id === id);
  const missingProofs = items.filter(i => needsProof(i) && !hasProof(i.id));
  const sumType = (t: string) => items.filter(i => i.item_type === t).reduce((s, i) => s + Number(i.amount), 0);
  const membersT = items.filter(i => !i.is_officer && !["Burial","Expense"].includes(i.item_type)).reduce((s,i)=>s+Number(i.amount),0);
  const officersT = items.filter(i => i.is_officer).reduce((s,i)=>s+Number(i.amount),0);
  const burialT = items.filter(i => i.item_type === "Burial").reduce((s,i)=>s+Number(i.amount),0);
  const expensesT = items.filter(i => i.item_type === "Expense").reduce((s,i)=>s+Number(i.amount),0);
  const grandIncome = membersT + officersT + burialT;
  const grouped = (tab: TabKey) => { const m = new Map<string, { officer: Officer|null; items: LineItem[] }>(); tabItems(tab).forEach(i => { const k = i.officer_id ?? "__none__"; if (!m.has(k)) m.set(k, { officer: officers.find(o => o.id === i.officer_id) ?? null, items: [] }); m.get(k)!.items.push(i); }); return Array.from(m.values()); };
  const activeOfficer = officers.find(o => o.id === activeOfficerId);
  const activeItems = activeOfficerId ? tabItems(activeTab).filter(i => i.officer_id === activeOfficerId) : [];

  if (loading) return <div className="p-6 text-muted-foreground text-sm">Loading...</div>;
  if (error) return <div className="p-6 text-destructive text-sm">{error}</div>;

  // ═══════════════════════════════════════════════════════════════════════════
  return (
    <div className="max-w-[1400px] mx-auto px-2 sm:px-4 py-2 pb-24">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 mb-3 flex-wrap">
        <div className="flex items-center gap-2 text-xs flex-wrap">
          {/* Week Selector */}
          <select className="h-7 rounded border border-input bg-background px-2 text-xs font-medium max-w-[220px]" value={selectedWeekKey} onChange={e => handleWeekChange(e.target.value)}>
            {availableWeeks.map(w => <option key={w.weekKey} value={w.weekKey}>{w.label}</option>)}
          </select>
          {/* AM/PM */}
          <select className="h-7 rounded border border-input bg-background px-2 text-xs font-bold w-16" value={selectedService} onChange={e => handleServiceChange(e.target.value as "AM"|"PM")}>
            <option value="AM">AM</option><option value="PM">PM</option>
          </select>
        </div>
        <Badge variant={isDraft ? "outline" : "secondary"} className="text-[10px]">{period?.status}</Badge>
      </div>
      {success && <div className="rounded border border-green-300 bg-green-50 p-2 text-xs text-green-800 mb-2">{success}</div>}
      {toast && <div className="fixed top-16 left-1/2 -translate-x-1/2 z-50 bg-destructive text-destructive-foreground px-4 py-2 rounded-md text-xs shadow-lg">{toast}</div>}

      {/* Tabs */}
      <div className="flex gap-1 overflow-x-auto mb-2 pb-1">
        {TABS.map(tab => (
          <button key={tab} onClick={() => handleTabChange(tab)}
            className={`px-3 py-1.5 rounded-md text-xs font-medium whitespace-nowrap transition-colors ${activeTab === tab ? "bg-blue-600 text-white font-bold shadow-sm" : "bg-muted text-muted-foreground hover:bg-muted/80"}`}>
            {tab} ({tabItems(tab).length})
          </button>
        ))}
      </div>

      {/* ─── RUNNING TOTALS BANNER ─── */}
      {(activeTab === "Members" || activeTab === "Officers") && (
        <div className="grid grid-cols-3 gap-2 mb-3">
          {["EFT", "DirectDeposit", "Cash"].map(t => {
            const filtered = tabItems(activeTab).filter(i => i.item_type === t);
            const total = filtered.reduce((s, i) => s + Number(i.amount), 0);
            return (
              <Card key={t} className="bg-blue-50 border-blue-200">
                <CardContent className="py-2 px-3 text-center">
                  <p className="text-[10px] uppercase text-blue-600 font-medium">{t === "DirectDeposit" ? "Direct Deposit" : t}</p>
                  <p className="text-sm font-bold text-blue-900">R{total.toFixed(2)}</p>
                  <p className="text-[10px] text-blue-500">{filtered.length} {filtered.length === 1 ? "entry" : "entries"}</p>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <div className="grid gap-3 md:grid-cols-[1fr_280px]">
        <div className="min-w-0 space-y-3">

          {/* ─── CAPTURE BAR (isolated per tab) ─── */}
          {canEdit && activeTab !== "Banking" && (
            <div className="sticky top-12 z-30 bg-background border rounded-lg p-2 shadow-sm">
              <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto_auto_auto] gap-2 items-end">
                {(activeTab === "Members" || activeTab === "Officers") && (
                  <select className="h-9 rounded border border-input bg-background px-2 text-xs" value={form.officerId} onChange={e => { setForm({ officerId: e.target.value, error: "" }); setActiveOfficerId(e.target.value || null); }}>
                    <option value="">Select Officer *</option>
                    {officers.map(o => <option key={o.id} value={o.id}>{officerLabel(o)}</option>)}
                  </select>
                )}
                {activeTab === "Burial" && (
                  <Input className="h-9 text-xs" placeholder="Receipt Number *" value={form.ref} onChange={e => setForm({ ref: e.target.value, error: "" })} />
                )}
                {activeTab === "Expenses" && (
                  <Input className="h-9 text-xs" placeholder="Description *" value={form.ref} onChange={e => setForm({ ref: e.target.value, error: "" })} />
                )}
                {(activeTab === "Members" || activeTab === "Officers") && (
                  <select className="h-9 w-28 rounded border border-input bg-background px-2 text-xs" value={form.type} onChange={e => setForm({ type: e.target.value })}>
                    <option value="EFT">EFT</option><option value="Cash">Cash</option><option value="DirectDeposit">DirectDeposit</option>
                  </select>
                )}
                <div className="relative w-28">
                  <span className="absolute left-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">R</span>
                  <Input type="number" step="0.01" className="h-9 text-xs pl-5 text-right" placeholder="0.00" value={form.amount} onChange={e => setForm({ amount: e.target.value, error: "" })} onKeyDown={e => { if (e.key === "Enter") handleAddCapture(); }} />
                </div>
                <Button size="sm" className="h-9 text-xs" onClick={handleAddCapture} disabled={!!getValidationError()}>+ Add</Button>
              </div>
              {form.error && <p className="text-destructive text-[11px] mt-1">{form.error}</p>}
            </div>
          )}

          {/* ─── RUNNING TALLY ─── */}
          {activeOfficerId && activeItems.length > 0 && (activeTab === "Members" || activeTab === "Officers") && (
            <Card className="border-blue-200 bg-blue-50/30">
              <CardHeader className="py-2 px-3"><CardTitle className="text-xs">Capturing: <span className="text-blue-700">{activeOfficer ? officerLabel(activeOfficer) : ""}</span></CardTitle></CardHeader>
              <CardContent className="px-3 pb-3 space-y-1">
                {activeItems.map(item => (
                  <div key={item.id} className="flex items-center gap-2 py-1 border-b last:border-0 text-xs">
                    <span className="w-20 font-medium">{item.item_type}</span>
                    <span className="flex-1">R{Number(item.amount).toFixed(2)}</span>
                    <ProofBtn item={item} />
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

          {/* ─── MEMBERS / OFFICERS LIST ─── */}
          {(activeTab === "Members" || activeTab === "Officers") && (
            <div className="space-y-2">
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] bg-muted/50 rounded px-2 py-1.5">
                {["EFT","Cash","DirectDeposit"].map(t => { const c = tabItems(activeTab).filter(i => i.item_type === t); return c.length > 0 ? <span key={t}>{t}: <b>R{c.reduce((s,i)=>s+Number(i.amount),0).toFixed(2)}</b> ({c.length})</span> : null; })}
                <span className="ml-auto font-bold">Total: R{tabItems(activeTab).reduce((s,i)=>s+Number(i.amount),0).toFixed(2)}</span>
              </div>
              {grouped(activeTab).map(({ officer, items: gi }) => (
                <details key={officer?.id ?? "none"} className="border rounded-lg overflow-hidden">
                  <summary className="flex items-center justify-between px-3 py-2 bg-muted/20 cursor-pointer text-xs">
                    <span className="font-medium truncate max-w-[40%]">{officer ? officerLabel(officer) : "Unassigned"}</span>
                    <b className="shrink-0 text-right">R{gi.reduce((s,i)=>s+Number(i.amount),0).toFixed(2)}</b>
                  </summary>
                  <div className="px-2 pb-2 pt-1 space-y-1">
                    {gi.map(item => (
                      <div key={item.id} className="flex items-center gap-2 py-1 border-b last:border-0 text-xs">
                        <span className="w-20">{item.item_type}</span>
                        <span className="flex-1 font-medium">R{Number(item.amount).toFixed(2)}</span>
                        <ProofBtn item={item} />
                        {canEdit && <button className="text-destructive text-[10px]" onClick={() => deleteRow(item.id)}>✕</button>}
                      </div>
                    ))}
                  </div>
                </details>
              ))}
            </div>
          )}

          {/* ─── BURIAL ─── */}
          {activeTab === "Burial" && (
            <div className="space-y-2">
              <div className="flex justify-between text-[11px] bg-muted/50 rounded px-2 py-1.5">
                <span>Entries: <b>{tabItems("Burial").length}</b></span>
                <span className="font-bold">Total: R{burialT.toFixed(2)}</span>
              </div>
              {tabItems("Burial").map(item => (
                <div key={item.id} className="flex items-center gap-2 py-2 border-b last:border-0 text-xs">
                  <span className="w-20 font-medium">{item.receipt_number || "—"}</span>
                  <span className="flex-1">R{Number(item.amount).toFixed(2)}</span>
                  <ProofBtn item={item} />
                  {canEdit && <button className="text-destructive" onClick={() => deleteRow(item.id)}>✕</button>}
                </div>
              ))}
            </div>
          )}

          {/* ─── EXPENSES ─── */}
          {activeTab === "Expenses" && (
            <div className="space-y-2">
              <div className="flex justify-between text-[11px] bg-muted/50 rounded px-2 py-1.5">
                <span>Entries: <b>{tabItems("Expenses").length}</b></span>
                <span className="font-bold">Total: R{expensesT.toFixed(2)}</span>
              </div>
              {tabItems("Expenses").map(item => (
                <div key={item.id} className="flex items-center gap-2 py-2 border-b last:border-0 text-xs">
                  <span className="flex-1 truncate max-w-[200px]">{item.manual_reference || "—"}</span>
                  <span className="w-[120px] text-right font-medium shrink-0">R{Number(item.amount).toFixed(2)}</span>
                  <ProofBtn item={item} />
                  {canEdit && <button className="text-destructive" onClick={() => deleteRow(item.id)}>✕</button>}
                </div>
              ))}
            </div>
          )}

          {/* ─── BANKING (read-only + CashPending actions) ─── */}
          {activeTab === "Banking" && (
            <div className="space-y-4">
              <Card>
                <CardHeader className="pb-2"><CardTitle className="text-xs">Banking Detail Report</CardTitle></CardHeader>
                <CardContent>
                  {tabItems("Banking").length === 0 ? <p className="text-xs text-muted-foreground">No banked items.</p> : (
                    <div className="overflow-x-auto"><table className="w-full text-xs">
                      <thead><tr className="border-b text-muted-foreground text-left"><th className="pb-1 pr-2">Date</th><th className="pb-1 pr-2">Type</th><th className="pb-1 pr-2 text-right">Amount</th><th className="pb-1 pr-2">Name</th><th className="pb-1 pr-2">Ref</th><th className="pb-1">Proof</th></tr></thead>
                      <tbody>{tabItems("Banking").map(item => { const att = getAtt(item.id); const off = officers.find(o => o.id === item.officer_id); return (
                        <tr key={item.id} className="border-b last:border-0">
                          <td className="py-1.5 pr-2">{att?.transaction_date ?? "—"}</td>
                          <td className="py-1.5 pr-2">{item.item_type}</td>
                          <td className="py-1.5 pr-2 text-right font-medium">R{Number(item.amount).toFixed(2)}</td>
                          <td className="py-1.5 pr-2 truncate max-w-[100px]">{off ? officerLabel(off) : "—"}</td>
                          <td className="py-1.5 pr-2">{att?.bank_reference ?? "—"}</td>
                          <td className="py-1.5">{att ? <a href={att.file_url} target="_blank" rel="noopener noreferrer" className="text-green-600">📷</a> : <span className="text-destructive">✗</span>}</td>
                        </tr>); })}</tbody>
                    </table></div>
                  )}
                </CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2"><CardTitle className="text-xs">Cash Management</CardTitle></CardHeader>
                <CardContent>
                  {(() => { const pending = items.filter(i => i.item_type === "Cash" || i.item_type === "CashPending"); return pending.length === 0 ? <p className="text-xs text-muted-foreground">All cash banked.</p> : (
                    <div className="space-y-1.5">{pending.map(item => { const off = officers.find(o => o.id === item.officer_id); return (
                      <div key={item.id} className="flex items-center gap-2 text-xs py-1.5 border-b last:border-0">
                        <span className="flex-1 truncate">{off ? officerLabel(off) : "Cash"} — R{Number(item.amount).toFixed(2)}</span>
                        <Button size="sm" variant="outline" className="h-7 text-[10px] shrink-0" onClick={() => setProofModal({ itemId: item.id, type: "CashPending" })} disabled={!canEdit}>
                          Mark as Banked
                        </Button>
                      </div>); })}</div>
                  ); })()}
                </CardContent>
              </Card>
            </div>
          )}
        </div>

        {/* ═══ RIGHT PANEL ═══ */}
        <div className="hidden md:block space-y-3">
          <Card className="sticky top-14">
            <CardHeader className="pb-1 px-3"><CardTitle className="text-[10px] uppercase tracking-wider text-muted-foreground">Banking Summary</CardTitle></CardHeader>
            <CardContent className="px-3 space-y-2 text-xs">
              <p className="font-bold text-sm">INCOME: R{grandIncome.toFixed(2)}</p>
              <div className="pl-2 space-y-0.5 text-muted-foreground">
                <p>EFT: R{sumType("EFT").toFixed(2)} ({items.filter(i=>i.item_type==="EFT").length})</p>
                <p>DirectDeposit: R{sumType("DirectDeposit").toFixed(2)} ({items.filter(i=>i.item_type==="DirectDeposit").length})</p>
                <p>Cash Pending: R{(sumType("Cash")+sumType("CashPending")).toFixed(2)} ({items.filter(i=>["Cash","CashPending"].includes(i.item_type)).length})</p>
                <p>Cash Banked: R{sumType("CashBanked").toFixed(2)} ({items.filter(i=>i.item_type==="CashBanked").length})</p>
              </div>
              <div className="border-t pt-1"><p className="font-bold text-sm">EXPENSES: R{expensesT.toFixed(2)}</p></div>
              <div className="border-t pt-1"><p className="font-bold text-sm text-primary">BALANCE: R{(grandIncome - expensesT).toFixed(2)}</p></div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-1 px-3"><CardTitle className="text-[10px] uppercase tracking-wider text-muted-foreground">Totals</CardTitle></CardHeader>
            <CardContent className="px-3 space-y-1 text-xs">
              <div className="flex justify-between"><span>Members</span><b>R{membersT.toFixed(2)}</b></div>
              <div className="flex justify-between"><span>Officers</span><b>R{officersT.toFixed(2)}</b></div>
              <div className="flex justify-between"><span>Burial</span><b>R{burialT.toFixed(2)}</b></div>
              <div className="flex justify-between border-t pt-1 font-bold"><span>Income</span><span>R{grandIncome.toFixed(2)}</span></div>
              <div className="flex justify-between text-muted-foreground"><span>Expenses</span><span>R{expensesT.toFixed(2)}</span></div>
              <div className="mt-2"><Badge variant={period?.status === "AuditApproved" ? "default" : "outline"} className="text-[10px]">{period?.status}</Badge></div>
              {missingProofs.length > 0 && isDraft && <p className="text-destructive text-[10px] mt-1">{missingProofs.length} proof(s) missing</p>}
            </CardContent>
          </Card>
        </div>
      </div>

      {/* Mobile summary */}
      <div className="md:hidden mt-3 rounded bg-muted/50 px-3 py-2 flex justify-between text-xs">
        <span>Income: <b>R{grandIncome.toFixed(2)}</b></span>
        {missingProofs.length > 0 ? <span className="text-destructive">{missingProofs.length} proofs</span> : <span className="text-green-700">✓</span>}
      </div>

      {/* Sticky Footer */}
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

      {/* Proof Modal */}
      {proofModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div className="absolute inset-0 bg-black/50" onClick={() => setProofModal(null)} />
          <Card className="relative z-10 w-full max-w-sm">
            <CardHeader className="pb-2"><CardTitle className="text-sm">
              {["Cash","CashPending"].includes(proofModal.type) ? "Mark Cash as Banked" : "Capture Proof"}
            </CardTitle></CardHeader>
            <CardContent className="space-y-3">
              {["EFT","DirectDeposit","Cash","CashPending"].includes(proofModal.type) && (
                <>
                  <div className="space-y-1">
                    <Label className="text-xs">{["Cash","CashPending"].includes(proofModal.type) ? "Deposit Date *" : "Date on Proof *"}</Label>
                    <Input type="date" className="h-9 text-xs" value={proofDate} onChange={e => setProofDate(e.target.value)} required />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Bank Reference</Label>
                    <Input className="h-9 text-xs" placeholder="Ref..." value={proofBankRef} onChange={e => setProofBankRef(e.target.value)} />
                  </div>
                </>
              )}
              <div className="space-y-1">
                <Label className="text-xs">{["Cash","CashPending"].includes(proofModal.type) ? "Deposit Slip Photo *" : "Proof Photo *"}</Label>
                <input type="file" accept="image/*" capture={isMobile ? "environment" : undefined} className="text-xs" onChange={e => setProofFile(e.target.files?.[0] ?? null)} />
              </div>
              <div className="flex gap-2">
                <Button size="sm" onClick={saveProof} disabled={!proofFile || (["EFT","DirectDeposit","Cash","CashPending"].includes(proofModal.type) && !proofDate)}>
                  {["Cash","CashPending"].includes(proofModal.type) ? "Mark as Banked" : "Save Proof"}
                </Button>
                <Button size="sm" variant="outline" onClick={() => setProofModal(null)}>Cancel</Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );

  function ProofBtn({ item }: { item: LineItem }) {
    const att = getAtt(item.id);
    if (att) return <a href={att.file_url} target="_blank" rel="noopener noreferrer" className="text-green-600 text-sm" title={att.transaction_date ?? "View"}>📷</a>;
    if (!needsProof(item)) return <span className="text-muted-foreground text-[10px]">—</span>;
    return (
      <button className="relative text-sm" onClick={() => setProofModal({ itemId: item.id, type: item.item_type })} disabled={!canEdit}>
        📷<span className="absolute -top-0.5 -right-0.5 h-1.5 w-1.5 rounded-full bg-destructive" />
      </button>
    );
  }
}
