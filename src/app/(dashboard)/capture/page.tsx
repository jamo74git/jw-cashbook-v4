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

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIG — now loaded from congregation_settings (see loadPeriod)
// ═══════════════════════════════════════════════════════════════════════════════
let PROOF_MANDATORY = false; // Overridden at runtime from DB

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════
interface Period { id: string; congregation_id: string; year: number; month: number; week: number; service: string; status: string; week_key: string | null; }
interface LineItem { id: string; period_id: string; section: string; officer_id: string | null; item_type: string; amount: number; proof_status: string | null; payment_type: string | null; manual_reference: string | null; receipt_number: string | null; is_officer: boolean; }
interface Attachment { id: string; line_item_id: string; file_url: string; transaction_date: string | null; bank_reference: string | null; }
interface Officer { id: string; officer_code: string; first_name: string; last_name: string | null; }
type TabKey = "Members" | "Officers" | "Burial" | "Expenses" | "Banking";
type FormState = { officerId: string; type: string; amount: string; ref: string; error: string; txnDate: string; txnRef: string; proofFile: File | null };

const TABS: TabKey[] = ["Members", "Officers", "Burial", "Expenses", "Banking"];

// ═══════════════════════════════════════════════════════════════════════════════
// OAC WEEK LOGIC
// Week 1 = 2nd Sunday. Last week = 1st Sunday of NEXT month.
// ═══════════════════════════════════════════════════════════════════════════════
interface OacWeek { weekKey: string; weekNum: number; date: Date; label: string }

function getOacWeeks(year: number, month: number): OacWeek[] {
  const sundays: Date[] = [];
  for (let d = 1; d <= new Date(year, month, 0).getDate(); d++) {
    if (new Date(year, month - 1, d).getDay() === 0) sundays.push(new Date(year, month - 1, d));
  }
  // Add 1st Sunday of next month
  const nm = month === 12 ? 1 : month + 1, ny = month === 12 ? year + 1 : year;
  for (let d = 1; d <= 7; d++) { if (new Date(ny, nm - 1, d).getDay() === 0) { sundays.push(new Date(ny, nm - 1, d)); break; } }
  const mn = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const weeks: OacWeek[] = [];
  for (let i = 1; i < sundays.length; i++) {
    const dt = sundays[i];
    weeks.push({ weekKey: `${year}-${String(month).padStart(2,"0")}-W${i}`, weekNum: i, date: dt,
      label: `${mn[month-1]} ${year} - Week ${i} [${String(dt.getDate()).padStart(2,"0")} ${mn[dt.getMonth()]}]` });
  }
  return weeks;
}

function getCurrentWeekKey(): { year: number; month: number; weekKey: string } {
  const today = new Date(), y = today.getFullYear(), m = today.getMonth() + 1;
  const weeks = getOacWeeks(y, m);
  let current = weeks[0];
  for (const w of weeks) { if (today >= w.date) current = w; }
  return { year: y, month: m, weekKey: current?.weekKey ?? `${y}-${String(m).padStart(2,"0")}-W1` };
}

function needsProof(item: LineItem): boolean { return ["EFT","DirectDebit","Burial","Expense"].includes(item.item_type); }
function officerLabel(o: Officer): string { return `${o.officer_code} - ${o.first_name}${o.last_name ? " " + o.last_name : ""}`; }

// ── Client-side image compression (no dependencies) ─────────────────────────
// Resizes to max 1920px and compresses to 80% JPEG quality
// Typical result: 5-8MB phone photo → 200-400KB
async function compressImage(file: File, maxWidth = 1920, quality = 0.8): Promise<File> {
  // Skip if not an image or already small
  if (!file.type.startsWith("image/") || file.size < 500000) return file;

  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement("canvas");
      let { width, height } = img;
      if (width > maxWidth) { height = (height * maxWidth) / width; width = maxWidth; }
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext("2d");
      ctx?.drawImage(img, 0, 0, width, height);
      canvas.toBlob(
        (blob) => { resolve(blob ? new File([blob], file.name.replace(/\.\w+$/, ".jpg"), { type: "image/jpeg" }) : file); },
        "image/jpeg",
        quality
      );
    };
    img.onerror = () => resolve(file); // fallback: use original
    img.src = URL.createObjectURL(file);
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════
export default function CapturePage() {
  const supabase = createClient();

  // ── Core State ────────────────────────────────────────────────────────────
  const [access, setAccess] = useState<UserHierarchyAccess | null>(null);
  const [period, setPeriod] = useState<Period | null>(null);
  const [items, setItems] = useState<LineItem[]>([]);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [officers, setOfficers] = useState<Officer[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [success, setSuccess] = useState<string | null>(null);
  const [isMobile, setIsMobile] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  // ── UI State ──────────────────────────────────────────────────────────────
  const [activeTab, setActiveTab] = useState<TabKey>("Members");
  const [selectedService, setSelectedService] = useState<"AM"|"PM">("AM");
  const [selectedWeekKey, setSelectedWeekKey] = useState("");
  const [availableWeeks, setAvailableWeeks] = useState<OacWeek[]>([]);
  const [activeOfficerId, setActiveOfficerId] = useState<string | null>(null);

  // ── Isolated form state per tab ───────────────────────────────────────────
  const [forms, setForms] = useState<Record<TabKey, FormState>>({
    Members: { officerId: "", type: "Cash", amount: "", ref: "", error: "", txnDate: "", txnRef: "", proofFile: null },
    Officers: { officerId: "", type: "Cash", amount: "", ref: "", error: "", txnDate: "", txnRef: "", proofFile: null },
    Burial: { officerId: "", type: "Cash", amount: "", ref: "", error: "", txnDate: "", txnRef: "", proofFile: null },
    Expenses: { officerId: "", type: "Expense", amount: "", ref: "", error: "", txnDate: "", txnRef: "", proofFile: null },
    Banking: { officerId: "", type: "", amount: "", ref: "", error: "", txnDate: "", txnRef: "", proofFile: null },
  });
  const form = forms[activeTab];
  const setForm = (p: Partial<FormState>) => setForms(prev => ({ ...prev, [activeTab]: { ...prev[activeTab], ...p } }));

  // ── Proof modal ───────────────────────────────────────────────────────────
  const [proofModal, setProofModal] = useState<{ itemId: string; type: string } | null>(null);
  const [proofDate, setProofDate] = useState("");
  const [proofBankRef, setProofBankRef] = useState("");
  const [proofFile, setProofFile] = useState<File | null>(null);

  // ── Derived ───────────────────────────────────────────────────────────────
  const role = access?.role as Role | undefined;
  const isEditable = period?.status === "Draft" || period?.status === "Rejected";
  const canEdit = !!(role && hasPermission(role, "capture.edit") && isEditable);
  const canSubmit = !!(role && hasPermission(role, "capture.submit") && isEditable);
  const isDraft = isEditable; // For UI display purposes

  useEffect(() => { const c = () => setIsMobile(window.innerWidth < 768); c(); window.addEventListener("resize", c); return () => window.removeEventListener("resize", c); }, []);
  useEffect(() => { if (toast) { const t = setTimeout(() => setToast(null), 3000); return () => clearTimeout(t); } }, [toast]);

  // ═══════════════════════════════════════════════════════════════════════════
  // DATA LOADING
  // ═══════════════════════════════════════════════════════════════════════════
  const loadPeriod = useCallback(async (svc?: "AM"|"PM", wk?: string) => {
    setLoading(true); setError(null);
    const ua = await getUserAccess();
    if (!ua?.congregation_id) { setError("No congregation assigned."); setLoading(false); return; }
    setAccess(ua);

    // Load congregation settings (proof_mandatory toggle)
    const { data: settings } = await supabase.from("congregation_settings").select("proof_mandatory").eq("congregation_id", ua.congregation_id).maybeSingle();
    PROOF_MANDATORY = settings?.proof_mandatory ?? false;

    const { year, month, weekKey: curWk } = getCurrentWeekKey();
    const weeks = getOacWeeks(year, month);
    setAvailableWeeks(weeks);
    const weekKey = wk ?? (selectedWeekKey || curWk);
    if (!selectedWeekKey) setSelectedWeekKey(weekKey);
    const service = svc ?? selectedService;

    const { data: { user } } = await supabase.auth.getUser();
    const { data: p, error: rpcErr } = await supabase.rpc("get_or_create_period", {
      p_congregation_id: ua.congregation_id, p_week_key: weekKey, p_service: service, p_user_id: user?.id,
    });
    if (rpcErr || !p) { setError(`Period error: ${rpcErr?.message ?? "Run rpc_get_or_create_period.sql"}`); setLoading(false); return; }
    setPeriod(p);

    // Fetch officers (once)
    const { data: off } = await supabase.from("officers").select("id, officer_code, first_name, last_name")
      .eq("congregation_id", ua.congregation_id).eq("is_active", true).order("officer_code");
    setOfficers(off ?? []);

    // Fetch line items + attachments
    await refetchItems(p.id);
    setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Fast refetch: only line items + attachments. Called after every mutation.
  async function refetchItems(periodId?: string) {
    const pid = periodId ?? period?.id;
    if (!pid) return;
    const { data: li } = await supabase.from("cashbook_line_item").select("*").eq("period_id", pid);
    // Filter orphans: Members/Officers must have officer_id
    const valid = (li ?? []).filter((i: LineItem) =>
      !(i.officer_id === null && ["EFT","Cash","DirectDebit"].includes(i.item_type) && ["Members","Officers"].includes(i.section))
    );
    setItems(valid);
    const ids = new Set(valid.map((i: LineItem) => i.id));
    const { data: att } = await supabase.from("cashbook_attachment").select("*");
    setAttachments((att ?? []).filter((a: Attachment) => ids.has(a.line_item_id)));
  }

  useEffect(() => { loadPeriod(); }, [loadPeriod]);

  // ═══════════════════════════════════════════════════════════════════════════
  // TAB FILTERING
  // ═══════════════════════════════════════════════════════════════════════════
  function tabItems(tab: TabKey): LineItem[] {
    switch (tab) {
      case "Members": return items.filter(i => i.section === "Members" && !i.is_officer);
      case "Officers": return items.filter(i => i.section === "Officers" && i.is_officer);
      case "Burial": return items.filter(i => i.item_type === "Burial");
      case "Expenses": return items.filter(i => i.item_type === "Expense");
      case "Banking": return items.filter(i => ["EFT","DirectDebit","CashBanked"].includes(i.item_type));
      default: return [];
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // VALIDATION
  // ═══════════════════════════════════════════════════════════════════════════
  function getValidationError(): string | null {
    const amt = parseFloat(form.amount);
    if (activeTab === "Members" || activeTab === "Officers") {
      if (!form.officerId) return "Please select Officer before adding";
      if (!form.amount || isNaN(amt) || amt <= 0) return "Amount must be > 0";
      // EFT/DirectDeposit require date + proof
      if (["EFT", "DirectDebit"].includes(form.type)) {
        if (!form.txnDate) return `${form.type === "EFT" ? "EFT Date" : "Deposit Date"} is required`;
        if (PROOF_MANDATORY && !form.proofFile) return "Proof upload is required for EFT/Direct Deposit";
      }
    }
    if (activeTab === "Burial") {
      if (!form.ref.trim()) return "Receipt Number is required";
      if (!form.amount || isNaN(amt) || amt <= 0) return "Amount must be > 0";
    }
    if (activeTab === "Expenses") {
      if (!form.ref.trim()) return "Description is required";
      if (!form.amount || isNaN(amt) || amt <= 0) return "Amount must be > 0";
    }
    return null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MUTATIONS
  // ═══════════════════════════════════════════════════════════════════════════
  async function handleAddCapture() {
    if (!period || !canEdit) return;
    const err = getValidationError();
    if (err) { setForm({ error: err }); setToast(err); return; }
    setForm({ error: "" });
    const amt = parseFloat(form.amount);

    // ── CRITICAL: section + is_officer must match the active tab ──
    const section = activeTab === "Officers" ? "Officers"
                  : activeTab === "Burial" ? "Burial"
                  : activeTab === "Expenses" ? "Expenses"
                  : "Members";
    const isOfficer = activeTab === "Officers";
    const itemType = activeTab === "Burial" ? "Burial" : activeTab === "Expenses" ? "Expense" : form.type;

    // Set transaction_date:
    // - EFT/DD: from form date field (required)
    // - Burial: forced to today (governance requirement)
    // - Expenses: from form date field (user can pick)
    // - Cash: today
    let txnDate: string;
    if (["EFT", "DirectDebit"].includes(itemType)) {
      txnDate = form.txnDate;
    } else if (itemType === "Burial") {
      txnDate = new Date().toISOString().split("T")[0]; // forced today
    } else if (itemType === "Expense") {
      txnDate = form.txnDate || new Date().toISOString().split("T")[0]; // user picks or default today
    } else {
      txnDate = new Date().toISOString().split("T")[0]; // Cash = today
    }

    // Insert line item with transaction_date and proof_reference
    const { data: newItem, error: insertErr } = await supabase.from("cashbook_line_item").insert({
      period_id: period.id,
      section,
      is_officer: isOfficer,
      item_type: itemType,
      amount: amt,
      officer_id: form.officerId || null,
      payment_type: itemType,
      receipt_number: activeTab === "Burial" ? form.ref.trim() : null,
      manual_reference: activeTab === "Expenses" ? form.ref.trim() : null,
      proof_status: null,
      transaction_date: txnDate || null,
      proof_reference: ["EFT", "DirectDebit"].includes(itemType) ? (form.txnRef || null) : null,
    }).select("id").single();

    if (insertErr) { setToast(`Save failed: ${insertErr.message}`); return; }

    // Upload proof if file provided (EFT/DD inline upload) — separate from insert
    if (newItem && form.proofFile && ["EFT", "DirectDebit"].includes(itemType)) {
      try {
        const { data: { user } } = await supabase.auth.getUser();
        const congId = access?.congregation_id ?? period.congregation_id;
        const compressed = await compressImage(form.proofFile);
        const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
        const ext = compressed.name.split(".").pop() ?? "jpg";
        const storagePath = `${congId}/${period.year}/${String(period.month).padStart(2,"0")}/${period.service}_${period.week_key ?? period.week}/${user?.id}/${ts}-proof.${ext}`;
        await supabase.storage.from("cashbook-proofs").upload(storagePath, compressed);
        const { data: u } = supabase.storage.from("cashbook-proofs").getPublicUrl(storagePath);
        await supabase.from("cashbook_attachment").insert({
          line_item_id: newItem.id, file_url: u.publicUrl, uploaded_by: user?.id,
          transaction_date: txnDate || null, bank_reference: form.txnRef || null, congregation_id: congId,
        });
        await supabase.from("cashbook_line_item").update({ proof_status: "uploaded" }).eq("id", newItem.id);
      } catch { /* Proof upload failed but line item is saved */ }
    }

    // Reset form — keep officerId to maintain tally view
    const keepOfficer = form.officerId;
    setForm({ amount: "", ref: "", error: "", txnDate: "", txnRef: "", proofFile: null });
    if (keepOfficer) setActiveOfficerId(keepOfficer);
    await refetchItems();

    if (["EFT", "DirectDebit"].includes(itemType) && !form.proofFile && !PROOF_MANDATORY) {
      setToast("Reminder: Upload proof for EFT/DD entries");
    }
  }

  async function deleteRow(id: string) {
    if (!canEdit) return;
    await supabase.from("cashbook_attachment").delete().eq("line_item_id", id);
    await supabase.from("cashbook_line_item").delete().eq("id", id);
    await refetchItems();
  }

  async function saveProof() {
    if (!proofModal || !proofFile || !period || !canEdit) return;
    const { itemId, type } = proofModal;
    if (["EFT","DirectDebit","Cash","CashPending"].includes(type) && !proofDate) return;

    // Build storage path + compress image
    const { data: { user } } = await supabase.auth.getUser();
    const congId = access?.congregation_id ?? period.congregation_id;
    const compressed = await compressImage(proofFile);
    const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
    const ext = compressed.name.split(".").pop() ?? "jpg";
    const storagePath = `${congId}/${period.year}/${String(period.month).padStart(2,"0")}/${period.service}_${period.week_key ?? period.week}/${user?.id}/${ts}-proof.${ext}`;

    await supabase.storage.from("cashbook-proofs").upload(storagePath, compressed);
    const { data: u } = supabase.storage.from("cashbook-proofs").getPublicUrl(storagePath);

    await supabase.from("cashbook_attachment").insert({
      line_item_id: itemId,
      file_url: u.publicUrl,
      uploaded_by: user?.id,
      transaction_date: proofDate || null,
      bank_reference: proofBankRef || null,
      congregation_id: congId,
    });
    await supabase.from("cashbook_line_item").update({ proof_status: "uploaded" }).eq("id", itemId);
    if (["Cash","CashPending"].includes(type)) {
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
    setSuccess("Submitted for Audit."); setSubmitting(false);
    await loadPeriod(selectedService, selectedWeekKey);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // COMPUTED VALUES
  // ═══════════════════════════════════════════════════════════════════════════
  const hasProof = (id: string) => attachments.some(a => a.line_item_id === id);
  const getAtt = (id: string) => attachments.find(a => a.line_item_id === id);
  const missingProofs = PROOF_MANDATORY ? items.filter(i => needsProof(i) && !hasProof(i.id)) : [];
  const sumType = (t: string) => items.filter(i => i.item_type === t).reduce((s, i) => s + Number(i.amount), 0);
  const membersT = tabItems("Members").reduce((s, i) => s + Number(i.amount), 0);
  const officersT = tabItems("Officers").reduce((s, i) => s + Number(i.amount), 0);
  const burialT = tabItems("Burial").reduce((s, i) => s + Number(i.amount), 0);
  const expensesT = tabItems("Expenses").reduce((s, i) => s + Number(i.amount), 0);
  const grandIncome = membersT + officersT + burialT;

  const grouped = (tab: TabKey) => {
    const m = new Map<string, { officer: Officer | null; items: LineItem[] }>();
    tabItems(tab).forEach(i => { const k = i.officer_id ?? "__x__"; if (!m.has(k)) m.set(k, { officer: officers.find(o => o.id === i.officer_id) ?? null, items: [] }); m.get(k)!.items.push(i); });
    return Array.from(m.values()).filter(g => g.officer !== null); // Never show Unassigned
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
      {/* Header: Week + Service */}
      <div className="flex items-center justify-between gap-2 mb-2 flex-wrap">
        <div className="flex items-center gap-2 text-xs">
          <select className="h-7 rounded border border-input bg-background px-2 text-xs font-medium max-w-[220px]" value={selectedWeekKey} onChange={e => { setSelectedWeekKey(e.target.value); loadPeriod(selectedService, e.target.value); }}>
            {availableWeeks.map(w => <option key={w.weekKey} value={w.weekKey}>{w.label}</option>)}
          </select>
          <select className="h-7 w-16 rounded border border-input bg-background px-2 text-xs font-bold" value={selectedService} onChange={e => { const s = e.target.value as "AM"|"PM"; setSelectedService(s); loadPeriod(s, selectedWeekKey); }}>
            <option value="AM">AM</option><option value="PM">PM</option>
          </select>
        </div>
        <Badge variant={isDraft ? "outline" : "secondary"} className="text-[10px]">{period?.status}</Badge>
      </div>

      {!isDraft && <div className="rounded border border-green-300 bg-green-100 p-3 text-xs text-green-900 font-medium mb-2">Submitted for Audit. All forms are locked.</div>}
      {toast && <div className="fixed top-16 left-1/2 -translate-x-1/2 z-50 bg-blue-600 text-white px-4 py-2 rounded-md text-xs shadow-lg">{toast}</div>}

      {/* Tabs */}
      <div className="flex gap-1 overflow-x-auto mb-2 pb-1">
        {TABS.map(tab => (
          <button key={tab} onClick={() => { setActiveTab(tab); setActiveOfficerId(null); }}
            className={`px-3 py-1.5 rounded-md text-xs font-medium whitespace-nowrap transition-colors ${activeTab === tab ? "bg-blue-600 text-white font-bold shadow-sm" : "bg-muted text-muted-foreground hover:bg-muted/80"}`}>
            {tab} ({tabItems(tab).length})
          </button>
        ))}
      </div>

      {/* Running Totals Banner (all tabs except Banking) */}
      {activeTab !== "Banking" && (
        <div className="grid grid-cols-3 gap-2 mb-3">
          {["EFT", "DirectDebit", "Cash"].map(t => {
            const filtered = items.filter(i => ["Members","Officers"].includes(i.section) && i.item_type === t);
            return (
              <Card key={t} className="bg-blue-50 border-blue-200">
                <CardContent className="py-2 px-3 text-center">
                  <p className="text-[10px] uppercase text-blue-600 font-medium">{t === "DirectDebit" ? "Direct Deposit" : t}</p>
                  <p className="text-sm font-bold text-blue-900">R{filtered.reduce((s,i)=>s+Number(i.amount),0).toFixed(2)}</p>
                  <p className="text-[10px] text-blue-500">{filtered.length} {filtered.length === 1 ? "entry" : "entries"}</p>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* ═══ MAIN GRID ═══ */}
      <div className="grid gap-3 md:grid-cols-[1fr_280px]">
        <div className="min-w-0 space-y-3">

          {/* Capture Bar */}
          {canEdit && activeTab !== "Banking" && (
            <div className="sticky top-12 z-30 bg-background border rounded-lg p-2 shadow-sm">
              <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto_auto_auto] gap-2 items-end">
                {(activeTab === "Members" || activeTab === "Officers") && (
                  <select className="h-9 rounded border border-input bg-background px-2 text-xs" value={form.officerId} onChange={e => { setForm({ officerId: e.target.value, error: "" }); setActiveOfficerId(e.target.value || null); }}>
                    <option value="">Select Officer *</option>
                    {officers.map(o => <option key={o.id} value={o.id}>{officerLabel(o)}</option>)}
                  </select>
                )}
                {activeTab === "Burial" && <Input className="h-9 text-xs" placeholder="Receipt Number *" value={form.ref} onChange={e => setForm({ ref: e.target.value, error: "" })} />}
                {activeTab === "Expenses" && (
                  <div className="flex gap-2 flex-1">
                    <Input className="h-9 text-xs flex-1" placeholder="Description *" value={form.ref} onChange={e => setForm({ ref: e.target.value, error: "" })} />
                    <Input type="date" className="h-9 text-xs w-36" value={form.txnDate} onChange={e => setForm({ txnDate: e.target.value })} title="Expense date" />
                  </div>
                )}
                {(activeTab === "Members" || activeTab === "Officers") && (
                  <select className="h-9 w-28 rounded border border-input bg-background px-2 text-xs" value={form.type} onChange={e => setForm({ type: e.target.value })}>
                    <option value="EFT">EFT</option><option value="Cash">Cash</option><option value="DirectDebit">Direct Deposit</option>
                  </select>
                )}
                <div className="relative w-28">
                  <span className="absolute left-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">R</span>
                  <Input type="number" step="0.01" className="h-9 text-xs pl-5 text-right" placeholder="0.00" value={form.amount} onChange={e => setForm({ amount: e.target.value, error: "" })} onKeyDown={e => { if (e.key === "Enter") handleAddCapture(); }} />
                </div>
                <Button size="sm" className="h-9 text-xs" onClick={handleAddCapture} disabled={!!getValidationError()}>+ Add</Button>
              </div>
              {/* Inline EFT/DD fields: Date (required), Reference (optional), Proof (required per settings) */}
              {(activeTab === "Members" || activeTab === "Officers") && ["EFT", "DirectDebit"].includes(form.type) && (
                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 mt-2 pt-2 border-t">
                  <div className="space-y-1">
                    <Label className="text-[10px] text-muted-foreground">{form.type === "EFT" ? "EFT Date *" : "Deposit Date *"}</Label>
                    <Input type="date" className="h-8 text-xs" value={form.txnDate} onChange={e => setForm({ txnDate: e.target.value, error: "" })} />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[10px] text-muted-foreground">{form.type === "EFT" ? "EFT Ref" : "Deposit Slip #"}</Label>
                    <Input className="h-8 text-xs" placeholder="Optional" value={form.txnRef} onChange={e => setForm({ txnRef: e.target.value })} />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-[10px] text-muted-foreground">Proof {PROOF_MANDATORY ? "*" : ""}</Label>
                    <label className="flex items-center gap-1.5 cursor-pointer">
                      <span className={`text-lg ${form.proofFile ? "text-green-600" : "text-muted-foreground"}`}>{form.proofFile ? "📎" : "📎"}</span>
                      {form.proofFile ? <span className="h-2 w-2 rounded-full bg-green-500" /> : <span className="h-2 w-2 rounded-full bg-destructive" />}
                      <input type="file" accept=".pdf,.jpg,.jpeg,.png" className="hidden" onChange={e => setForm({ proofFile: e.target.files?.[0] ?? null })} />
                      <span className="text-[10px] text-muted-foreground">{form.proofFile ? "Attached" : "Attach"}</span>
                    </label>
                  </div>
                </div>
              )}
              {form.error && <p className="text-destructive text-[11px] mt-1">{form.error}</p>}
            </div>
          )}

          {/* Running Tally */}
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

          {/* Members / Officers List */}
          {(activeTab === "Members" || activeTab === "Officers") && grouped(activeTab).map(({ officer, items: gi }) => (
            <details key={officer!.id} className="border rounded-lg overflow-hidden">
              <summary className="flex items-center justify-between px-3 py-2 bg-muted/20 cursor-pointer text-xs">
                <span className="font-medium truncate max-w-[40%]">{officerLabel(officer!)}</span>
                <b className="shrink-0 text-right">R{gi.reduce((s,i)=>s+Number(i.amount),0).toFixed(2)}</b>
              </summary>
              <div className="px-2 pb-2 pt-1 space-y-1">
                {gi.map(item => (
                  <div key={item.id} className="flex items-center gap-2 py-1 border-b last:border-0 text-xs">
                    <span className="w-20">{item.item_type}</span>
                    <span className="flex-1 font-medium text-right">R{Number(item.amount).toFixed(2)}</span>
                    <ProofBtn item={item} />
                    {canEdit && <button className="text-destructive text-[10px]" onClick={() => deleteRow(item.id)}>✕</button>}
                  </div>
                ))}
              </div>
            </details>
          ))}

          {/* Burial List */}
          {activeTab === "Burial" && tabItems("Burial").map(item => (
            <div key={item.id} className="flex items-center gap-2 py-2 border-b last:border-0 text-xs">
              <span className="w-20 font-medium">{item.receipt_number || "—"}</span>
              <span className="flex-1 text-right w-[120px] font-medium">R{Number(item.amount).toFixed(2)}</span>
              <ProofBtn item={item} />
              {canEdit && <button className="text-destructive" onClick={() => deleteRow(item.id)}>✕</button>}
            </div>
          ))}

          {/* Expenses List */}
          {activeTab === "Expenses" && tabItems("Expenses").map(item => (
            <div key={item.id} className="flex items-center gap-2 py-2 border-b last:border-0 text-xs">
              <span className="flex-1 truncate max-w-[200px]">{item.manual_reference || "—"}</span>
              <span className="w-[120px] text-right font-medium shrink-0">R{Number(item.amount).toFixed(2)}</span>
              <ProofBtn item={item} />
              {canEdit && <button className="text-destructive" onClick={() => deleteRow(item.id)}>✕</button>}
            </div>
          ))}

          {/* Banking Tab (read-only) */}
          {activeTab === "Banking" && (
            <div className="space-y-4">
              {/* Electronic Banking Detail — sorted by type then officer */}
              <Card>
                <CardHeader className="pb-2"><CardTitle className="text-xs">Banking Detail</CardTitle></CardHeader>
                <CardContent>
                  {tabItems("Banking").length === 0 ? <p className="text-xs text-muted-foreground">No electronic banking items.</p> : (() => {
                    const bankingItems = [...tabItems("Banking")].sort((a, b) => {
                      const typeOrder = (t: string) => t === "DirectDebit" ? 0 : t === "EFT" ? 1 : 2;
                      if (typeOrder(a.item_type) !== typeOrder(b.item_type)) return typeOrder(a.item_type) - typeOrder(b.item_type);
                      const aOff = officers.find(o => o.id === a.officer_id)?.officer_code ?? "zzz";
                      const bOff = officers.find(o => o.id === b.officer_id)?.officer_code ?? "zzz";
                      return aOff.localeCompare(bOff);
                    });
                    const ddItems = bankingItems.filter(i => i.item_type === "DirectDebit");
                    const eftItems = bankingItems.filter(i => i.item_type === "EFT");
                    const cbItems = bankingItems.filter(i => i.item_type === "CashBanked");
                    const renderGroup = (groupItems: typeof bankingItems, label: string) => groupItems.length === 0 ? null : (<>
                      {groupItems.map(item => { const att = getAtt(item.id); const off = officers.find(o => o.id === item.officer_id); return (
                        <tr key={item.id} className="border-b last:border-0">
                          <td className="py-1.5 pr-2">{att?.transaction_date ?? "—"}</td>
                          <td className="py-1.5 pr-2">{item.item_type === "DirectDebit" ? "Direct Debit" : item.item_type}</td>
                          <td className="py-1.5 pr-2 text-right font-medium">R{Number(item.amount).toFixed(2)}</td>
                          <td className="py-1.5 pr-2">{off?.officer_code ?? "—"}</td>
                          <td className="py-1.5"><ProofBtn item={item} /></td>
                        </tr>); })}
                      <tr className="bg-muted/50 font-bold border-t"><td colSpan={2} className="py-1.5 pl-2 text-[11px]">Subtotal {label}</td><td className="py-1.5 text-right text-[11px]">R{groupItems.reduce((s,i)=>s+Number(i.amount),0).toFixed(2)}</td><td colSpan={2}></td></tr>
                    </>);
                    return (
                      <table className="w-full text-xs">
                        <thead><tr className="border-b text-muted-foreground text-left"><th className="pb-1 pr-2">Date on Proof</th><th className="pb-1 pr-2">Type</th><th className="pb-1 pr-2 text-right">Amount</th><th className="pb-1 pr-2">Officer</th><th className="pb-1">Proof</th></tr></thead>
                        <tbody>
                          {renderGroup(ddItems, "Direct Debit")}
                          {renderGroup(eftItems, "EFT")}
                          {renderGroup(cbItems, "Cash Banked")}
                          <tr className="font-bold border-t"><td colSpan={2} className="py-2">TOTAL</td><td className="py-2 text-right">R{bankingItems.reduce((s,i)=>s+Number(i.amount),0).toFixed(2)}</td><td colSpan={2}></td></tr>
                        </tbody>
                      </table>
                    );
                  })()}
                </CardContent>
              </Card>

              {/* Cash Pending — single total with one Mark Banked button */}
              <Card>
                <CardHeader className="pb-2"><CardTitle className="text-xs">Cash Pending</CardTitle></CardHeader>
                <CardContent>
                  {(() => {
                    const cashItems = items.filter(i => ["Cash","CashPending"].includes(i.item_type));
                    const cashTotal = cashItems.reduce((s, i) => s + Number(i.amount), 0);
                    if (cashItems.length === 0) return <p className="text-xs text-green-600 font-medium">All cash banked ✓</p>;
                    // Check if already marked as banked (all have proof)
                    const allBanked = cashItems.every(i => hasProof(i.id));
                    return (
                      <div className="space-y-3">
                        <div className="flex items-center justify-between">
                          <div>
                            <p className="text-sm font-bold">Amount to be Banked: R{cashTotal.toFixed(2)}</p>
                            <p className="text-[10px] text-muted-foreground">{cashItems.length} cash {cashItems.length === 1 ? "entry" : "entries"}</p>
                          </div>
                          {allBanked ? (
                            <span className="inline-flex items-center gap-1 text-green-600 text-xs font-medium">
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" /></svg>
                              Cash Banked
                            </span>
                          ) : (
                            <label className="inline-flex items-center gap-2 cursor-pointer">
                              <Button size="sm" variant="outline" className="h-8 text-xs" disabled={!canEdit} asChild>
                                <span>Mark Banked</span>
                              </Button>
                              <input type="file" accept="image/*,.pdf" className="hidden" disabled={!canEdit} onChange={async (e) => {
                                const file = e.target.files?.[0];
                                if (!file || !period) return;
                                const compressed = await compressImage(file);
                                const { data: { user } } = await supabase.auth.getUser();
                                const congId = access?.congregation_id ?? period.congregation_id;
                                const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
                                const ext = compressed.name.split(".").pop() ?? "jpg";
                                const storagePath = `${congId}/${period.year}/${String(period.month).padStart(2,"0")}/${period.service}_${period.week_key ?? period.week}/${user?.id}/${ts}-deposit-slip.${ext}`;
                                await supabase.storage.from("cashbook-proofs").upload(storagePath, compressed);
                                const { data: u } = supabase.storage.from("cashbook-proofs").getPublicUrl(storagePath);
                                // Attach proof to ALL cash items and mark them as CashBanked
                                for (const ci of cashItems) {
                                  await supabase.from("cashbook_attachment").insert({ line_item_id: ci.id, file_url: u.publicUrl, uploaded_by: user?.id, congregation_id: congId, transaction_date: new Date().toISOString().split("T")[0] });
                                  await supabase.from("cashbook_line_item").update({ item_type: "CashBanked", payment_type: "CashBanked", proof_status: "uploaded" }).eq("id", ci.id);
                                }
                                await refetchItems();
                              }} />
                            </label>
                          )}
                        </div>
                      </div>
                    );
                  })()}
                </CardContent>
              </Card>
            </div>
          )}
        </div>

        {/* Right Panel */}
        <div className="hidden md:block space-y-3">
          <Card className="sticky top-14">
            <CardHeader className="pb-1 px-3"><CardTitle className="text-[10px] uppercase tracking-wider text-muted-foreground">Banking</CardTitle></CardHeader>
            <CardContent className="px-3 space-y-2 text-xs">
              <p className="font-bold text-sm">INCOME: R{grandIncome.toFixed(2)}</p>
              <div className="pl-2 space-y-0.5 text-muted-foreground">
                <p>EFT: R{sumType("EFT").toFixed(2)} ({items.filter(i=>i.item_type==="EFT").length})</p>
                <p>DD: R{sumType("DirectDebit").toFixed(2)} ({items.filter(i=>i.item_type==="DirectDebit").length})</p>
                <p>Cash Pending: R{(sumType("Cash")+sumType("CashPending")).toFixed(2)}</p>
                <p>Cash Banked: R{sumType("CashBanked").toFixed(2)}</p>
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
              <div className="flex justify-between border-t pt-1 font-bold text-primary"><span>Grand Total</span><span>R{(grandIncome - expensesT).toFixed(2)}</span></div>
              {missingProofs.length > 0 && <p className="text-destructive text-[10px] mt-1">{missingProofs.length} proof(s) missing</p>}
            </CardContent>
          </Card>
          <div className="w-full rounded-md bg-muted py-2 text-center">
            <span className={`text-xs font-bold ${period?.status === "AuditApproved" ? "text-green-700" : period?.status === "Submitted" ? "text-orange-700" : "text-muted-foreground"}`}>
              {period?.status === "Draft" || period?.status === "Rejected" ? "⬤ Draft — Capture in Progress" : period?.status}
            </span>
          </div>
        </div>
      </div>

      {/* Mobile Summary */}
      <div className="md:hidden mt-3 rounded bg-muted/50 px-3 py-2 flex justify-between text-xs">
        <span>Income: <b>R{grandIncome.toFixed(2)}</b></span>
        <span className="text-green-700">✓</span>
      </div>

      {/* Sticky Footer */}
      {isDraft && (
        <div className="fixed bottom-0 left-0 right-0 bg-background border-t px-3 py-3 z-40">
          <div className="max-w-[1400px] mx-auto flex items-center justify-between gap-2">
            <span className="text-[11px] text-muted-foreground hidden sm:inline">{grandIncome === 0 ? "Add items" : "Ready"}</span>
            <Button onClick={handleSubmit} disabled={submitting || grandIncome === 0 || (PROOF_MANDATORY && missingProofs.length > 0)} size="sm" className="flex-1 sm:flex-none">
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
            <CardHeader className="pb-2"><CardTitle className="text-sm">{["Cash","CashPending"].includes(proofModal.type) ? "Mark Cash as Banked" : "Upload Proof"}</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              {["EFT","DirectDebit","Cash","CashPending"].includes(proofModal.type) && (<>
                <div className="space-y-1"><Label className="text-xs">{["Cash","CashPending"].includes(proofModal.type) ? "Deposit Date *" : "Proof Date *"}</Label><Input type="date" className="h-9 text-xs" value={proofDate} onChange={e => setProofDate(e.target.value)} /></div>
                <div className="space-y-1"><Label className="text-xs">Bank Ref</Label><Input className="h-9 text-xs" value={proofBankRef} onChange={e => setProofBankRef(e.target.value)} /></div>
              </>)}
              <div className="space-y-1"><Label className="text-xs">Photo *</Label><input type="file" accept="image/*" capture={isMobile ? "environment" : undefined} className="text-xs" onChange={e => setProofFile(e.target.files?.[0] ?? null)} /></div>
              <div className="flex gap-2">
                <Button size="sm" onClick={saveProof} disabled={!proofFile || (["EFT","DirectDebit","Cash","CashPending"].includes(proofModal.type) && !proofDate)}>{["Cash","CashPending"].includes(proofModal.type) ? "Mark Banked" : "Save"}</Button>
                <Button size="sm" variant="outline" onClick={() => setProofModal(null)}>Cancel</Button>
              </div>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );

  // ── ProofBtn ──────────────────────────────────────────────────────────────
  function ProofBtn({ item }: { item: LineItem }) {
    const att = getAtt(item.id);
    // Already attached → green paperclip, click to view
    if (att) return (
      <a href={att.file_url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-green-600" title="View proof">
        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>
        <span className="text-[10px] font-medium">Attached</span>
      </a>
    );
    // Not required → dash
    if (!needsProof(item)) return <span className="text-muted-foreground text-[10px]">—</span>;
    // Needs proof → paperclip with red dot, opens file picker directly
    return (
      <label className="inline-flex items-center gap-1 cursor-pointer relative" title="Attach proof">
        <svg className="w-4 h-4 text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" /></svg>
        <span className="absolute -top-0.5 -left-0.5 h-2 w-2 rounded-full bg-destructive" />
        <span className="text-[10px] text-muted-foreground">Attach</span>
        <input type="file" accept="image/*,.pdf" className="hidden" disabled={!canEdit} onChange={async (e) => {
          const file = e.target.files?.[0];
          if (!file || !period) return;
          const compressed = await compressImage(file);
          const { data: { user } } = await supabase.auth.getUser();
          const congId = access?.congregation_id ?? period.congregation_id;
          const ts = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
          const ext = compressed.name.split(".").pop() ?? "jpg";
          const storagePath = `${congId}/${period.year}/${String(period.month).padStart(2,"0")}/${period.service}_${period.week_key ?? period.week}/${user?.id}/${ts}-proof.${ext}`;
          await supabase.storage.from("cashbook-proofs").upload(storagePath, compressed);
          const { data: u } = supabase.storage.from("cashbook-proofs").getPublicUrl(storagePath);
          await supabase.from("cashbook_attachment").insert({ line_item_id: item.id, file_url: u.publicUrl, uploaded_by: user?.id, congregation_id: congId });
          await supabase.from("cashbook_line_item").update({ proof_status: "uploaded" }).eq("id", item.id);
          await refetchItems();
        }} />
      </label>
    );
  }
}
