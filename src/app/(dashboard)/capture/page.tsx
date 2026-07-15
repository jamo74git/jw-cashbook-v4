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

// ─── Types (matching real Supabase schema) ──────────────────────────────────

interface CashbookPeriod {
  id: string;
  congregation_id: string;
  year: number;
  month: number;
  week: number;
  service: string;
  status: string;
  submitted_by: string | null;
  submitted_at: string | null;
  expenses_total: number | null;
}

interface LineItem {
  id: string;
  period_id: string;
  section: string;
  officer_id: string | null;
  item_type: string;
  item_count: number | null;
  amount: number;
  proof_status: string | null;
  payment_type: string | null;
  manual_reference: string | null;
}

interface OfficerRow {
  id: string;
  officer_code: string;
  first_name: string;
  last_name: string | null;
}

// ─── Week Calculation (Week1 = 2nd Sunday) ──────────────────────────────────

function calculateCurrentWeek(): { year: number; month: number; week: number; serviceDate: string } {
  const today = new Date();
  const year = today.getFullYear();
  const month = today.getMonth() + 1;

  // Find all Sundays in this month
  const sundays: Date[] = [];
  const daysInMonth = new Date(year, month, 0).getDate();
  for (let d = 1; d <= daysInMonth; d++) {
    const date = new Date(year, month - 1, d);
    if (date.getDay() === 0) sundays.push(date);
  }

  // Week1 starts on 2nd Sunday, last week starts on 1st Sunday of next month
  // Find which week we're in
  let week = 1;
  for (let i = 1; i < sundays.length; i++) {
    if (today >= sundays[i]) week = i;
  }

  const serviceDate = today.toISOString().split("T")[0];
  return { year, month, week, serviceDate };
}

export default function CapturePage() {
  const supabase = createClient();

  const [access, setAccess] = useState<UserHierarchyAccess | null>(null);
  const [congName, setCongName] = useState("");
  const [congCode, setCongCode] = useState("");
  const [elderName, setElderName] = useState("—");
  const [overseerName, setOverseerName] = useState("—");
  const [period, setPeriod] = useState<CashbookPeriod | null>(null);
  const [lineItems, setLineItems] = useState<LineItem[]>([]);
  const [officers, setOfficers] = useState<OfficerRow[]>([]);
  const [mtdMembers, setMtdMembers] = useState(0);
  const [mtdOfficers, setMtdOfficers] = useState(0);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const role = access?.role as Role | undefined;
  const isLocked = period?.status !== "draft";
  const canEdit = role ? hasPermission(role, "capture.edit") && !isLocked : false;
  const canSubmit = role ? hasPermission(role, "capture.submit") && !isLocked : false;

  // ── Load All Data ─────────────────────────────────────────────────────────
  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);

    const userAccess = await getUserAccess();
    if (!userAccess) { setError("Not authenticated."); setLoading(false); return; }
    setAccess(userAccess);

    const congId = userAccess.congregation_id;
    if (!congId) { setError("No congregation assigned."); setLoading(false); return; }

    // Fetch congregation + hierarchy names
    const { data: cong } = await supabase
      .from("congregations")
      .select("name, code, eldership_id, overseership_id")
      .eq("id", congId)
      .single();
    if (cong) {
      setCongName(cong.name);
      setCongCode(cong.code);
      // Fetch elder name from hierarchy
      if (cong.eldership_id) {
        const { data: eld } = await supabase.from("hierarchy_levels").select("name").eq("id", cong.eldership_id).single();
        if (eld) setElderName(eld.name);
      }
      if (cong.overseership_id) {
        const { data: ovr } = await supabase.from("hierarchy_levels").select("name").eq("id", cong.overseership_id).single();
        if (ovr) setOverseerName(ovr.name);
      }
    }

    // Calculate current week
    const { year, month, week } = calculateCurrentWeek();
    const service = "AM";

    // Get or create cashbook_period
    let { data: existingPeriod } = await supabase
      .from("cashbook_period")
      .select("*")
      .eq("congregation_id", congId)
      .eq("year", year)
      .eq("month", month)
      .eq("week", week)
      .eq("service", service)
      .maybeSingle();

    if (!existingPeriod) {
      const { data: { user } } = await supabase.auth.getUser();
      const { data: newPeriod } = await supabase
        .from("cashbook_period")
        .insert({ congregation_id: congId, year, month, week, service, status: "draft", submitted_by: user?.id })
        .select("*")
        .single();
      existingPeriod = newPeriod;
    }

    if (!existingPeriod) { setError("Failed to load/create period."); setLoading(false); return; }
    setPeriod(existingPeriod);

    // Fetch line items for this period
    const { data: items } = await supabase
      .from("cashbook_line_item")
      .select("*")
      .eq("period_id", existingPeriod.id)
      .order("section");
    setLineItems((items as LineItem[]) ?? []);

    // Fetch officers for dropdown
    const { data: offs } = await supabase
      .from("officers")
      .select("id, officer_code, first_name, last_name")
      .eq("congregation_id", congId)
      .eq("is_active", true)
      .order("officer_code");
    setOfficers((offs as OfficerRow[]) ?? []);

    // MTD Totals: sum across all periods for this month
    const { data: mtdItems } = await supabase
      .from("cashbook_line_item")
      .select("section, amount, period_id")
      .in("period_id",
        (await supabase.from("cashbook_period").select("id").eq("congregation_id", congId).eq("year", year).eq("month", month))
          .data?.map((p: { id: string }) => p.id) ?? []
      );

    const mtd = mtdItems ?? [];
    setMtdMembers(mtd.filter((i) => i.section === "Members").reduce((s, i) => s + Number(i.amount), 0));
    setMtdOfficers(mtd.filter((i) => i.section === "Officers").reduce((s, i) => s + Number(i.amount), 0));

    setLoading(false);
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  // ── CRUD Operations ───────────────────────────────────────────────────────
  async function addRow(section: string, defaultType: string) {
    if (!period || !canEdit) return;
    await supabase.from("cashbook_line_item").insert({
      period_id: period.id,
      section,
      item_type: defaultType,
      amount: 0,
      officer_id: null,
      item_count: null,
      payment_type: defaultType,
      proof_status: null,
      manual_reference: null,
    });
    await loadData();
  }

  async function updateRow(id: string, field: string, value: string | number | null) {
    if (!canEdit) return;
    await supabase.from("cashbook_line_item").update({ [field]: value }).eq("id", id);
    await loadData();
  }

  async function deleteRow(id: string) {
    if (!canEdit) return;
    // Also delete attachments
    await supabase.from("cashbook_attachment").delete().eq("line_item_id", id);
    await supabase.from("cashbook_line_item").delete().eq("id", id);
    await loadData();
  }

  async function uploadProof(lineItemId: string, file: File) {
    if (!canEdit) return;
    const path = `proofs/${period?.id}/${lineItemId}_${Date.now()}.${file.name.split(".").pop()}`;
    const { error: upErr } = await supabase.storage.from("burial_proofs").upload(path, file);
    if (upErr) { setError(upErr.message); return; }
    const { data: urlData } = supabase.storage.from("burial_proofs").getPublicUrl(path);
    const { data: { user } } = await supabase.auth.getUser();
    await supabase.from("cashbook_attachment").insert({
      line_item_id: lineItemId,
      file_url: urlData.publicUrl,
      uploaded_by: user?.id,
    });
    await supabase.from("cashbook_line_item").update({ proof_status: "uploaded" }).eq("id", lineItemId);
    await loadData();
  }

  // ── Submit for Audit ──────────────────────────────────────────────────────
  async function handleSubmit() {
    if (!period || !access || !canSubmit) return;

    if (role && isOverrideAction(role, "capture.submit")) {
      const ok = window.confirm("You are submitting as Treasurer. This will be logged as SELF_REVIEW_EXCEPTION. Continue?");
      if (!ok) return;
      await logSelfReviewException({
        userId: access.user_id, entityType: "cashbook_period", entityId: period.id,
        assumedRole: "Treasurer", comment: `${role} submitted for audit`,
      });
    }

    setSubmitting(true);
    const { data: { user } } = await supabase.auth.getUser();
    const { error: err } = await supabase
      .from("cashbook_period")
      .update({ status: "pending_audit", submitted_by: user?.id, submitted_at: new Date().toISOString() })
      .eq("id", period.id);

    if (err) { setError(err.message); }
    else { setSuccess("Submitted for audit."); }
    setSubmitting(false);
    await loadData();
  }

  // ── Totals ────────────────────────────────────────────────────────────────
  const sectionItems = (section: string) => lineItems.filter((i) => i.section === section);
  const sectionTotal = (section: string) => sectionItems(section).reduce((s, i) => s + Number(i.amount), 0);
  const grandTotal = sectionTotal("Members") + sectionTotal("Officers") + sectionTotal("Burial");

  // ── Render ────────────────────────────────────────────────────────────────
  if (loading) return <div className="p-8 text-muted-foreground">Loading capture...</div>;

  if (!role || !hasPermission(role, "capture.view")) {
    return <div className="p-8 text-destructive">Access denied.</div>;
  }

  const weekInfo = calculateCurrentWeek();

  return (
    <div className="bg-muted/40 min-h-[calc(100vh-3.5rem)]">
      <div className="max-w-7xl mx-auto px-4 py-4 space-y-4">
        {/* ═══ HEADER CARD ═══ */}
        <Card>
          <CardContent className="py-4">
            <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-8 gap-3 text-sm">
              <div>
                <span className="text-[10px] uppercase text-muted-foreground font-medium">Cong No</span>
                <p className="font-semibold">{congCode}</p>
              </div>
              <div>
                <span className="text-[10px] uppercase text-muted-foreground font-medium">Congregation</span>
                <p className="font-semibold">{congName}</p>
              </div>
              <div>
                <span className="text-[10px] uppercase text-muted-foreground font-medium">Elder</span>
                <p className="font-semibold truncate">{elderName}</p>
              </div>
              <div>
                <span className="text-[10px] uppercase text-muted-foreground font-medium">Overseer</span>
                <p className="font-semibold truncate">{overseerName}</p>
              </div>
              <div>
                <span className="text-[10px] uppercase text-muted-foreground font-medium">Month</span>
                <p className="font-semibold">{period?.month ?? weekInfo.month}</p>
              </div>
              <div>
                <span className="text-[10px] uppercase text-muted-foreground font-medium">Week</span>
                <p className="font-semibold">{period?.week ?? weekInfo.week}</p>
              </div>
              <div>
                <span className="text-[10px] uppercase text-muted-foreground font-medium">Service</span>
                <p className="font-semibold">{period?.service ?? "AM"}</p>
              </div>
              <div>
                <span className="text-[10px] uppercase text-muted-foreground font-medium">Status</span>
                <Badge variant={period?.status === "draft" ? "outline" : period?.status === "audit_approved" ? "default" : "secondary"}>
                  {period?.status?.replace("_", " ").toUpperCase() ?? "DRAFT"}
                </Badge>
              </div>
            </div>
          </CardContent>
        </Card>

        {error && <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3 text-sm text-destructive">{error}</div>}
        {success && <div className="rounded-md border border-green-300 bg-green-50 p-3 text-sm text-green-800">{success}</div>}

        {/* ═══ MAIN CONTENT: Left (Tabs) + Right (Sidebar) ═══ */}
        <div className="grid gap-4 lg:grid-cols-[1fr_300px]">
          {/* LEFT: Capture Tabs */}
          <div>
            <Tabs defaultValue="Members">
              <TabsList className="w-full justify-start">
                <TabsTrigger value="Members">Members ({sectionItems("Members").length})</TabsTrigger>
                <TabsTrigger value="Officers">Officers ({sectionItems("Officers").length})</TabsTrigger>
                <TabsTrigger value="Burial">Burial ({sectionItems("Burial").length})</TabsTrigger>
                <TabsTrigger value="Expenses">Expenses ({sectionItems("Expenses").length})</TabsTrigger>
              </TabsList>

              {/* ─── Members Tab ──────────────────────────────────────── */}
              <TabsContent value="Members">
                <Card>
                  <CardHeader className="pb-2 flex-row items-center justify-between">
                    <CardTitle className="text-sm">Members Tithing</CardTitle>
                    {canEdit && <Button size="sm" variant="outline" onClick={() => addRow("Members", "Cash")}>+ Add Row</Button>}
                  </CardHeader>
                  <CardContent>
                    <table className="w-full text-sm">
                      <thead><tr className="border-b text-left text-xs text-muted-foreground">
                        <th className="pb-2 w-[35%]">Officer</th>
                        <th className="pb-2 w-[20%]">Type</th>
                        <th className="pb-2 w-[25%] text-right">Amount (R)</th>
                        <th className="pb-2 w-[20%]"></th>
                      </tr></thead>
                      <tbody>
                        {sectionItems("Members").map((item) => (
                          <tr key={item.id} className="border-b last:border-0">
                            <td className="py-2">
                              <select className="h-9 w-full rounded border border-input bg-background px-2 text-sm" value={item.officer_id ?? ""} onChange={(e) => updateRow(item.id, "officer_id", e.target.value || null)} disabled={!canEdit}>
                                <option value="">Select officer...</option>
                                {officers.map((o) => <option key={o.id} value={o.id}>{o.officer_code} - {o.first_name}</option>)}
                              </select>
                            </td>
                            <td className="py-2">
                              <select className="h-9 w-full rounded border border-input bg-background px-2 text-sm" value={item.item_type} onChange={(e) => updateRow(item.id, "item_type", e.target.value)} disabled={!canEdit}>
                                <option value="EFT">EFT</option>
                                <option value="Cash">Cash</option>
                                <option value="DirectDebit">Direct Debit</option>
                              </select>
                            </td>
                            <td className="py-2"><Input type="number" step="0.01" className="h-9 text-right" value={item.amount} onChange={(e) => updateRow(item.id, "amount", parseFloat(e.target.value) || 0)} disabled={!canEdit} /></td>
                            <td className="py-2 text-right">{canEdit && <Button variant="ghost" size="sm" className="text-destructive h-7" onClick={() => deleteRow(item.id)}>X</Button>}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <div className="mt-3 pt-3 border-t flex justify-end text-sm font-semibold">Total Members: R{sectionTotal("Members").toFixed(2)}</div>
                  </CardContent>
                </Card>
              </TabsContent>

              {/* ─── Officers Tab ─────────────────────────────────────── */}
              <TabsContent value="Officers">
                <Card>
                  <CardHeader className="pb-2 flex-row items-center justify-between">
                    <CardTitle className="text-sm">Officers Tithing</CardTitle>
                    {canEdit && <Button size="sm" variant="outline" onClick={() => addRow("Officers", "Cash")}>+ Add Row</Button>}
                  </CardHeader>
                  <CardContent>
                    <table className="w-full text-sm">
                      <thead><tr className="border-b text-left text-xs text-muted-foreground">
                        <th className="pb-2 w-[35%]">Officer</th>
                        <th className="pb-2 w-[20%]">Type</th>
                        <th className="pb-2 w-[25%] text-right">Amount (R)</th>
                        <th className="pb-2 w-[20%]"></th>
                      </tr></thead>
                      <tbody>
                        {sectionItems("Officers").map((item) => (
                          <tr key={item.id} className="border-b last:border-0">
                            <td className="py-2">
                              <select className="h-9 w-full rounded border border-input bg-background px-2 text-sm" value={item.officer_id ?? ""} onChange={(e) => updateRow(item.id, "officer_id", e.target.value || null)} disabled={!canEdit}>
                                <option value="">Select officer...</option>
                                {officers.map((o) => <option key={o.id} value={o.id}>{o.officer_code} - {o.first_name}</option>)}
                              </select>
                            </td>
                            <td className="py-2">
                              <select className="h-9 w-full rounded border border-input bg-background px-2 text-sm" value={item.item_type} onChange={(e) => updateRow(item.id, "item_type", e.target.value)} disabled={!canEdit}>
                                <option value="Cash">Cash</option>
                                <option value="DirectDebit">Direct Debit</option>
                              </select>
                            </td>
                            <td className="py-2"><Input type="number" step="0.01" className="h-9 text-right" value={item.amount} onChange={(e) => updateRow(item.id, "amount", parseFloat(e.target.value) || 0)} disabled={!canEdit} /></td>
                            <td className="py-2 text-right">{canEdit && <Button variant="ghost" size="sm" className="text-destructive h-7" onClick={() => deleteRow(item.id)}>X</Button>}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <div className="mt-3 pt-3 border-t flex justify-end text-sm font-semibold">Total Officers: R{sectionTotal("Officers").toFixed(2)}</div>
                  </CardContent>
                </Card>
              </TabsContent>

              {/* ─── Burial Tab ────────────────────────────────────────── */}
              <TabsContent value="Burial">
                <Card>
                  <CardHeader className="pb-2 flex-row items-center justify-between">
                    <CardTitle className="text-sm">Burial Offerings</CardTitle>
                    {canEdit && <Button size="sm" variant="outline" onClick={() => addRow("Burial", "Cash")}>+ Add Row</Button>}
                  </CardHeader>
                  <CardContent>
                    <table className="w-full text-sm">
                      <thead><tr className="border-b text-left text-xs text-muted-foreground">
                        <th className="pb-2 w-[25%]">Receipt #</th>
                        <th className="pb-2 w-[15%]">Type</th>
                        <th className="pb-2 w-[20%] text-right">Amount (R)</th>
                        <th className="pb-2 w-[20%]">Proof</th>
                        <th className="pb-2 w-[20%]"></th>
                      </tr></thead>
                      <tbody>
                        {sectionItems("Burial").map((item) => (
                          <tr key={item.id} className="border-b last:border-0">
                            <td className="py-2"><Input className="h-9" value={item.manual_reference ?? ""} onChange={(e) => updateRow(item.id, "manual_reference", e.target.value)} disabled={!canEdit} placeholder="287281" /></td>
                            <td className="py-2">
                              <select className="h-9 w-full rounded border border-input bg-background px-2 text-sm" value={item.item_type} onChange={(e) => updateRow(item.id, "item_type", e.target.value)} disabled={!canEdit}>
                                <option value="Cash">Cash</option>
                                <option value="EFT">EFT</option>
                              </select>
                            </td>
                            <td className="py-2"><Input type="number" step="0.01" className="h-9 text-right" value={item.amount} onChange={(e) => updateRow(item.id, "amount", parseFloat(e.target.value) || 0)} disabled={!canEdit} /></td>
                            <td className="py-2">
                              {item.proof_status === "uploaded" ? (
                                <Badge variant="default" className="text-[10px]">Uploaded</Badge>
                              ) : canEdit ? (
                                <label className="cursor-pointer text-xs bg-primary text-primary-foreground px-2 py-1 rounded hover:bg-primary/90">
                                  Upload
                                  <input type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) uploadProof(item.id, f); }} />
                                </label>
                              ) : <span className="text-xs text-muted-foreground">—</span>}
                            </td>
                            <td className="py-2 text-right">{canEdit && <Button variant="ghost" size="sm" className="text-destructive h-7" onClick={() => deleteRow(item.id)}>X</Button>}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <div className="mt-3 pt-3 border-t flex justify-end text-sm font-semibold">Total Burial: R{sectionTotal("Burial").toFixed(2)}</div>
                  </CardContent>
                </Card>
              </TabsContent>

              {/* ─── Expenses Tab ──────────────────────────────────────── */}
              <TabsContent value="Expenses">
                <Card>
                  <CardHeader className="pb-2 flex-row items-center justify-between">
                    <CardTitle className="text-sm">Expenses</CardTitle>
                    {canEdit && <Button size="sm" variant="outline" onClick={() => addRow("Expenses", "Expense")}>+ Add Row</Button>}
                  </CardHeader>
                  <CardContent>
                    <table className="w-full text-sm">
                      <thead><tr className="border-b text-left text-xs text-muted-foreground">
                        <th className="pb-2 w-[40%]">Description</th>
                        <th className="pb-2 w-[30%] text-right">Amount (R)</th>
                        <th className="pb-2 w-[30%]"></th>
                      </tr></thead>
                      <tbody>
                        {sectionItems("Expenses").map((item) => (
                          <tr key={item.id} className="border-b last:border-0">
                            <td className="py-2"><Input className="h-9" value={item.manual_reference ?? ""} onChange={(e) => updateRow(item.id, "manual_reference", e.target.value)} disabled={!canEdit} placeholder="Coffee & Tea" /></td>
                            <td className="py-2"><Input type="number" step="0.01" className="h-9 text-right" value={item.amount} onChange={(e) => updateRow(item.id, "amount", parseFloat(e.target.value) || 0)} disabled={!canEdit} /></td>
                            <td className="py-2 text-right">{canEdit && <Button variant="ghost" size="sm" className="text-destructive h-7" onClick={() => deleteRow(item.id)}>X</Button>}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <div className="mt-3 pt-3 border-t flex justify-end text-sm font-semibold">Total Expenses: R{sectionTotal("Expenses").toFixed(2)}</div>
                  </CardContent>
                </Card>
              </TabsContent>
            </Tabs>

            {/* Submit Button */}
            {canSubmit && (
              <Button onClick={handleSubmit} disabled={submitting} className="w-full mt-4" size="lg">
                {submitting ? "Submitting..." : "4. Submit Service for Audit"}
              </Button>
            )}
          </div>

          {/* RIGHT SIDEBAR */}
          <div className="space-y-4">
            {/* MTD Totals */}
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-xs uppercase text-muted-foreground">MTD Total</CardTitle></CardHeader>
              <CardContent className="space-y-2">
                <div className="flex justify-between text-sm">
                  <span>Members:</span>
                  <span className="font-semibold">R{mtdMembers.toFixed(2)}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span>Officers:</span>
                  <span className="font-semibold">R{mtdOfficers.toFixed(2)}</span>
                </div>
                <div className="pt-2 border-t flex justify-between text-sm font-bold">
                  <span>Grand Total:</span>
                  <span>R{grandTotal.toFixed(2)}</span>
                </div>
              </CardContent>
            </Card>

            {/* This Week Income Breakdown */}
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-xs uppercase text-muted-foreground">This Service</CardTitle></CardHeader>
              <CardContent className="space-y-1 text-sm">
                <div className="flex justify-between"><span>Members</span><span>R{sectionTotal("Members").toFixed(2)}</span></div>
                <div className="flex justify-between"><span>Officers</span><span>R{sectionTotal("Officers").toFixed(2)}</span></div>
                <div className="flex justify-between"><span>Burial</span><span>R{sectionTotal("Burial").toFixed(2)}</span></div>
                <div className="flex justify-between border-t pt-1 font-semibold"><span>Income</span><span>R{grandTotal.toFixed(2)}</span></div>
                <div className="flex justify-between text-muted-foreground"><span>Expenses</span><span>R{sectionTotal("Expenses").toFixed(2)}</span></div>
              </CardContent>
            </Card>

            {/* Audit Status */}
            <Card>
              <CardHeader className="pb-2"><CardTitle className="text-xs uppercase text-muted-foreground">Audit Status</CardTitle></CardHeader>
              <CardContent>
                {period?.status === "audit_approved" ? (
                  <Badge variant="default" className="bg-green-700">Audit Approved</Badge>
                ) : period?.status === "pending_audit" ? (
                  <Badge variant="secondary" className="bg-orange-100 text-orange-800 border-orange-300">Pending Audit</Badge>
                ) : period?.status === "audit_rejected" ? (
                  <Badge variant="destructive">Rejected</Badge>
                ) : (
                  <Badge variant="outline">Draft</Badge>
                )}
                {period?.submitted_at && (
                  <p className="text-xs text-muted-foreground mt-2">
                    Submitted: {new Date(period.submitted_at).toLocaleDateString()}
                  </p>
                )}
              </CardContent>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}
