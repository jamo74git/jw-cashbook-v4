"use client";

import { useEffect, useState, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import { getUserAccess, hasPermission, isOverrideAction, logSelfReviewException } from "@/lib/permissions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import type { Role, UserHierarchyAccess } from "@/lib/types";

// ─── Types ──────────────────────────────────────────────────────────────────
interface Period { id: string; congregation_id: string; year: number; month: number; week: number; service: string; status: string; }
interface LineItem { id: string; period_id: string; section: string; officer_id: string | null; item_type: string; item_count: number | null; amount: number; proof_status: string | null; payment_type: string | null; manual_reference: string | null; }
interface Attachment { id: string; line_item_id: string; file_url: string; }
interface Officer { id: string; officer_code: string; first_name: string; last_name: string | null; }

function calcWeek() {
  const today = new Date(), y = today.getFullYear(), m = today.getMonth() + 1;
  const sundays: Date[] = [];
  for (let d = 1; d <= new Date(y, m, 0).getDate(); d++) { if (new Date(y, m - 1, d).getDay() === 0) sundays.push(new Date(y, m - 1, d)); }
  let week = 1;
  for (let i = 1; i < sundays.length; i++) { if (today >= sundays[i]) week = i; }
  return { year: y, month: m, week };
}

function needsProof(item: LineItem): boolean {
  return ["EFT", "DirectDebit"].includes(item.item_type) || item.section === "Burial" || item.section === "Expenses";
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

  // Capture bar state
  const [capOfficerId, setCapOfficerId] = useState("");
  const [capType, setCapType] = useState("Cash");
  const [capAmount, setCapAmount] = useState("");
  const [capSection, setCapSection] = useState("Members");
  const [activeOfficerId, setActiveOfficerId] = useState<string | null>(null);

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
      supabase.from("cashbook_line_item").select("*").eq("period_id", p.id).order("section"),
      supabase.from("cashbook_attachment").select("id, line_item_id, file_url"),
      supabase.from("officers").select("id, officer_code, first_name, last_name").eq("congregation_id", ua.congregation_id).eq("is_active", true).order("officer_code"),
    ]);
    setItems(li.data ?? []);
    const ids = new Set((li.data ?? []).map((i: LineItem) => i.id));
    setAttachments((att.data ?? []).filter((a: Attachment) => ids.has(a.line_item_id)));
    setOfficers(off.data ?? []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  // ── CRUD ──────────────────────────────────────────────────────────────────
  async function handleAddCapture() {
    if (!period || !canEdit || !capAmount) return;
    const amt = parseFloat(capAmount);
    if (isNaN(amt) || amt <= 0) return;
    await supabase.from("cashbook_line_item").insert({
      period_id: period.id, section: capSection, item_type: capType, amount: amt,
      officer_id: capOfficerId || null, payment_type: capType, manual_reference: null, proof_status: null,
    });
    setCapAmount("");
    setActiveOfficerId(capOfficerId || null);
    await load();
  }
  async function updateRow(id: string, field: string, value: string | number | null) {
    if (!canEdit) return;
    await supabase.from("cashbook_line_item").update({ [field]: value }).eq("id", id);
    await load();
  }
  async function deleteRow(id: string) {
    if (!canEdit) return;
    await supabase.from("cashbook_attachment").delete().eq("line_item_id", id);
    await supabase.from("cashbook_line_item").delete().eq("id", id);
    await load();
  }
  async function captureProof(lineItemId: string, file: File) {
    if (!canEdit || !period) return;
    const path = `proofs/${period.id}/${lineItemId}_${Date.now()}.jpg`;
    await supabase.storage.from("burial_proofs").upload(path, file);
    const { data: u } = supabase.storage.from("burial_proofs").getPublicUrl(path);
    const { data: { user } } = await supabase.auth.getUser();
    await supabase.from("cashbook_attachment").insert({ line_item_id: lineItemId, file_url: u.publicUrl, uploaded_by: user?.id });
    await supabase.from("cashbook_line_item").update({ proof_status: "uploaded" }).eq("id", lineItemId);
    await load();
  }
  async function handleSubmit() {
    if (!period || !access || !canSubmit) return;
    if (role && isOverrideAction(role, "capture.submit")) {
      if (!window.confirm("You are submitting as Treasurer. This will be logged as SELF_REVIEW_EXCEPTION. Continue?")) return;
      await logSelfReviewException({ userId: access.user_id, entityType: "cashbook_period", entityId: period.id, assumedRole: "Treasurer" });
    }
    setSubmitting(true);
    await supabase.from("cashbook_period").update({ status: "Submitted", submitted_at: new Date().toISOString() }).eq("id", period.id);
    setSuccess("Submitted for Audit."); setSubmitting(false); await load();
  }

  // ── Computed ──────────────────────────────────────────────────────────────
  const sec = (s: string) => items.filter(i => i.section === s);
  const secTotal = (s: string) => sec(s).reduce((sum, i) => sum + Number(i.amount), 0);
  const typeSum = (s: string, t: string) => sec(s).filter(i => i.item_type === t).reduce((sum, i) => sum + Number(i.amount), 0);
  const typeCount = (s: string, t: string) => sec(s).filter(i => i.item_type === t).length;
  const hasProof = (id: string) => attachments.some(a => a.line_item_id === id);
  const missingProofs = items.filter(i => needsProof(i) && !hasProof(i.id));
  const grandIncome = secTotal("Members") + secTotal("Officers") + secTotal("Burial");

  // Active officer items (for tally panel)
  const activeOfficer = officers.find(o => o.id === activeOfficerId);
  const activeItems = activeOfficerId ? sec(capSection).filter(i => i.officer_id === activeOfficerId) : [];
  const activeTotal = activeItems.reduce((s, i) => s + Number(i.amount), 0);

  // Grouped by officer for list below
  const grouped = (section: string) => {
    const map = new Map<string, { officer: Officer | null; items: LineItem[] }>();
    sec(section).forEach(item => {
      const key = item.officer_id ?? "__none__";
      if (!map.has(key)) map.set(key, { officer: officers.find(o => o.id === item.officer_id) ?? null, items: [] });
      map.get(key)!.items.push(item);
    });
    return Array.from(map.values());
  };

  if (loading) return <div className="p-6 text-muted-foreground text-sm">Loading...</div>;
  if (error) return <div className="p-6 text-destructive text-sm">{error}</div>;

  // ── Type options per section ──────────────────────────────────────────────
  const typeOptions: Record<string, string[]> = {
    Members: ["EFT", "Cash", "DirectDebit"],
    Officers: ["Cash", "DirectDebit"],
    Burial: ["Cash", "EFT"],
    Expenses: ["Expense"],
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════════════════════════════════════════
  return (
    <div className="max-w-[1400px] mx-auto px-2 sm:px-4 py-2 pb-24">
      {/* Header bar */}
      <div className="flex items-center justify-between mb-2 text-xs">
        <span className="font-medium">Week {period?.week} · {period?.service} · {period?.year}/{String(period?.month).padStart(2,"0")}</span>
        <Badge variant={isDraft ? "outline" : "secondary"} className="text-[10px]">{period?.status}</Badge>
      </div>
      {success && <div className="rounded border border-green-300 bg-green-50 p-2 text-xs text-green-800 mb-2">{success}</div>}

      {/* ═══ MAIN LAYOUT ═══ */}
      <div className="grid gap-3 md:grid-cols-[1fr_300px]">

        {/* ═══ LEFT: Capture Area ═══ */}
        <div className="min-w-0 space-y-3">
          {/* Tab Selector */}
          <Tabs defaultValue="Members" onValueChange={(v) => { setCapSection(v); setActiveOfficerId(null); setCapType(typeOptions[v]?.[0] ?? "Cash"); }}>
            <TabsList className="w-full justify-start overflow-x-auto flex-nowrap">
              <TabsTrigger value="Members">Members ({sec("Members").length})</TabsTrigger>
              <TabsTrigger value="Officers">Officers ({sec("Officers").length})</TabsTrigger>
              <TabsTrigger value="Burial">Burial ({sec("Burial").length})</TabsTrigger>
              <TabsTrigger value="Expenses">Expenses ({sec("Expenses").length})</TabsTrigger>
            </TabsList>

            {/* ─── CAPTURE BAR (sticky) ─── */}
            {canEdit && (
              <div className="sticky top-12 z-30 bg-background border rounded-lg p-2 mt-2 shadow-sm">
                <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto_auto_auto_auto] gap-2 items-end">
                  {/* Officer select (Members/Officers only) */}
                  {(capSection === "Members" || capSection === "Officers") && (
                    <select className="h-9 rounded border border-input bg-background px-2 text-xs" value={capOfficerId} onChange={e => { setCapOfficerId(e.target.value); setActiveOfficerId(e.target.value || null); }}>
                      <option value="">Select Officer...</option>
                      {officers.map(o => <option key={o.id} value={o.id}>{o.officer_code} - {o.first_name}</option>)}
                    </select>
                  )}
                  {/* Reference (Burial/Expenses) */}
                  {(capSection === "Burial" || capSection === "Expenses") && (
                    <Input className="h-9 text-xs" placeholder={capSection === "Burial" ? "Receipt #" : "Description"} id="cap-ref" />
                  )}
                  {/* Type */}
                  <select className="h-9 w-28 rounded border border-input bg-background px-2 text-xs" value={capType} onChange={e => setCapType(e.target.value)}>
                    {(typeOptions[capSection] ?? ["Cash"]).map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                  {/* Amount */}
                  <div className="relative w-28">
                    <span className="absolute left-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">R</span>
                    <Input type="number" step="0.01" className="h-9 text-xs pl-5 text-right" placeholder="0.00" value={capAmount} onChange={e => setCapAmount(e.target.value)} onKeyDown={e => { if (e.key === "Enter") handleAddCapture(); }} />
                  </div>
                  {/* Add button */}
                  <Button size="sm" className="h-9 text-xs" onClick={async () => {
                    // For Burial/Expenses, grab the reference
                    if (capSection === "Burial" || capSection === "Expenses") {
                      const ref = (document.getElementById("cap-ref") as HTMLInputElement)?.value;
                      if (!period || !capAmount) return;
                      await supabase.from("cashbook_line_item").insert({
                        period_id: period.id, section: capSection, item_type: capType,
                        amount: parseFloat(capAmount) || 0, officer_id: null,
                        payment_type: capType, manual_reference: ref || null, proof_status: null,
                      });
                      setCapAmount("");
                      const el = document.getElementById("cap-ref") as HTMLInputElement;
                      if (el) el.value = "";
                      await load();
                    } else {
                      await handleAddCapture();
                    }
                  }}>+ Add</Button>
                </div>
              </div>
            )}

            {/* ─── RUNNING TALLY (when officer active) ─── */}
            {activeOfficerId && activeItems.length > 0 && (capSection === "Members" || capSection === "Officers") && (
              <Card className="mt-2 border-primary/30">
                <CardHeader className="py-2 px-3">
                  <CardTitle className="text-xs font-medium">
                    Capturing for: <span className="text-primary">{activeOfficer?.officer_code} - {activeOfficer?.first_name} {activeOfficer?.last_name ?? ""}</span>
                  </CardTitle>
                </CardHeader>
                <CardContent className="px-3 pb-3 space-y-1">
                  {activeItems.map(item => (
                    <div key={item.id} className="flex items-center gap-2 py-1 border-b last:border-0 text-xs">
                      <span className="font-medium w-16">{item.item_type}</span>
                      <span className="flex-1">R{Number(item.amount).toFixed(2)}</span>
                      {/* Proof */}
                      {hasProof(item.id) ? <span className="text-green-600">📷✓</span> : needsProof(item) ? (
                        <label className="cursor-pointer relative">
                          <span>📷</span><span className="absolute -top-1 -right-1 h-1.5 w-1.5 rounded-full bg-destructive" />
                          <input type="file" accept="image/*" capture={isMobile ? "environment" : undefined} className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) captureProof(item.id, f); }} />
                        </label>
                      ) : null}
                      {canEdit && <button className="text-destructive hover:underline" onClick={() => deleteRow(item.id)}>✕</button>}
                    </div>
                  ))}
                  <div className="flex justify-between pt-2 border-t text-xs">
                    <span>Subtotal: <b>R{activeTotal.toFixed(2)}</b></span>
                    <span>{activeItems.filter(i => i.item_type !== "Cash").length} EFT/DD</span>
                  </div>
                  <Button size="sm" variant="outline" className="w-full text-xs mt-1 h-7" onClick={() => setActiveOfficerId(null)}>
                    Done with this Priest
                  </Button>
                </CardContent>
              </Card>
            )}

            {/* ─── CAPTURED LIST (all tabs share same structure) ─── */}
            <TabsContent value="Members"><CapturedList section="Members" types={["EFT","Cash","DirectDebit"]} /></TabsContent>
            <TabsContent value="Officers"><CapturedList section="Officers" types={["Cash","DirectDebit"]} /></TabsContent>
            <TabsContent value="Burial"><FlatList section="Burial" types={["Cash","EFT"]} /></TabsContent>
            <TabsContent value="Expenses"><FlatList section="Expenses" types={["Expense"]} /></TabsContent>
          </Tabs>
        </div>

        {/* ═══ RIGHT: Banking + Totals (desktop only) ═══ */}
        <div className="hidden md:block space-y-3">
          <Card className="sticky top-14">
            <CardHeader className="pb-1 px-3"><CardTitle className="text-[10px] uppercase tracking-wider text-muted-foreground">Banking</CardTitle></CardHeader>
            <CardContent className="px-3 space-y-2 text-xs">
              <p className="font-bold text-sm">INCOME: R{grandIncome.toFixed(2)}</p>
              <div className="pl-2 space-y-0.5 text-muted-foreground">
                <p>EFT: R{(typeSum("Members","EFT")+typeSum("Officers","EFT")+typeSum("Burial","EFT")).toFixed(2)} ({typeCount("Members","EFT")+typeCount("Officers","EFT")+typeCount("Burial","EFT")})</p>
                <p>DirectDebit: R{(typeSum("Members","DirectDebit")+typeSum("Officers","DirectDebit")).toFixed(2)} ({typeCount("Members","DirectDebit")+typeCount("Officers","DirectDebit")})</p>
                <p>Cash: R{(typeSum("Members","Cash")+typeSum("Officers","Cash")+typeSum("Burial","Cash")).toFixed(2)} ({typeCount("Members","Cash")+typeCount("Officers","Cash")+typeCount("Burial","Cash")})</p>
              </div>
              <div className="border-t pt-1"><p className="font-bold text-sm">EXPENSES: R{secTotal("Expenses").toFixed(2)}</p></div>
              <div className="border-t pt-1"><p className="font-bold text-sm text-primary">BALANCE: R{(grandIncome - secTotal("Expenses")).toFixed(2)}</p></div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-1 px-3"><CardTitle className="text-[10px] uppercase tracking-wider text-muted-foreground">Totals</CardTitle></CardHeader>
            <CardContent className="px-3 space-y-1 text-xs">
              <div className="flex justify-between"><span>Members</span><b>R{secTotal("Members").toFixed(2)}</b></div>
              <div className="flex justify-between"><span>Officers</span><b>R{secTotal("Officers").toFixed(2)}</b></div>
              <div className="flex justify-between"><span>Burial</span><b>R{secTotal("Burial").toFixed(2)}</b></div>
              <div className="flex justify-between border-t pt-1 font-bold"><span>Income</span><span>R{grandIncome.toFixed(2)}</span></div>
              <div className="flex justify-between text-muted-foreground"><span>Expenses</span><span>R{secTotal("Expenses").toFixed(2)}</span></div>
              <div className="mt-2"><Badge variant={period?.status === "AuditApproved" ? "default" : "outline"} className="text-[10px]">{period?.status}</Badge></div>
              {missingProofs.length > 0 && isDraft && <p className="text-destructive text-[10px] mt-1">{missingProofs.length} proof(s) missing</p>}
            </CardContent>
          </Card>
        </div>
      </div>

      {/* ═══ MOBILE SUMMARY BAR ═══ */}
      <div className="md:hidden mt-3 rounded bg-muted/50 px-3 py-2 flex justify-between text-xs">
        <span>Income: <b>R{grandIncome.toFixed(2)}</b> | Exp: R{secTotal("Expenses").toFixed(2)}</span>
        {missingProofs.length > 0 ? <span className="text-destructive font-medium">{missingProofs.length} proofs</span> : <span className="text-green-700">✓ OK</span>}
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
    </div>
  );

  // ── CapturedList (grouped accordion for Members/Officers) ─────────────────
  function CapturedList({ section, types }: { section: string; types: string[] }) {
    const groups = grouped(section);
    return (
      <div className="space-y-2 mt-3">
        {/* Stats bar */}
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-[11px] bg-muted/50 rounded px-2 py-1.5">
          {types.map(t => <span key={t}>{t}: <b>R{typeSum(section,t).toFixed(2)}</b> ({typeCount(section,t)})</span>)}
          <span className="ml-auto font-bold">Total: R{secTotal(section).toFixed(2)}</span>
        </div>
        {/* Accordion per officer */}
        {groups.map(({ officer, items: gi }) => {
          const total = gi.reduce((s, i) => s + Number(i.amount), 0);
          const label = officer ? `${officer.officer_code} - ${officer.first_name}` : "Unassigned";
          return (
            <details key={officer?.id ?? "none"} className="border rounded-lg overflow-hidden">
              <summary className="flex items-center justify-between px-3 py-2 bg-muted/20 cursor-pointer text-xs">
                <span className="font-medium truncate">{label}</span>
                <div className="flex items-center gap-2 shrink-0 text-[10px]">
                  {types.map(t => { const c = gi.filter(i => i.item_type === t); return c.length > 0 ? <span key={t} className="text-muted-foreground">{t}: R{c.reduce((s,i)=>s+Number(i.amount),0).toFixed(0)} ({c.length})</span> : null; })}
                  <b>R{total.toFixed(2)}</b>
                </div>
              </summary>
              <div className="px-2 pb-2 pt-1 space-y-1">
                {gi.map(item => (
                  <div key={item.id} className="flex items-center gap-2 py-1 border-b last:border-0 text-xs">
                    <select className="h-7 w-20 rounded border border-input bg-background px-1 text-[11px]" value={item.item_type} onChange={e => updateRow(item.id, "item_type", e.target.value)} disabled={!canEdit}>
                      {types.map(t => <option key={t} value={t}>{t}</option>)}
                    </select>
                    <span className="flex-1 font-medium">R{Number(item.amount).toFixed(2)}</span>
                    {hasProof(item.id) ? <span className="text-green-600 text-sm">📷</span> : needsProof(item) ? (
                      <label className="cursor-pointer relative"><span className="text-sm">📷</span><span className="absolute -top-0.5 -right-0.5 h-1.5 w-1.5 rounded-full bg-destructive" /><input type="file" accept="image/*" capture={isMobile ? "environment" : undefined} className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) captureProof(item.id, f); }} disabled={!canEdit} /></label>
                    ) : <span className="text-muted-foreground text-[10px]">—</span>}
                    {canEdit && <button className="text-destructive text-[10px] hover:underline" onClick={() => deleteRow(item.id)}>✕</button>}
                  </div>
                ))}
              </div>
            </details>
          );
        })}
      </div>
    );
  }

  // ── FlatList (Burial/Expenses) ────────────────────────────────────────────
  function FlatList({ section, types }: { section: string; types: string[] }) {
    return (
      <div className="space-y-2 mt-3">
        <div className="flex justify-between text-[11px] bg-muted/50 rounded px-2 py-1.5">
          {types.map(t => <span key={t}>{t}: <b>R{typeSum(section,t).toFixed(2)}</b> ({typeCount(section,t)})</span>)}
          <span className="font-bold">Total: R{secTotal(section).toFixed(2)}</span>
        </div>
        {sec(section).map(item => (
          <div key={item.id} className="flex items-center gap-2 py-1.5 border-b last:border-0 text-xs">
            <span className="flex-1 truncate">{item.manual_reference || "—"}</span>
            <span className="w-14 text-right font-medium">R{Number(item.amount).toFixed(2)}</span>
            {hasProof(item.id) ? <span className="text-green-600 text-sm">📷</span> : (
              <label className="cursor-pointer relative"><span className="text-sm">📷</span><span className="absolute -top-0.5 -right-0.5 h-1.5 w-1.5 rounded-full bg-destructive" /><input type="file" accept="image/*" capture={isMobile ? "environment" : undefined} className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) captureProof(item.id, f); }} disabled={!canEdit} /></label>
            )}
            {canEdit && <button className="text-destructive text-[10px]" onClick={() => deleteRow(item.id)}>✕</button>}
          </div>
        ))}
      </div>
    );
  }
}
