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

// ─── Week Calc ──────────────────────────────────────────────────────────────
function calcWeek() {
  const today = new Date(), y = today.getFullYear(), m = today.getMonth() + 1;
  const sundays: Date[] = [];
  for (let d = 1; d <= new Date(y, m, 0).getDate(); d++) { if (new Date(y, m - 1, d).getDay() === 0) sundays.push(new Date(y, m - 1, d)); }
  let week = 1;
  for (let i = 1; i < sundays.length; i++) { if (today >= sundays[i]) week = i; }
  return { year: y, month: m, week };
}

// ─── Proof Policy ───────────────────────────────────────────────────────────
const ALLOW_UPLOAD = process.env.NEXT_PUBLIC_ALLOW_PROOF_UPLOAD === "true";
function needsProof(item: LineItem): boolean {
  return ["EFT", "DirectDebit", "Burial", "Expense"].includes(item.item_type) || item.proof_status === "banked";
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
  const [bankingOpen, setBankingOpen] = useState(false);

  const role = access?.role as Role | undefined;
  const isDraft = period?.status === "Draft";
  const canEdit = !!(role && hasPermission(role, "capture.edit") && isDraft);
  const canSubmit = !!(role && hasPermission(role, "capture.submit") && isDraft);

  // Detect mobile
  useEffect(() => {
    const check = () => setIsMobile(window.innerWidth < 768);
    check(); window.addEventListener("resize", check);
    return () => window.removeEventListener("resize", check);
  }, []);

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
  async function addRow(section: string, defaultType: string, officerId?: string) {
    if (!period || !canEdit) return;
    await supabase.from("cashbook_line_item").insert({ period_id: period.id, section, item_type: defaultType, amount: 0, officer_id: officerId || null, payment_type: defaultType, manual_reference: null, proof_status: null });
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

  // ── Submit ────────────────────────────────────────────────────────────────
  async function handleSubmit() {
    if (!period || !access || !canSubmit) return;
    if (role && isOverrideAction(role, "capture.submit")) {
      if (!window.confirm("You are submitting as Treasurer. This will be logged as SELF_REVIEW_EXCEPTION. Continue?")) return;
      await logSelfReviewException({ userId: access.user_id, entityType: "cashbook_period", entityId: period.id, assumedRole: "Treasurer" });
    }
    setSubmitting(true);
    await supabase.from("cashbook_period").update({ status: "Submitted", submitted_at: new Date().toISOString() }).eq("id", period.id);
    setSuccess("Submitted for Audit."); setSubmitting(false);
    await load();
  }

  // ── Computed Values ───────────────────────────────────────────────────────
  const sec = (s: string) => items.filter(i => i.section === s);
  const secTotal = (s: string) => sec(s).reduce((sum, i) => sum + Number(i.amount), 0);
  const typeSum = (s: string, t: string) => sec(s).filter(i => i.item_type === t).reduce((sum, i) => sum + Number(i.amount), 0);
  const typeCount = (s: string, t: string) => sec(s).filter(i => i.item_type === t).length;
  const hasProof = (id: string) => attachments.some(a => a.line_item_id === id);
  const getProofUrl = (id: string) => attachments.find(a => a.line_item_id === id)?.file_url;
  const missingProofs = items.filter(i => needsProof(i) && !hasProof(i.id));
  const grandIncome = secTotal("Members") + secTotal("Officers") + secTotal("Burial");
  const allEFT = typeSum("Members", "EFT") + typeSum("Officers", "EFT") + typeSum("Burial", "EFT");
  const allDD = typeSum("Members", "DirectDebit") + typeSum("Officers", "DirectDebit");
  const allCash = typeSum("Members", "Cash") + typeSum("Officers", "Cash") + typeSum("Burial", "Cash");

  // Group by officer
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

  // ── Proof Button Component ────────────────────────────────────────────────
  function ProofBtn({ item }: { item: LineItem }) {
    const proofUrl = getProofUrl(item.id);
    const required = needsProof(item);
    if (proofUrl) return (
      <a href={proofUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1">
        <span className="text-green-600 text-lg">📷</span>
        {/* Thumbnail on mobile */}
        {isMobile && <img src={proofUrl} alt="" className="h-8 w-8 rounded object-cover border" />}
      </a>
    );
    if (!required) return <span className="text-muted-foreground text-xs">—</span>;
    return (
      <label className="cursor-pointer inline-flex items-center gap-1 relative">
        <span className="text-lg">{hasProof(item.id) ? "📷" : "📷"}</span>
        {!hasProof(item.id) && required && <span className="absolute -top-1 -right-1 h-2 w-2 rounded-full bg-destructive" />}
        <input
          type="file"
          accept="image/*"
          capture={isMobile && !ALLOW_UPLOAD ? "environment" : undefined}
          className="hidden"
          onChange={e => { const f = e.target.files?.[0]; if (f) captureProof(item.id, f); }}
          disabled={!canEdit}
        />
      </label>
    );
  }

  // ── Stats Bar (per section) ───────────────────────────────────────────────
  function StatsBar({ section, types }: { section: string; types: string[] }) {
    return (
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] bg-muted/50 rounded px-2 py-1.5 mb-2">
        {types.map(t => (
          <span key={t} className="whitespace-nowrap">
            {t}: <b>R{typeSum(section, t).toFixed(2)}</b> <span className="text-muted-foreground">({typeCount(section, t)})</span>
          </span>
        ))}
        <span className="ml-auto font-bold whitespace-nowrap">Total: R{secTotal(section).toFixed(2)}</span>
      </div>
    );
  }

  // ── Grouped Accordion Section (Members/Officers) ──────────────────────────
  function GroupedSection({ section, types }: { section: string; types: string[] }) {
    const groups = grouped(section);
    return (
      <div className="space-y-2">
        <StatsBar section={section} types={types} />
        {groups.map(({ officer, items: gi }) => {
          const total = gi.reduce((s, i) => s + Number(i.amount), 0);
          const label = officer ? `${officer.officer_code} - ${officer.first_name}${officer.last_name ? " " + officer.last_name : ""}` : "Unassigned";
          return (
            <details key={officer?.id ?? "none"} className="border rounded-lg overflow-hidden" open>
              <summary className="flex items-center justify-between px-3 py-2 bg-muted/30 cursor-pointer text-xs sm:text-sm">
                <span className="font-medium truncate">{label}</span>
                <div className="flex items-center gap-2 shrink-0">
                  {types.map(t => { const c = gi.filter(i => i.item_type === t); return c.length > 0 ? <span key={t} className="text-[10px] text-muted-foreground hidden sm:inline">{t}: R{c.reduce((s,i)=>s+Number(i.amount),0).toFixed(0)} ({c.length})</span> : null; })}
                  <span className="font-bold text-xs">R{total.toFixed(2)}</span>
                </div>
              </summary>
              <div className="px-2 pb-2 pt-1 space-y-1.5">
                {gi.map(item => (
                  <div key={item.id} className="flex items-center gap-2 py-1 border-b last:border-0">
                    <select className="h-8 flex-shrink-0 w-24 sm:w-28 rounded border border-input bg-background px-1 text-xs" value={item.item_type} onChange={e => updateRow(item.id, "item_type", e.target.value)} disabled={!canEdit}>
                      {types.map(t => <option key={t} value={t}>{t}</option>)}
                    </select>
                    <div className="relative flex-1">
                      <span className="absolute left-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">R</span>
                      <Input type="number" step="0.01" className="h-8 text-xs pl-5 text-right" value={item.amount} onChange={e => updateRow(item.id, "amount", parseFloat(e.target.value) || 0)} disabled={!canEdit} />
                    </div>
                    <ProofBtn item={item} />
                    {canEdit && <button className="text-destructive text-xs shrink-0 hover:underline" onClick={() => deleteRow(item.id)}>✕</button>}
                  </div>
                ))}
              </div>
            </details>
          );
        })}
        {/* Add row */}
        {canEdit && (
          <div className="flex gap-2">
            <select id={`add-${section}`} className="h-8 flex-1 rounded border border-input bg-background px-2 text-xs">
              <option value="">Select officer...</option>
              {officers.map(o => <option key={o.id} value={o.id}>{o.officer_code} - {o.first_name}</option>)}
            </select>
            <Button size="sm" variant="outline" className="h-8 text-xs shrink-0" onClick={() => {
              const sel = (document.getElementById(`add-${section}`) as HTMLSelectElement)?.value;
              addRow(section, types[0], sel);
            }}>+ Add</Button>
          </div>
        )}
      </div>
    );
  }

  // ── Flat Section (Burial/Expenses) ────────────────────────────────────────
  function FlatSection({ section, types }: { section: string; types: string[] }) {
    return (
      <div className="space-y-2">
        <StatsBar section={section} types={types} />
        {sec(section).map(item => (
          <div key={item.id} className="flex items-center gap-2 py-1.5 border-b last:border-0">
            <Input className="h-8 text-xs flex-1" value={item.manual_reference ?? ""} onChange={e => updateRow(item.id, "manual_reference", e.target.value)} disabled={!canEdit} placeholder={section === "Burial" ? "Receipt #" : "Description"} />
            <select className="h-8 w-20 rounded border border-input bg-background px-1 text-xs shrink-0" value={item.item_type} onChange={e => updateRow(item.id, "item_type", e.target.value)} disabled={!canEdit}>
              {types.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
            <div className="relative w-24 shrink-0">
              <span className="absolute left-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">R</span>
              <Input type="number" step="0.01" className="h-8 text-xs pl-5 text-right" value={item.amount} onChange={e => updateRow(item.id, "amount", parseFloat(e.target.value) || 0)} disabled={!canEdit} />
            </div>
            <ProofBtn item={item} />
            {canEdit && <button className="text-destructive text-xs shrink-0" onClick={() => deleteRow(item.id)}>✕</button>}
          </div>
        ))}
        <div className="flex justify-between items-center">
          {canEdit && <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => addRow(section, types[0])}>+ Add</Button>}
          <span className="text-xs font-bold ml-auto">Total: R{secTotal(section).toFixed(2)}</span>
        </div>
      </div>
    );
  }

  // ── Banking Panel Content ─────────────────────────────────────────────────
  function BankingContent() {
    return (
      <div className="space-y-3 text-xs">
        <div>
          <p className="font-bold text-sm mb-1">INCOME: R{grandIncome.toFixed(2)}</p>
          <div className="space-y-0.5 pl-2">
            <p>EFT: <b>R{allEFT.toFixed(2)}</b></p>
            <p>DirectDebit: <b>R{allDD.toFixed(2)}</b></p>
            <p>Cash Pending: <b>R{allCash.toFixed(2)}</b></p>
          </div>
        </div>
        <div className="border-t pt-2">
          <p className="font-bold text-sm">EXPENSES: R{secTotal("Expenses").toFixed(2)}</p>
        </div>
        <div className="border-t pt-2">
          <p className="font-bold text-sm text-primary">BALANCE: R{(grandIncome - secTotal("Expenses")).toFixed(2)}</p>
        </div>
        {canEdit && (
          <Button size="sm" variant="outline" className="w-full text-xs mt-2" disabled>
            Mark Cash as Banked (requires deposit slip)
          </Button>
        )}
      </div>
    );
  }

  // ── Totals Panel Content ──────────────────────────────────────────────────
  function TotalsContent() {
    return (
      <div className="space-y-1 text-xs">
        <div className="flex justify-between"><span>Members</span><b>R{secTotal("Members").toFixed(2)}</b></div>
        <div className="flex justify-between"><span>Officers</span><b>R{secTotal("Officers").toFixed(2)}</b></div>
        <div className="flex justify-between"><span>Burial</span><b>R{secTotal("Burial").toFixed(2)}</b></div>
        <div className="flex justify-between border-t pt-1 font-bold"><span>Income</span><span>R{grandIncome.toFixed(2)}</span></div>
        <div className="flex justify-between text-muted-foreground"><span>Expenses</span><span>R{secTotal("Expenses").toFixed(2)}</span></div>
        <div className="border-t pt-1 mt-1">
          <Badge variant={period?.status === "AuditApproved" ? "default" : period?.status === "Submitted" ? "secondary" : "outline"} className="text-[10px]">
            {period?.status}
          </Badge>
          {missingProofs.length > 0 && isDraft && <p className="text-destructive mt-1">{missingProofs.length} proof(s) required</p>}
        </div>
      </div>
    );
  }

  // ── Mobile Banking Sheet ──────────────────────────────────────────────────
  function MobileBankingSheet() {
    if (!bankingOpen) return null;
    return (
      <div className="fixed inset-0 z-50 flex flex-col justify-end">
        <div className="absolute inset-0 bg-black/40" onClick={() => setBankingOpen(false)} />
        <div className="relative bg-background rounded-t-xl p-4 pb-8 max-h-[70vh] overflow-y-auto">
          <div className="flex justify-between items-center mb-3">
            <h3 className="font-bold text-sm">Banking Summary</h3>
            <button onClick={() => setBankingOpen(false)} className="text-muted-foreground">✕</button>
          </div>
          <BankingContent />
        </div>
      </div>
    );
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════════════════════════════════════════
  return (
    <div className="max-w-[1600px] mx-auto px-2 sm:px-3 py-2 pb-24">
      {/* Status + Week info */}
      <div className="flex items-center justify-between mb-2 text-xs">
        <span>Week {period?.week} · {period?.service} · {period?.year}/{String(period?.month).padStart(2,"0")}</span>
        <Badge variant={isDraft ? "outline" : "secondary"} className="text-[10px]">{period?.status}</Badge>
      </div>

      {success && <div className="rounded border border-green-300 bg-green-50 p-2 text-xs text-green-800 mb-2">{success}</div>}

      {/* ═══ DESKTOP: 3-Column ═══ */}
      <div className="hidden md:grid md:grid-cols-[1fr_260px_160px] gap-3">
        {/* Left: Tabs */}
        <div className="min-w-0">
          <Tabs defaultValue="Members">
            <TabsList className="w-full justify-start mb-2">
              <TabsTrigger value="Members">Members ({sec("Members").length})</TabsTrigger>
              <TabsTrigger value="Officers">Officers ({sec("Officers").length})</TabsTrigger>
              <TabsTrigger value="Burial">Burial ({sec("Burial").length})</TabsTrigger>
              <TabsTrigger value="Expenses">Expenses ({sec("Expenses").length})</TabsTrigger>
            </TabsList>
            <TabsContent value="Members"><GroupedSection section="Members" types={["EFT", "Cash", "DirectDebit"]} /></TabsContent>
            <TabsContent value="Officers"><GroupedSection section="Officers" types={["Cash", "DirectDebit"]} /></TabsContent>
            <TabsContent value="Burial"><FlatSection section="Burial" types={["Cash", "EFT"]} /></TabsContent>
            <TabsContent value="Expenses"><FlatSection section="Expenses" types={["Expense"]} /></TabsContent>
          </Tabs>
        </div>
        {/* Center-Right: Banking */}
        <Card className="h-fit sticky top-14">
          <CardHeader className="pb-2"><CardTitle className="text-[10px] uppercase tracking-wider text-muted-foreground">Banking</CardTitle></CardHeader>
          <CardContent><BankingContent /></CardContent>
        </Card>
        {/* Far-Right: Totals */}
        <Card className="h-fit sticky top-14">
          <CardHeader className="pb-1"><CardTitle className="text-[10px] uppercase tracking-wider text-muted-foreground">Totals</CardTitle></CardHeader>
          <CardContent><TotalsContent /></CardContent>
        </Card>
      </div>

      {/* ═══ MOBILE: Single Column with extra tabs ═══ */}
      <div className="md:hidden">
        <Tabs defaultValue="Members">
          <TabsList className="w-full justify-start overflow-x-auto mb-2 flex-nowrap">
            <TabsTrigger value="Members">Members</TabsTrigger>
            <TabsTrigger value="Officers">Officers</TabsTrigger>
            <TabsTrigger value="Burial">Burial</TabsTrigger>
            <TabsTrigger value="Expenses">Expenses</TabsTrigger>
            <TabsTrigger value="Banking">Banking</TabsTrigger>
            <TabsTrigger value="Totals">Totals</TabsTrigger>
          </TabsList>
          <TabsContent value="Members"><GroupedSection section="Members" types={["EFT", "Cash", "DirectDebit"]} /></TabsContent>
          <TabsContent value="Officers"><GroupedSection section="Officers" types={["Cash", "DirectDebit"]} /></TabsContent>
          <TabsContent value="Burial"><FlatSection section="Burial" types={["Cash", "EFT"]} /></TabsContent>
          <TabsContent value="Expenses"><FlatSection section="Expenses" types={["Expense"]} /></TabsContent>
          <TabsContent value="Banking"><BankingContent /></TabsContent>
          <TabsContent value="Totals"><TotalsContent /></TabsContent>
        </Tabs>

        {/* Mobile Summary Bar */}
        <div className="mt-3 rounded bg-muted/50 px-3 py-2 flex justify-between text-xs">
          <span>Income: <b>R{grandIncome.toFixed(2)}</b></span>
          {missingProofs.length > 0 ? (
            <span className="text-destructive font-medium">{missingProofs.length} Proofs Missing</span>
          ) : (
            <span className="text-green-700">All proofs OK</span>
          )}
        </div>
      </div>

      {/* ═══ STICKY FOOTER ═══ */}
      {isDraft && (
        <div className="fixed bottom-0 left-0 right-0 bg-background border-t px-3 py-3 z-40 md:sticky md:bottom-auto md:left-auto md:right-auto md:mt-4 md:rounded md:border">
          <div className="max-w-[1600px] mx-auto flex items-center justify-between gap-2">
            <span className="text-[11px] text-muted-foreground hidden sm:inline">
              {grandIncome === 0 ? "Add items to begin" : missingProofs.length > 0 ? `${missingProofs.length} proof(s) required` : "Ready to submit"}
            </span>
            <div className="flex gap-2 w-full sm:w-auto">
              {canSubmit && (
                <Button onClick={handleSubmit} disabled={submitting || grandIncome === 0 || missingProofs.length > 0} size="sm" className="flex-1 sm:flex-none">
                  {submitting ? "..." : "Submit for Audit"}
                </Button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Mobile Banking Sheet */}
      <MobileBankingSheet />
    </div>
  );
}
