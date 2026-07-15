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

// ─── Week Calculation ───────────────────────────────────────────────────────
function calcWeek(): { year: number; month: number; week: number } {
  const today = new Date();
  const y = today.getFullYear(), m = today.getMonth() + 1;
  const sundays: Date[] = [];
  for (let d = 1; d <= new Date(y, m, 0).getDate(); d++) { const dt = new Date(y, m - 1, d); if (dt.getDay() === 0) sundays.push(dt); }
  let week = 1;
  for (let i = 1; i < sundays.length; i++) { if (today >= sundays[i]) week = i; }
  return { year: y, month: m, week };
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

  const role = access?.role as Role | undefined;
  const isDraft = period?.status === "Draft";
  const canEdit = !!(role && hasPermission(role, "capture.edit") && isDraft);
  const canSubmit = !!(role && hasPermission(role, "capture.submit") && isDraft);

  // ── Load Data ─────────────────────────────────────────────────────────────
  const load = useCallback(async () => {
    setLoading(true); setError(null);
    const ua = await getUserAccess();
    if (!ua?.congregation_id) { setError("No congregation assigned."); setLoading(false); return; }
    setAccess(ua);
    const congId = ua.congregation_id;
    const { year, month, week } = calcWeek();

    // Get or create period
    let { data: p } = await supabase.from("cashbook_period").select("*").eq("congregation_id", congId).eq("year", year).eq("month", month).eq("week", week).eq("service", "AM").maybeSingle();
    if (!p) {
      const { data: { user } } = await supabase.auth.getUser();
      const { data: np } = await supabase.from("cashbook_period").insert({ congregation_id: congId, year, month, week, service: "AM", status: "Draft", submitted_by: user?.id }).select("*").single();
      p = np;
    }
    if (!p) { setError("Failed to load period."); setLoading(false); return; }
    setPeriod(p);

    // Line items + attachments + officers
    const [li, att, off] = await Promise.all([
      supabase.from("cashbook_line_item").select("*").eq("period_id", p.id).order("section"),
      supabase.from("cashbook_attachment").select("*"),
      supabase.from("officers").select("id, officer_code, first_name, last_name").eq("congregation_id", congId).eq("is_active", true).order("officer_code"),
    ]);
    setItems(li.data ?? []);
    // Filter attachments to only those belonging to our line items
    const itemIds = (li.data ?? []).map((i: LineItem) => i.id);
    setAttachments((att.data ?? []).filter((a: Attachment) => itemIds.includes(a.line_item_id)));
    setOfficers(off.data ?? []);
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  // ── CRUD ──────────────────────────────────────────────────────────────────
  async function addRow(section: string, defaultType: string) {
    if (!period || !canEdit) return;
    await supabase.from("cashbook_line_item").insert({ period_id: period.id, section, item_type: defaultType, amount: 0, officer_id: null, item_count: null, payment_type: defaultType, manual_reference: null, proof_status: null });
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
  async function uploadProof(lineItemId: string, file: File) {
    if (!canEdit || !period) return;
    const path = `proofs/${period.id}/${lineItemId}_${Date.now()}.${file.name.split(".").pop()}`;
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

  // ── Helpers ───────────────────────────────────────────────────────────────
  const sec = (s: string) => items.filter(i => i.section === s);
  const secTotal = (s: string) => sec(s).reduce((sum, i) => sum + Number(i.amount), 0);
  const byType = (s: string, t: string) => sec(s).filter(i => i.item_type === t).reduce((sum, i) => sum + Number(i.amount), 0);
  const byTypeCount = (s: string, t: string) => sec(s).filter(i => i.item_type === t).length;
  const hasProof = (id: string) => attachments.some(a => a.line_item_id === id);
  const needsProof = (item: LineItem) => item.item_type !== "Cash" || item.section === "Burial" || item.section === "Expenses";
  const missingProofs = items.filter(i => needsProof(i) && !hasProof(i.id));
  const grandIncome = secTotal("Members") + secTotal("Officers") + secTotal("Burial");

  // Group by officer for Members/Officers
  const grouped = (section: string) => {
    const map = new Map<string, { officer: Officer | null; items: LineItem[] }>();
    sec(section).forEach(item => {
      const key = item.officer_id ?? "__none__";
      if (!map.has(key)) map.set(key, { officer: officers.find(o => o.id === item.officer_id) ?? null, items: [] });
      map.get(key)!.items.push(item);
    });
    return Array.from(map.values());
  };

  if (loading) return <div className="p-8 text-muted-foreground">Loading...</div>;
  if (error) return <div className="p-8 text-destructive">{error}</div>;

  // ── Grouped Section Renderer (Members / Officers) ─────────────────────────
  function renderGrouped(section: string, typeOptions: string[]) {
    const groups = grouped(section);
    return (
      <div className="space-y-2">
        {/* Section Totals Bar */}
        <div className="flex gap-4 text-xs bg-muted/60 rounded p-2">
          {typeOptions.map(t => (
            <span key={t}>{t}: <b>R{byType(section, t).toFixed(2)}</b> ({byTypeCount(section, t)})</span>
          ))}
          <span className="ml-auto font-semibold">Total: R{secTotal(section).toFixed(2)}</span>
        </div>

        {/* Accordion groups by officer */}
        {groups.map(({ officer, items: groupItems }) => {
          const officerTotal = groupItems.reduce((s, i) => s + Number(i.amount), 0);
          const officerLabel = officer ? `${officer.officer_code} - ${officer.first_name} ${officer.last_name ?? ""}` : "Unassigned";
          return (
            <details key={officer?.id ?? "none"} className="border rounded-md" open>
              <summary className="flex items-center justify-between px-3 py-2 cursor-pointer hover:bg-muted/40 text-sm">
                <span className="font-medium">{officerLabel}</span>
                <span className="font-semibold">R{officerTotal.toFixed(2)}</span>
              </summary>
              <div className="px-3 pb-3">
                <table className="w-full text-xs">
                  <thead><tr className="border-b text-muted-foreground text-left"><th className="py-1 w-[30%]">Type</th><th className="py-1 w-[35%] text-right">Amount</th><th className="py-1 w-[20%] text-center">Proof</th><th className="py-1 w-[15%]"></th></tr></thead>
                  <tbody>
                    {groupItems.map(item => (
                      <tr key={item.id} className="border-b last:border-0">
                        <td className="py-1.5">
                          <select className="h-8 w-full rounded border border-input bg-background px-1 text-xs" value={item.item_type} onChange={e => updateRow(item.id, "item_type", e.target.value)} disabled={!canEdit}>
                            {typeOptions.map(t => <option key={t} value={t}>{t}</option>)}
                          </select>
                        </td>
                        <td className="py-1.5"><Input type="number" step="0.01" className="h-8 text-right text-xs" value={item.amount} onChange={e => updateRow(item.id, "amount", parseFloat(e.target.value) || 0)} disabled={!canEdit} /></td>
                        <td className="py-1.5 text-center">
                          {hasProof(item.id) ? (
                            <span className="text-green-600 text-sm" title="Proof uploaded">📎</span>
                          ) : needsProof(item) ? (
                            <label className="cursor-pointer text-red-500 text-sm" title="Proof required">
                              📎<input type="file" accept="image/*" capture="environment" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) uploadProof(item.id, f); }} disabled={!canEdit} />
                            </label>
                          ) : <span className="text-muted-foreground text-sm">—</span>}
                        </td>
                        <td className="py-1.5 text-right">{canEdit && <button className="text-destructive text-xs hover:underline" onClick={() => deleteRow(item.id)}>Del</button>}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          );
        })}

        {/* Add Row */}
        {canEdit && (
          <div className="flex gap-2 mt-2">
            <select id={`officer-${section}`} className="h-8 rounded border border-input bg-background px-2 text-xs flex-1">
              <option value="">Select officer...</option>
              {officers.map(o => <option key={o.id} value={o.id}>{o.officer_code} - {o.first_name}</option>)}
            </select>
            <Button size="sm" variant="outline" className="h-8 text-xs" onClick={async () => {
              const sel = (document.getElementById(`officer-${section}`) as HTMLSelectElement)?.value;
              if (!period) return;
              await supabase.from("cashbook_line_item").insert({ period_id: period.id, section, item_type: typeOptions[0], amount: 0, officer_id: sel || null });
              await load();
            }}>+ Add</Button>
          </div>
        )}
      </div>
    );
  }

  // ── Flat Section Renderer (Burial / Expenses) ─────────────────────────────
  function renderFlat(section: string, typeOptions: string[]) {
    return (
      <div className="space-y-2">
        <table className="w-full text-xs">
          <thead><tr className="border-b text-muted-foreground text-left">
            <th className="py-1 w-[30%]">Reference</th><th className="py-1 w-[20%]">Type</th><th className="py-1 w-[25%] text-right">Amount</th><th className="py-1 w-[15%] text-center">Proof</th><th className="py-1 w-[10%]"></th>
          </tr></thead>
          <tbody>
            {sec(section).map(item => (
              <tr key={item.id} className="border-b last:border-0">
                <td className="py-1.5"><Input className="h-8 text-xs" value={item.manual_reference ?? ""} onChange={e => updateRow(item.id, "manual_reference", e.target.value)} disabled={!canEdit} placeholder={section === "Burial" ? "Receipt #" : "Description"} /></td>
                <td className="py-1.5">
                  <select className="h-8 w-full rounded border border-input bg-background px-1 text-xs" value={item.item_type} onChange={e => updateRow(item.id, "item_type", e.target.value)} disabled={!canEdit}>
                    {typeOptions.map(t => <option key={t} value={t}>{t}</option>)}
                  </select>
                </td>
                <td className="py-1.5"><Input type="number" step="0.01" className="h-8 text-right text-xs" value={item.amount} onChange={e => updateRow(item.id, "amount", parseFloat(e.target.value) || 0)} disabled={!canEdit} /></td>
                <td className="py-1.5 text-center">
                  {hasProof(item.id) ? <span className="text-green-600 text-sm">📎</span> : (
                    <label className="cursor-pointer text-red-500 text-sm" title="Upload proof">
                      📎<input type="file" accept="image/*" capture="environment" className="hidden" onChange={e => { const f = e.target.files?.[0]; if (f) uploadProof(item.id, f); }} disabled={!canEdit} />
                    </label>
                  )}
                </td>
                <td className="py-1.5 text-right">{canEdit && <button className="text-destructive text-xs hover:underline" onClick={() => deleteRow(item.id)}>Del</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="flex justify-between items-center">
          {canEdit && <Button size="sm" variant="outline" className="h-8 text-xs" onClick={() => addRow(section, typeOptions[0])}>+ Add {section} Row</Button>}
          <span className="text-xs font-semibold ml-auto">Total: R{secTotal(section).toFixed(2)}</span>
        </div>
      </div>
    );
  }

  // ── Main Render ───────────────────────────────────────────────────────────
  return (
    <div className="max-w-[1600px] mx-auto px-3 py-3">
      {/* Status Bar */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2 text-xs">
          <span>Week {period?.week} · {period?.service}</span>
          <Badge variant={isDraft ? "outline" : "secondary"}>{period?.status}</Badge>
        </div>
        {success && <span className="text-xs text-green-700">{success}</span>}
      </div>

      {/* 3-Column Layout */}
      <div className="grid gap-3 lg:grid-cols-[1fr_280px_180px]">

        {/* ═══ LEFT: Capture Tabs (60%) ═══ */}
        <div className="min-w-0">
          <Tabs defaultValue="Members">
            <TabsList className="w-full justify-start mb-2">
              <TabsTrigger value="Members">Members ({sec("Members").length})</TabsTrigger>
              <TabsTrigger value="Officers">Officers ({sec("Officers").length})</TabsTrigger>
              <TabsTrigger value="Burial">Burial ({sec("Burial").length})</TabsTrigger>
              <TabsTrigger value="Expenses">Expenses ({sec("Expenses").length})</TabsTrigger>
            </TabsList>
            <TabsContent value="Members">{renderGrouped("Members", ["EFT", "Cash", "DirectDebit"])}</TabsContent>
            <TabsContent value="Officers">{renderGrouped("Officers", ["Cash", "DirectDebit"])}</TabsContent>
            <TabsContent value="Burial">{renderFlat("Burial", ["Cash", "EFT"])}</TabsContent>
            <TabsContent value="Expenses">{renderFlat("Expenses", ["Expense"])}</TabsContent>
          </Tabs>
        </div>

        {/* ═══ CENTER-RIGHT: Banking Panel (25%) ═══ */}
        <Card className="h-fit">
          <CardHeader className="pb-2"><CardTitle className="text-xs uppercase text-muted-foreground tracking-wider">Banking</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-xs">
            <div>
              <p className="font-semibold text-sm mb-1">INCOME: R{grandIncome.toFixed(2)}</p>
              <div className="space-y-0.5 pl-2 text-muted-foreground">
                <p>EFT: R{(byType("Members", "EFT") + byType("Officers", "EFT") + byType("Burial", "EFT")).toFixed(2)}</p>
                <p>Direct Debit: R{(byType("Members", "DirectDebit") + byType("Officers", "DirectDebit")).toFixed(2)}</p>
                <p>Cash: R{(byType("Members", "Cash") + byType("Officers", "Cash") + byType("Burial", "Cash")).toFixed(2)}</p>
              </div>
            </div>
            <div className="border-t pt-2">
              <p className="font-semibold text-sm">EXPENSES: R{secTotal("Expenses").toFixed(2)}</p>
            </div>
            <div className="border-t pt-2">
              <p className="font-bold text-sm text-primary">BANK BALANCE: R{(grandIncome - secTotal("Expenses")).toFixed(2)}</p>
            </div>
          </CardContent>
        </Card>

        {/* ═══ FAR-RIGHT: Totals + Status (15%) ═══ */}
        <div className="space-y-3">
          <Card className="h-fit">
            <CardHeader className="pb-1"><CardTitle className="text-[10px] uppercase text-muted-foreground tracking-wider">Totals</CardTitle></CardHeader>
            <CardContent className="space-y-1 text-xs">
              <div className="flex justify-between"><span>Members</span><span className="font-semibold">R{secTotal("Members").toFixed(2)}</span></div>
              <div className="flex justify-between"><span>Officers</span><span className="font-semibold">R{secTotal("Officers").toFixed(2)}</span></div>
              <div className="flex justify-between"><span>Burial</span><span className="font-semibold">R{secTotal("Burial").toFixed(2)}</span></div>
              <div className="flex justify-between border-t pt-1 font-bold"><span>Income</span><span>R{grandIncome.toFixed(2)}</span></div>
              <div className="flex justify-between text-muted-foreground"><span>Expenses</span><span>R{secTotal("Expenses").toFixed(2)}</span></div>
            </CardContent>
          </Card>

          <Card className="h-fit">
            <CardHeader className="pb-1"><CardTitle className="text-[10px] uppercase text-muted-foreground tracking-wider">Audit</CardTitle></CardHeader>
            <CardContent>
              <Badge variant={period?.status === "AuditApproved" ? "default" : period?.status === "Submitted" ? "secondary" : "outline"} className="text-[10px]">
                {period?.status}
              </Badge>
              {missingProofs.length > 0 && isDraft && (
                <p className="text-[10px] text-destructive mt-2">{missingProofs.length} proof(s) missing</p>
              )}
            </CardContent>
          </Card>
        </div>
      </div>

      {/* ═══ STICKY FOOTER ═══ */}
      {isDraft && (
        <div className="sticky bottom-0 bg-background border-t mt-4 py-3 px-3 -mx-3 flex items-center justify-between">
          <span className="text-xs text-muted-foreground">
            {grandIncome === 0 ? "Add line items to enable submission" : missingProofs.length > 0 ? `${missingProofs.length} required proof(s) missing` : "Ready to submit"}
          </span>
          <div className="flex gap-2">
            {canSubmit && (
              <Button onClick={handleSubmit} disabled={submitting || grandIncome === 0 || missingProofs.length > 0} size="sm">
                {submitting ? "Submitting..." : "Submit for Audit"}
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
