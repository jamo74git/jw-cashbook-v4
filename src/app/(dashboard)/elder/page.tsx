"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { getUserAccess } from "@/lib/permissions";
import { AppHeader } from "@/components/AppHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import type { UserHierarchyAccess } from "@/lib/types";

// ─── Types ──────────────────────────────────────────────────────────────────
interface Congregation { id: string; name: string; code: string; }
interface TitheRow { congregation: string; memberTithe: number; officerTithe: number; total: number; lastMonthTotal: number; pctChange: number | null; }
interface MissingOfficer { officerCode: string; firstName: string; lastName: string | null; congregation: string; }
interface CashRisk { officerCode: string; amount: number; paymentType: string; congregation: string; }
interface CongStatus { id: string; name: string; code: string; status: string | null; pending: number; periodId: string | null; }
interface Settings { id?: string; congregation_id: string; expense_approval_threshold: number; proof_mandatory: boolean; allow_chair_submit: boolean; }

export default function ElderPageV2() {
  const supabase = createClient();
  const [access, setAccess] = useState<UserHierarchyAccess | null>(null);
  const [congregations, setCongregations] = useState<Congregation[]>([]);
  const [titheRows, setTitheRows] = useState<TitheRow[]>([]);
  const [missingOfficers, setMissingOfficers] = useState<MissingOfficer[]>([]);
  const [cashRisks, setCashRisks] = useState<CashRisk[]>([]);
  const [congStatuses, setCongStatuses] = useState<CongStatus[]>([]);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [showSettings, setShowSettings] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  const [selectedMonth, setSelectedMonth] = useState(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`; });

  useEffect(() => { loadAll(); }, [selectedMonth]);

  async function loadAll() {
    setLoading(true);
    const ua = await getUserAccess();
    if (!ua) { setLoading(false); return; }
    setAccess(ua);

    // Get Elder's congregations via eldership_id
    const { data: congs } = await supabase.from("congregations").select("id, name, code").eq("eldership_id", ua.hierarchy_id);
    const congList = congs ?? [];
    setCongregations(congList);
    const congIds = congList.map(c => c.id);
    if (congIds.length === 0) { setLoading(false); return; }

    // Parse selected month
    const [year, month] = selectedMonth.split("-").map(Number);
    const lastYear = month === 1 ? year - 1 : year;
    const lastMonth = month === 1 ? 12 : month - 1;

    // Get all periods for this month + last month for these congregations
    const { data: thisMonthPeriods } = await supabase.from("cashbook_period").select("id, congregation_id").in("congregation_id", congIds).eq("year", year).eq("month", month);
    const { data: lastMonthPeriods } = await supabase.from("cashbook_period").select("id, congregation_id").in("congregation_id", congIds).eq("year", lastYear).eq("month", lastMonth);

    const thisPeriodIds = (thisMonthPeriods ?? []).map(p => p.id);
    const lastPeriodIds = (lastMonthPeriods ?? []).map(p => p.id);

    // Get line items for this month (Members + Officers, excluding Burial)
    const { data: thisItems } = thisPeriodIds.length > 0
      ? await supabase.from("cashbook_line_item").select("period_id, section, is_officer, item_type, amount, officer_id").in("period_id", thisPeriodIds).in("section", ["Members", "Officers"])
      : { data: [] };
    const { data: lastItems } = lastPeriodIds.length > 0
      ? await supabase.from("cashbook_line_item").select("period_id, section, is_officer, amount").in("period_id", lastPeriodIds).in("section", ["Members", "Officers"])
      : { data: [] };

    // Build tithe rows per congregation
    const rows: TitheRow[] = congList.map(c => {
      const cThisPeriodIds = (thisMonthPeriods ?? []).filter(p => p.congregation_id === c.id).map(p => p.id);
      const cLastPeriodIds = (lastMonthPeriods ?? []).filter(p => p.congregation_id === c.id).map(p => p.id);
      const cThisItems = (thisItems ?? []).filter(i => cThisPeriodIds.includes(i.period_id));
      const cLastItems = (lastItems ?? []).filter(i => cLastPeriodIds.includes(i.period_id));

      const memberTithe = cThisItems.filter(i => !i.is_officer).reduce((s, i) => s + Number(i.amount), 0);
      const officerTithe = cThisItems.filter(i => i.is_officer).reduce((s, i) => s + Number(i.amount), 0);
      const total = memberTithe + officerTithe;
      const lastTotal = cLastItems.reduce((s, i) => s + Number(i.amount), 0);
      const pctChange = lastTotal > 0 ? Math.round(((total - lastTotal) / lastTotal) * 1000) / 10 : null;

      return { congregation: c.name, memberTithe, officerTithe, total, lastMonthTotal: lastTotal, pctChange };
    });
    setTitheRows(rows);

    // Officers missing tithe this month
    const { data: allOfficers } = await supabase.from("officers").select("id, officer_code, first_name, last_name, congregation_id").in("congregation_id", congIds).eq("is_active", true);
    const officersWithTithe = new Set((thisItems ?? []).filter(i => i.is_officer && i.officer_id).map(i => i.officer_id));
    const missing: MissingOfficer[] = (allOfficers ?? []).filter(o => !officersWithTithe.has(o.id)).map(o => ({
      officerCode: o.officer_code, firstName: o.first_name, lastName: o.last_name,
      congregation: congList.find(c => c.id === o.congregation_id)?.name ?? "",
    }));
    setMissingOfficers(missing);

    // Cash risk: EFT/DD without proof (top 3)
    const { data: riskyItems } = thisPeriodIds.length > 0
      ? await supabase.from("cashbook_line_item").select("id, officer_id, amount, item_type, period_id, proof_status")
          .in("period_id", thisPeriodIds).in("item_type", ["EFT", "DirectDeposit"]).is("proof_status", null).order("amount", { ascending: false }).limit(3)
      : { data: [] };
    const risks: CashRisk[] = (riskyItems ?? []).map(i => {
      const periodCong = (thisMonthPeriods ?? []).find(p => p.id === i.period_id)?.congregation_id;
      const off = (allOfficers ?? []).find(o => o.id === i.officer_id);
      return { officerCode: off?.officer_code ?? "—", amount: Number(i.amount), paymentType: i.item_type, congregation: congList.find(c => c.id === periodCong)?.name ?? "" };
    });
    setCashRisks(risks);

    // Congregation statuses
    const statuses: CongStatus[] = [];
    for (const c of congList) {
      const { data: period } = await supabase.from("cashbook_period").select("id, status").eq("congregation_id", c.id).eq("year", year).eq("month", month).order("week", { ascending: false }).limit(1).maybeSingle();
      const { count } = await supabase.from("cashbook_period").select("id", { count: "exact", head: true }).eq("congregation_id", c.id).eq("status", "Submitted");
      statuses.push({ id: c.id, name: c.name, code: c.code, status: period?.status ?? null, pending: count ?? 0, periodId: period?.id ?? null });
    }
    setCongStatuses(statuses);

    // Settings
    const { data: s } = await supabase.from("congregation_settings").select("*").eq("congregation_id", congIds[0]).maybeSingle();
    setSettings(s ?? { congregation_id: congIds[0], expense_approval_threshold: 500, proof_mandatory: false, allow_chair_submit: true });

    setLoading(false);
  }

  async function handleSaveSettings() {
    if (!settings || !access) return;
    setSaving(true);
    const { data: { user } } = await supabase.auth.getUser();
    if (settings.id) {
      await supabase.from("congregation_settings").update({ expense_approval_threshold: settings.expense_approval_threshold, proof_mandatory: settings.proof_mandatory, allow_chair_submit: settings.allow_chair_submit, updated_by: user?.id, updated_at: new Date().toISOString() }).eq("id", settings.id);
    } else {
      await supabase.from("congregation_settings").insert({ ...settings, updated_by: user?.id });
    }
    setSaving(false); setShowSettings(false); setSuccess("Settings saved.");
  }

  async function handleSubmitToOverseer() {
    if (!access) return;
    setSubmitting(true);
    const congIds = congregations.map(c => c.id);
    await supabase.from("cashbook_period").update({ status: "SubmittedToHO" }).in("congregation_id", congIds).eq("status", "Submitted");
    setSuccess("Submitted to Overseer."); setSubmitting(false);
    await loadAll();
  }

  if (loading) return <><AppHeader /><div className="p-6 text-sm text-muted-foreground">Loading...</div></>;

  const readyCount = congStatuses.filter(c => c.status && c.status !== "Draft").length;
  const allReady = readyCount === congStatuses.length && congStatuses.length > 0;

  return (
    <>
      <AppHeader />
      <div className="max-w-5xl mx-auto px-4 py-4 space-y-4">
        {/* Month selector */}
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-bold">Elder Dashboard</h1>
          <input type="month" className="h-8 rounded border border-input bg-background px-2 text-xs" value={selectedMonth} onChange={e => setSelectedMonth(e.target.value)} />
        </div>

        {success && <div className="rounded border border-green-300 bg-green-50 p-2 text-xs text-green-800">{success}</div>}

        {/* ═══ TABS ═══ */}
        <Tabs defaultValue="tithe">
          <TabsList className="w-full justify-start">
            <TabsTrigger value="tithe">Monthly Overview</TabsTrigger>
            <TabsTrigger value="status">Congregations</TabsTrigger>
            <TabsTrigger value="risk">Risk & Audit</TabsTrigger>
          </TabsList>

          {/* ─── TAB 1: Monthly Overview (Tithe) ─── */}
          <TabsContent value="tithe">
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm">Tithe Summary — {selectedMonth}</CardTitle></CardHeader>
              <CardContent>
                <table className="w-full text-xs">
                  <thead><tr className="border-b text-left text-muted-foreground">
                    <th className="pb-2">Congregation</th><th className="pb-2 text-right">Member Tithe</th><th className="pb-2 text-right">Officer Tithe</th><th className="pb-2 text-right">Total</th><th className="pb-2 text-right">vs Last Month</th>
                  </tr></thead>
                  <tbody>
                    {titheRows.map(r => (
                      <tr key={r.congregation} className="border-b last:border-0">
                        <td className="py-2 font-medium">{r.congregation}</td>
                        <td className="py-2 text-right">R{r.memberTithe.toFixed(2)}</td>
                        <td className="py-2 text-right">R{r.officerTithe.toFixed(2)}</td>
                        <td className="py-2 text-right font-semibold">R{r.total.toFixed(2)}</td>
                        <td className="py-2 text-right">
                          {r.pctChange !== null ? (
                            <span className={r.pctChange >= 0 ? "text-green-600" : "text-destructive"}>{r.pctChange > 0 ? "+" : ""}{r.pctChange}%</span>
                          ) : <span className="text-muted-foreground">—</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {/* Totals row */}
                <div className="flex justify-between pt-2 border-t text-xs font-bold">
                  <span>Grand Total</span>
                  <span>R{titheRows.reduce((s, r) => s + r.total, 0).toFixed(2)}</span>
                </div>
              </CardContent>
            </Card>

            {/* Officers missing tithe */}
            {missingOfficers.length > 0 && (
              <Card className="mt-3 border-destructive/30">
                <CardHeader className="pb-1"><CardTitle className="text-xs text-destructive">Officers with R0 Tithe this month</CardTitle></CardHeader>
                <CardContent>
                  <div className="flex flex-wrap gap-2 text-[10px]">
                    {missingOfficers.slice(0, 10).map((o, i) => (
                      <span key={i} className="bg-destructive/10 text-destructive px-2 py-0.5 rounded">{o.officerCode} - {o.firstName} ({o.congregation})</span>
                    ))}
                    {missingOfficers.length > 10 && <span className="text-muted-foreground">+{missingOfficers.length - 10} more</span>}
                  </div>
                </CardContent>
              </Card>
            )}
          </TabsContent>

          {/* ─── TAB 2: Congregations Status ─── */}
          <TabsContent value="status">
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm">Congregation Status</CardTitle></CardHeader>
              <CardContent>
                <table className="w-full text-xs">
                  <thead><tr className="border-b text-left text-muted-foreground">
                    <th className="pb-2">Name</th><th className="pb-2">Code</th><th className="pb-2">Status</th><th className="pb-2">Pending</th><th className="pb-2">Action</th>
                  </tr></thead>
                  <tbody>
                    {congStatuses.map(c => (
                      <tr key={c.id} className="border-b last:border-0">
                        <td className="py-2 font-medium">{c.name}</td>
                        <td className="py-2">{c.code}</td>
                        <td className="py-2"><Badge variant={c.status === "Draft" ? "outline" : c.status === "Submitted" ? "secondary" : "default"} className="text-[9px]">{c.status ?? "—"}</Badge></td>
                        <td className="py-2">{c.pending > 0 ? <span className="text-orange-600 font-medium">{c.pending}</span> : "0"}</td>
                        <td className="py-2">
                          {c.status === "Draft" && c.periodId && <Button size="sm" className="h-6 text-[10px]" onClick={async () => { await supabase.from("cashbook_period").update({ status: "Submitted", submitted_at: new Date().toISOString() }).eq("id", c.periodId); await loadAll(); }}>Submit</Button>}
                          {c.status === "Submitted" && <span className="text-xs text-muted-foreground">Awaiting audit</span>}
                          {c.status === "AuditApproved" && <Badge variant="default" className="text-[9px]">Done</Badge>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </CardContent>
            </Card>

            {/* Monthly Close */}
            <Card className="mt-3">
              <CardHeader className="pb-2"><CardTitle className="text-sm">Monthly Close</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                <p className="text-xs">{readyCount} of {congStatuses.length} congregations ready</p>
                <Button size="sm" onClick={handleSubmitToOverseer} disabled={!allReady || submitting}>{submitting ? "..." : "Submit All to Overseer"}</Button>
              </CardContent>
            </Card>
          </TabsContent>

          {/* ─── TAB 3: Risk & Audit ─── */}
          <TabsContent value="risk">
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-sm">Cash Risk — Missing Proofs (Top 3)</CardTitle></CardHeader>
              <CardContent>
                {cashRisks.length === 0 ? <p className="text-xs text-muted-foreground">No outstanding proof issues.</p> : (
                  <table className="w-full text-xs">
                    <thead><tr className="border-b text-left text-muted-foreground"><th className="pb-1">Officer</th><th className="pb-1">Type</th><th className="pb-1 text-right">Amount</th><th className="pb-1">Congregation</th></tr></thead>
                    <tbody>{cashRisks.map((r, i) => (
                      <tr key={i} className="border-b last:border-0">
                        <td className="py-1.5 font-medium">{r.officerCode}</td><td className="py-1.5">{r.paymentType}</td>
                        <td className="py-1.5 text-right font-medium text-destructive">R{r.amount.toFixed(2)}</td><td className="py-1.5">{r.congregation}</td>
                      </tr>
                    ))}</tbody>
                  </table>
                )}
              </CardContent>
            </Card>

            <Card className="mt-3">
              <CardHeader className="pb-2"><CardTitle className="text-sm">Expense Governance</CardTitle></CardHeader>
              <CardContent>
                <p className="text-xs text-muted-foreground">Threshold: R{settings?.expense_approval_threshold ?? 500}</p>
                <Button size="sm" variant="outline" className="mt-2" onClick={() => setShowSettings(true)}>Update Settings</Button>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>

        {/* ═══ SETTINGS MODAL ═══ */}
        {showSettings && settings && (
          <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
            <div className="absolute inset-0 bg-black/50" onClick={() => setShowSettings(false)} />
            <Card className="relative z-10 w-full max-w-sm">
              <CardHeader className="pb-2"><CardTitle className="text-sm">Congregation Settings</CardTitle></CardHeader>
              <CardContent className="space-y-4">
                <div className="space-y-1">
                  <Label className="text-xs">Expense Approval Threshold (R)</Label>
                  <Input type="number" className="h-9 text-xs" value={settings.expense_approval_threshold} onChange={e => setSettings({ ...settings, expense_approval_threshold: parseFloat(e.target.value) || 500 })} />
                </div>
                <div className="flex items-center justify-between">
                  <Label className="text-xs">Require Proof for EFT/DD</Label>
                  <button onClick={() => setSettings({ ...settings, proof_mandatory: !settings.proof_mandatory })} className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${settings.proof_mandatory ? "bg-primary" : "bg-muted"}`}>
                    <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${settings.proof_mandatory ? "translate-x-4" : "translate-x-0.5"}`} />
                  </button>
                </div>
                <div className="flex items-center justify-between">
                  <Label className="text-xs">Allow Chair Submit on Behalf</Label>
                  <button onClick={() => setSettings({ ...settings, allow_chair_submit: !settings.allow_chair_submit })} className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${settings.allow_chair_submit ? "bg-primary" : "bg-muted"}`}>
                    <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${settings.allow_chair_submit ? "translate-x-4" : "translate-x-0.5"}`} />
                  </button>
                </div>
                <div className="flex gap-2">
                  <Button size="sm" onClick={handleSaveSettings} disabled={saving}>{saving ? "..." : "Save"}</Button>
                  <Button size="sm" variant="outline" onClick={() => setShowSettings(false)}>Cancel</Button>
                </div>
              </CardContent>
            </Card>
          </div>
        )}
      </div>
    </>
  );
}
