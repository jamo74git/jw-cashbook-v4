"use client";

import React, { useEffect, useState, useRef } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { getUserAccess } from "@/lib/permissions";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { UserHierarchyAccess } from "@/lib/types";

// ═══════════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════════
interface Congregation { id: string; name: string; code: string; }

// Tab 1: Governance
interface GovRow { congName: string; code: string; congId: string; inProgress: number; awaitingAudit: number; auditApproved: number; submittedToOverseer: number; lastEdit: string | null; totalWeeks: number; capturedWeeks: number; membersCash: number; membersDeposit: number; officersCash: number; officersDeposit: number; burial: number; expenses: number; }


// Tab 3: Priest Review
interface PriestRow { officerCode: string; membersCash: number; membersDeposit: number; priestTotal: number; officersCash: number; officersDeposit: number; officerTotal: number; }
interface PriestCongRow { congId: string; congName: string; membersCash: number; membersDeposit: number; priestTotal: number; officersCash: number; officersDeposit: number; officerTotal: number; priests: PriestRow[]; }
interface CashRiskItem { priestCode: string; amount: number; pct: number; cashPct: number; }

// Tab 4: Audit Log
interface AuditRow { date: string; congregation: string; action: string; week: string; comment: string; by: string; }

type TabKey = "governance" | "priest" | "risk";
const TABS: { key: TabKey; label: string }[] = [
  { key: "governance", label: "Governance" },
  { key: "priest", label: "Tithing Review" },
  { key: "risk", label: "Risk & Audit" },
];

// Colors matching the images
const C = {
  headerBg: "#1a5276",
  headerText: "#ffffff",
  completed: "#27ae60",
  awaiting: "#e67e22",
  approved: "#2980b9",
  submitted: "#8e44ad",
  priestTotal: "#c0392b",
  officerTotal: "#1abc9c",
  pctBg: "#d4e6f1",
  yellowHighlight: "#f9e79f",
  cashRisk1: "#1a5276",
  cashRisk2: "#2e86c1",
  cashRisk3: "#85c1e9",
};

// ═══════════════════════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════════════════════
export default function ElderDashboard() {
  const supabase = createClient();
  const router = useRouter();
  const [, setAccess] = useState<UserHierarchyAccess | null>(null);
  const [congregations, setCongregations] = useState<Congregation[]>([]);
  const [activeTab, setActiveTab] = useState<TabKey>("governance");
  const [selectedMonth, setSelectedMonth] = useState(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`; });
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<string | null>(null);

  // Review panel state
  const [reviewCongId, setReviewCongId] = useState<string | null>(null);
  const [reviewPeriods, setReviewPeriods] = useState<{ id: string; week: number; service: string; status: string }[]>([]);

  // Tab data
  const [govRows, setGovRows] = useState<GovRow[]>([]);
  const [priestRows, setPriestRows] = useState<PriestCongRow[]>([]);
  const [cashRisks, setCashRisks] = useState<CashRiskItem[]>([]);
  const [totalCash, setTotalCash] = useState(0);
  const [totalEFT, setTotalEFT] = useState(0);
  const [eldershipTotal, setEldershipTotal] = useState(0);
  const [auditRows, setAuditRows] = useState<AuditRow[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState(false);
  const allPeriodsRef = useRef<{ id: string; congregation_id: string; week: number; service: string; status: string }[]>([]);

  useEffect(() => { if (toast) { const t = setTimeout(() => setToast(null), 3000); return () => clearTimeout(t); } }, [toast]);

  // Block future months
  function handleMonthChange(val: string) {
    const [y, m] = val.split("-").map(Number);
    const now = new Date();
    if (y > now.getFullYear() || (y === now.getFullYear() && m > now.getMonth() + 1)) {
      setToast("Cannot select future period");
      return;
    }
    setSelectedMonth(val);
  }

  useEffect(() => { loadAll(); }, [selectedMonth]);

  async function loadAll() {
    setLoading(true);
    const ua = await getUserAccess();
    if (!ua) { setLoading(false); return; }
    setAccess(ua);

    // Get congregations from user_congregation_assignments (multi-congregation support)
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) { setLoading(false); return; }

    const { data: assignments } = await supabase
      .from("user_congregation_assignments")
      .select("congregation_id")
      .eq("user_id", user.id)
      .eq("status", "active");

    let congList: Congregation[] = [];
    if (assignments && assignments.length > 0) {
      const congIds = assignments.map(a => a.congregation_id);
      const { data: congs } = await supabase.from("congregations").select("id, name, code").in("id", congIds).order("name");
      congList = congs ?? [];
    } else {
      // Fallback: legacy eldership-based lookup
      const { data: congs } = await supabase.from("congregations").select("id, name, code").eq("eldership_id", ua.hierarchy_id);
      congList = congs ?? [];
    }

    setCongregations(congList);
    const congIds = congList.map(c => c.id);
    if (congIds.length === 0) { setLoading(false); return; }

    const [year, month] = selectedMonth.split("-").map(Number);

    // Get all periods for this month
    const { data: periods } = await supabase.from("cashbook_period").select("id, congregation_id, week, service, status, created_at")
      .in("congregation_id", congIds).eq("year", year).eq("month", month);
    const allPeriods = periods ?? [];
    allPeriodsRef.current = allPeriods;
    const periodIds = allPeriods.map(p => p.id);

    // Get all line items for these periods
    const { data: allItems } = periodIds.length > 0
      ? await supabase.from("cashbook_line_item").select("id, period_id, section, is_officer, item_type, amount, officer_id, proof_status").in("period_id", periodIds)
      : { data: [] };
    const items = allItems ?? [];

    // Get officers
    const { data: officers } = await supabase.from("officers").select("id, officer_code, congregation_id").in("congregation_id", congIds).eq("is_active", true);
    const allOfficers = officers ?? [];

    // ─── TAB 1: Governance ──────────────────────────────────────────────────
    // Calculate total expected weeks
    const sundays: number[] = [];
    for (let d = 1; d <= new Date(year, month, 0).getDate(); d++) { if (new Date(year, month-1, d).getDay() === 0) sundays.push(d); }
    const totalWeeks = Math.max(sundays.length - 1, 1); // OAC weeks (2nd Sunday = W1)

    const gov: GovRow[] = congList.map(c => {
      const cPeriods = allPeriods.filter(p => p.congregation_id === c.id);
      const cItems = items.filter(i => cPeriods.map(p=>p.id).includes(i.period_id));
      const lastPeriod = [...cPeriods].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())[0];
      const uniqueWeeks = new Set(cPeriods.map(p => p.week));
      return {
        congName: c.name, code: c.code, congId: c.id,
        inProgress: cPeriods.filter(p => p.status === "Draft" || p.status === "Rejected").length,
        awaitingAudit: cPeriods.filter(p => p.status === "Submitted").length,
        auditApproved: cPeriods.filter(p => p.status === "AuditApproved").length,
        submittedToOverseer: cPeriods.filter(p => ["SubmittedToHO","HOReviewed"].includes(p.status)).length,
        lastEdit: lastPeriod?.created_at ? new Date(lastPeriod.created_at).toLocaleDateString("en-GB", { day: "numeric", month: "short" }) : null,
        totalWeeks,
        capturedWeeks: uniqueWeeks.size,
        membersCash: cItems.filter(i=>!i.is_officer && ["Cash","CashBanked","CashPending"].includes(i.item_type)).reduce((s,i)=>s+Number(i.amount),0),
        membersDeposit: cItems.filter(i=>!i.is_officer && ["EFT","DirectDebit"].includes(i.item_type)).reduce((s,i)=>s+Number(i.amount),0),
        officersCash: cItems.filter(i=>i.is_officer && ["Cash","CashBanked","CashPending"].includes(i.item_type)).reduce((s,i)=>s+Number(i.amount),0),
        officersDeposit: cItems.filter(i=>i.is_officer && ["EFT","DirectDebit"].includes(i.item_type)).reduce((s,i)=>s+Number(i.amount),0),
        burial: cItems.filter(i=>i.item_type==="Burial").reduce((s,i)=>s+Number(i.amount),0),
        expenses: cItems.filter(i=>i.item_type==="Expense").reduce((s,i)=>s+Number(i.amount),0),
      };
    });
    setGovRows(gov);

    // (submission data now merged into governance above)

    // ─── TAB 3: Priest Review ───────────────────────────────────────────────
    const priestData: PriestCongRow[] = congList.map(c => {
      const cPeriods = allPeriods.filter(p => p.congregation_id === c.id);
      const cItems = items.filter(i => cPeriods.map(p=>p.id).includes(i.period_id));
      const cOfficers = allOfficers.filter(o => o.congregation_id === c.id);

      const priests: PriestRow[] = cOfficers.map(o => {
        const oItems = cItems.filter(i => i.officer_id === o.id);
        const mCash = oItems.filter(i=>!i.is_officer && ["Cash","CashBanked","CashPending"].includes(i.item_type)).reduce((s,i)=>s+Number(i.amount),0);
        const mDep = oItems.filter(i=>!i.is_officer && ["EFT","DirectDeposit"].includes(i.item_type)).reduce((s,i)=>s+Number(i.amount),0);
        const oCash = oItems.filter(i=>i.is_officer && ["Cash","CashBanked","CashPending"].includes(i.item_type)).reduce((s,i)=>s+Number(i.amount),0);
        const oDep = oItems.filter(i=>i.is_officer && ["EFT","DirectDeposit"].includes(i.item_type)).reduce((s,i)=>s+Number(i.amount),0);
        return { officerCode: o.officer_code, membersCash: mCash, membersDeposit: mDep, priestTotal: mCash + mDep, officersCash: oCash, officersDeposit: oDep, officerTotal: oCash + oDep };
      });

      const totMC = priests.reduce((s,p)=>s+p.membersCash,0);
      const totMD = priests.reduce((s,p)=>s+p.membersDeposit,0);
      const totOC = priests.reduce((s,p)=>s+p.officersCash,0);
      const totOD = priests.reduce((s,p)=>s+p.officersDeposit,0);
      return { congId: c.id, congName: c.name, membersCash: totMC, membersDeposit: totMD, priestTotal: totMC+totMD, officersCash: totOC, officersDeposit: totOD, officerTotal: totOC+totOD, priests };
    });
    setPriestRows(priestData);

    // Cash risk: top 3 priestships by cash amount
    const allPriests = priestData.flatMap(c => c.priests.map(p => ({ ...p, cong: c.congName })));
    const totalC = allPriests.reduce((s,p)=>s+p.membersCash+p.officersCash,0);
    const totalE = allPriests.reduce((s,p)=>s+p.membersDeposit+p.officersDeposit,0);
    const totalAll = totalC + totalE;
    setTotalCash(totalC); setTotalEFT(totalE); setEldershipTotal(totalAll);
    const riskSorted = allPriests.filter(p => (p.membersCash + p.officersCash) > 0).sort((a,b) => (b.membersCash+b.officersCash) - (a.membersCash+a.officersCash)).slice(0, 3);
    setCashRisks(riskSorted.map(p => ({ priestCode: p.officerCode, amount: p.membersCash + p.officersCash, pct: totalAll > 0 ? Math.round(((p.membersCash+p.officersCash)/totalAll)*100) : 0, cashPct: totalC > 0 ? Math.round(((p.membersCash+p.officersCash)/totalC)*100) : 0 })));

    // ─── TAB 3: Audit Log ───────────────────────────────────────────────────
    // Query audit_log for actions on these periods (if table exists)
    let auditData: AuditRow[] = [];
    if (periodIds.length > 0) {
      const { data: auditLogs } = await supabase.from("audit_log")
        .select("user_id, action_type, entity_id, comment, created_at")
        .in("entity_id", periodIds)
        .order("created_at", { ascending: false })
        .limit(20);

      if (auditLogs && auditLogs.length > 0) {
        // Get user roles for display
        const auditUserIds = [...new Set(auditLogs.map(a => a.user_id))];
        const { data: accessRows } = await supabase.from("user_hierarchy_access").select("user_id, role").in("user_id", auditUserIds).eq("status", "active");
        const userRoles: Record<string, string> = {};
        (accessRows ?? []).forEach(a => { userRoles[a.user_id] = a.role; });

        auditData = auditLogs.map(a => {
          const period2 = allPeriods.find(p => p.id === a.entity_id);
          return {
            date: new Date(a.created_at).toLocaleDateString("en-GB", { day: "numeric", month: "short" }),
            congregation: period2 ? congList.find(c => c.id === period2.congregation_id)?.name ?? "" : "",
            action: a.action_type === "AUDIT_APPROVE" ? "Approved" : a.action_type === "AUDIT_REJECT" ? "Rejected" : a.action_type === "SUBMIT" ? "Submitted" : a.action_type,
            week: period2 ? `Wk ${period2.week} ${period2.service}` : "—",
            comment: a.comment ?? "",
            by: userRoles[a.user_id] ?? "—",
          };
        });
      }
    }

    // Fallback: if no audit_log data, show period status transitions
    if (auditData.length === 0) {
      auditData = allPeriods.filter(p => p.status !== "Draft").map(p => ({
        date: "—",
        congregation: congList.find(c => c.id === p.congregation_id)?.name ?? "",
        action: p.status === "AuditApproved" ? "Approved" : p.status === "Submitted" ? "Submitted for Audit" : p.status,
        week: `Wk ${p.week} ${p.service}`,
        comment: "",
        by: "—",
      }));
    }

    setAuditRows(auditData);

    setLoading(false);
  }

  function toggleExpand(id: string) {
    setExpanded(prev => { const n = new Set(prev); if (n.has(id)) { n.delete(id); } else { n.add(id); } return n; });
  }

  async function handleReview(congId: string) {
    const [year, month] = selectedMonth.split("-").map(Number);
    const { data: ps } = await supabase.from("cashbook_period")
      .select("id, week, service, status")
      .eq("congregation_id", congId)
      .eq("year", year)
      .eq("month", month)
      .order("week");
    setReviewPeriods(ps ?? []);
    setReviewCongId(congId);
  }

  async function handleSubmitAll() {
    setSubmitting(true);
    const congIds = congregations.map(c => c.id);
    const [year, month] = selectedMonth.split("-").map(Number);
    await supabase.from("cashbook_period").update({ status: "SubmittedToHO" }).in("congregation_id", congIds).eq("year", year).eq("month", month).eq("status", "AuditApproved");
    setSubmitting(false); await loadAll();
  }

  if (loading) return <div className="p-6 text-sm text-muted-foreground">Loading...</div>;

  // ═══════════════════════════════════════════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════════════════════════════════════════
  const [year, month] = selectedMonth.split("-").map(Number);
  const monthName = new Date(year, month-1).toLocaleString("en", { month: "long" });

  return (
    <>
      <div className="max-w-6xl mx-auto px-4 py-4 space-y-4">
        {toast && <div className="fixed top-16 left-1/2 -translate-x-1/2 z-50 bg-destructive text-white px-4 py-2 rounded-md text-xs shadow-lg">{toast}</div>}

        {/* Month selector */}
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-bold" style={{ color: C.headerBg }}>Current Month - {monthName} {year}</h2>
          <input type="month" className="h-8 rounded border border-input bg-background px-2 text-xs" value={selectedMonth} onChange={e => handleMonthChange(e.target.value)} />
        </div>

        {/* Tabs */}
        <div className="flex gap-1 border-b" style={{ borderColor: C.headerBg }}>
          {TABS.map(t => (
            <button key={t.key} onClick={() => setActiveTab(t.key)}
              className={`px-4 py-2 text-xs font-medium border-b-2 transition-colors ${activeTab === t.key ? "border-current font-bold" : "border-transparent text-muted-foreground hover:text-foreground"}`}
              style={activeTab === t.key ? { color: C.headerBg, borderColor: C.headerBg } : {}}>
              {t.label}
            </button>
          ))}
        </div>

        {/* ─── TAB 1: GOVERNANCE ─── */}
        {activeTab === "governance" && (<>
          <div className="overflow-x-auto">
            <table className="w-full text-xs border-collapse">
              <thead><tr style={{ backgroundColor: C.headerBg, color: C.headerText }}>
                <th className="px-3 py-2 text-left border-r border-white/20">Congregation</th>
                <th className="px-2 py-2 border-r border-white/20">Code</th>
                <th className="px-2 py-2 border-r border-white/20">In Progress</th>
                <th className="px-2 py-2 border-r border-white/20">Awaiting Audit</th>
                <th className="px-2 py-2 border-r border-white/20">Audit Approved</th>
                <th className="px-2 py-2 border-r border-white/20">Submitted to Overseer</th>
                <th className="px-2 py-2 border-r border-white/20">Last Edit</th>
                <th className="px-2 py-2">Action</th>
              </tr></thead>
              <tbody>{govRows.map(r => (
                <tr key={r.code} className="border-b">
                  <td className="px-3 py-2 font-medium">{r.congName}</td><td className="px-2 py-2 text-center">{r.code}</td>
                  <td className="px-2 py-2 text-center font-bold" style={{ color: C.completed }}>{r.inProgress || "-"}</td>
                  <td className="px-2 py-2 text-center font-bold" style={{ color: C.awaiting }}>{r.awaitingAudit || "-"}</td>
                  <td className="px-2 py-2 text-center font-bold" style={{ color: C.approved }}>{r.auditApproved || "-"}</td>
                  <td className="px-2 py-2 text-center font-bold" style={{ color: C.submitted }}>{r.submittedToOverseer || "-"}</td>
                  <td className="px-2 py-2 text-center">{r.lastEdit ?? "—"}</td>
                  <td className="px-2 py-2"><Button size="sm" variant="outline" className="h-6 text-[10px]" onClick={() => handleReview(congregations.find(c => c.code === r.code)?.id ?? "")}>Review</Button></td>
                </tr>
              ))}</tbody>
            </table>
          </div>

          {/* Review Panel — shows weeks for selected congregation */}
          {reviewCongId && (
            <Card className="mt-4 border-primary/40">
              <CardContent className="py-4">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-bold">
                    Week Detail: {congregations.find(c => c.id === reviewCongId)?.name ?? ""}
                  </h3>
                  <Button size="sm" variant="ghost" className="h-6 text-[10px]" onClick={() => setReviewCongId(null)}>✕ Close</Button>
                </div>
                {reviewPeriods.length === 0 ? (
                  <p className="text-xs text-muted-foreground">No periods captured this month.</p>
                ) : (
                  <div className="space-y-1">
                    {reviewPeriods.map(p => (
                      <button
                        key={p.id}
                        onClick={() => router.push(`/capture/${p.id}`)}
                        className="w-full flex items-center justify-between px-3 py-2 rounded border text-xs hover:bg-muted transition-colors text-left"
                      >
                        <span className="font-medium">Week {p.week} — {p.service}</span>
                        <Badge
                          variant="outline"
                          className={`text-[9px] ${
                            p.status === "Draft" ? "" :
                            p.status === "Submitted" ? "bg-orange-50 text-orange-700 border-orange-300" :
                            p.status === "AuditApproved" ? "bg-green-50 text-green-700 border-green-300" :
                            p.status === "Rejected" ? "bg-red-50 text-red-700 border-red-300" :
                            "bg-blue-50 text-blue-700 border-blue-300"
                          }`}
                        >
                          {p.status === "AuditApproved" ? "Approved" : p.status === "Submitted" ? "Pending Audit" : p.status}
                        </Badge>
                      </button>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          {/* Submission Summary — merged into governance */}
          <Card className="mt-4">
            <CardContent className="py-4">
              <h3 className="text-sm font-bold mb-3">Submission Summary</h3>
              <div className="overflow-x-auto">
                <table className="w-full text-xs border-collapse">
                  <thead>
                    <tr style={{ backgroundColor: C.headerBg, color: C.headerText }}>
                      <th className="px-2 py-2 w-6"></th>
                      <th className="px-2 py-2 text-left border-r border-white/20">Congregation</th>
                      <th className="px-2 py-2 text-center border-r border-white/20">Weeks</th>
                      <th className="px-2 py-2 text-right border-r border-white/20">Members</th>
                      <th className="px-2 py-2 text-right border-r border-white/20">Officers</th>
                      <th className="px-2 py-2 text-right border-r border-white/20">Burial</th>
                      <th className="px-2 py-2 text-right border-r border-white/20">Expenses</th>
                      <th className="px-2 py-2 text-right">Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {govRows.map(r => {
                      const total = r.membersCash + r.membersDeposit + r.officersCash + r.officersDeposit + r.burial - r.expenses;
                      const isExp = expanded.has(`sub-${r.congId}`);
                      return (
                        <React.Fragment key={r.congId}>
                          <tr className="border-b cursor-pointer hover:bg-muted/30" onClick={() => toggleExpand(`sub-${r.congId}`)}>
                            <td className="px-2 py-2 text-center">{isExp ? "−" : "+"}</td>
                            <td className="px-2 py-2 font-medium">{r.congName}</td>
                            <td className="px-2 py-2 text-center">
                              <Badge variant={r.capturedWeeks >= r.totalWeeks ? "default" : r.capturedWeeks > 0 ? "secondary" : "outline"} className="text-[9px]">
                                {r.capturedWeeks}/{r.totalWeeks}
                              </Badge>
                            </td>
                            <td className="px-2 py-2 text-right">R{(r.membersCash + r.membersDeposit).toFixed(2)}</td>
                            <td className="px-2 py-2 text-right">R{(r.officersCash + r.officersDeposit).toFixed(2)}</td>
                            <td className="px-2 py-2 text-right">R{r.burial.toFixed(2)}</td>
                            <td className="px-2 py-2 text-right">R{r.expenses.toFixed(2)}</td>
                            <td className="px-2 py-2 text-right font-bold">R{total.toFixed(2)}</td>
                          </tr>
                          {isExp && Array.from({ length: r.totalWeeks }, (_, i) => i + 1).map(wk => {
                            const weekPeriods = allPeriodsRef.current.filter(p => p.congregation_id === r.congId && p.week === wk);
                            if (weekPeriods.length === 0) {
                              return (
                                <tr key={`${r.congId}-w${wk}-none`} className="border-b bg-gray-50">
                                  <td></td>
                                  <td className="px-2 py-1 pl-8 text-muted-foreground">Week {wk}</td>
                                  <td className="px-2 py-1 text-center text-[10px] text-gray-400" colSpan={5}>—</td>
                                  <td className="px-2 py-1"><Badge variant="outline" className="text-[8px] bg-gray-50 text-gray-400 border-gray-200">Not Captured</Badge></td>
                                </tr>
                              );
                            }
                            return weekPeriods.map(wp => {
                              const rowBg = wp.status === "AuditApproved" ? "bg-green-50/50" : wp.status === "Submitted" ? "bg-orange-50/50" : wp.status === "Rejected" ? "bg-red-50/50" : "";
                              return (
                                <tr key={`${r.congId}-w${wk}-${wp.service}`} className={`border-b text-muted-foreground ${rowBg}`}>
                                  <td></td>
                                  <td className="px-2 py-1 pl-8">Wk {wk} {wp.service}</td>
                                  <td className="px-2 py-1 text-center">—</td>
                                  <td className="px-2 py-1 text-right">—</td>
                                  <td className="px-2 py-1 text-right">—</td>
                                  <td className="px-2 py-1 text-right">—</td>
                                  <td className="px-2 py-1 text-right">—</td>
                                  <td className="px-2 py-1">
                                    <Badge variant="outline" className={`text-[8px] ${
                                      wp.status === "AuditApproved" ? "text-green-700 border-green-300" :
                                      wp.status === "Submitted" ? "text-orange-700 border-orange-300" :
                                      wp.status === "Rejected" ? "text-red-700 border-red-300" :
                                      wp.status === "Draft" ? "text-gray-600 border-gray-300" : ""
                                    }`}>
                                      {wp.status === "AuditApproved" ? "Approved" : wp.status === "Submitted" ? "Pending" : wp.status}
                                    </Badge>
                                  </td>
                                </tr>
                              );
                            });
                          })}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {/* Submit All button */}
              <div className="text-center pt-3">
                <Button onClick={handleSubmitAll} disabled={submitting || !govRows.every(r => r.auditApproved > 0 && r.inProgress === 0 && r.awaitingAudit === 0)} className="px-6">
                  {submitting ? "..." : "Submit All Approved to Overseer"}
                </Button>
              </div>
            </CardContent>
          </Card>
        </>)}

        {/* ─── TAB 3: TITHING REVIEW ─── */}
        {activeTab === "priest" && (
          <div className="space-y-4">
            <div className="overflow-x-auto">
              <table className="w-full text-xs border-collapse">
                <thead>
                  <tr style={{ backgroundColor: C.headerBg, color: C.headerText }}>
                    <th className="px-2 py-1" rowSpan={2}></th><th className="px-2 py-1 text-left" rowSpan={2}>Priest Review</th>
                    <th className="px-2 py-1 text-center border-x border-white/30" colSpan={3}>Members</th>
                    <th className="px-2 py-1 text-center border-x border-white/30" colSpan={3}>Officers</th>
                  </tr>
                  <tr style={{ backgroundColor: C.headerBg, color: C.headerText }}>
                    <th className="px-2 py-1 text-right text-[10px]">Cash</th><th className="px-2 py-1 text-right text-[10px]">Deposit/EFT</th>
                    <th className="px-2 py-1 text-right text-[10px] font-bold">Priestship Total</th>
                    <th className="px-2 py-1 text-right text-[10px]">Cash</th><th className="px-2 py-1 text-right text-[10px]">Deposit/EFT</th>
                    <th className="px-2 py-1 text-right text-[10px] font-bold">Officer Total</th>
                  </tr>
                </thead>
                <tbody>
                  {priestRows.map(c => {
                    const isExp = expanded.has(`pr-${c.congId}`);
                    const congTotal = c.priestTotal + c.officerTotal;
 return (<React.Fragment key={c.congId}>
                      {/* Congregation row */}
                      <tr key={c.congId} className="border-b font-medium">
                        <td className="px-2 py-2 cursor-pointer text-center" onClick={() => toggleExpand(`pr-${c.congId}`)}>{isExp ? "−" : "+"}</td>
                        <td className="px-2 py-2 font-bold">{c.congName}</td>
                        <td className="px-2 py-2 text-right">R {c.membersCash.toFixed(2)}</td>
                        <td className="px-2 py-2 text-right">R {c.membersDeposit.toFixed(2)}</td>
                        <td className="px-2 py-2 text-right font-bold text-white" style={{ backgroundColor: C.priestTotal }}>R {c.priestTotal.toFixed(2)}</td>
                        <td className="px-2 py-2 text-right">R {c.officersCash.toFixed(2)}</td>
                        <td className="px-2 py-2 text-right">R {c.officersDeposit.toFixed(2)}</td>
                        <td className="px-2 py-2 text-right font-bold text-white" style={{ backgroundColor: C.officerTotal }}>R {c.officerTotal.toFixed(2)}</td>
                      </tr>
                      {/* % Split row */}
                      <tr className="border-b" style={{ backgroundColor: C.pctBg }}>
                        <td></td><td className="px-2 py-1 text-[10px] text-muted-foreground">% Split</td>
                        <td className="px-2 py-1 text-right text-[10px]">{congTotal > 0 ? Math.round((c.membersCash/congTotal)*100) : 0}%</td>
                        <td className="px-2 py-1 text-right text-[10px]">{congTotal > 0 ? Math.round((c.membersDeposit/congTotal)*100) : 0}%</td>
                        <td className="px-2 py-1 text-right text-[10px] font-bold" style={{ backgroundColor: C.priestTotal, color: "white" }}>{eldershipTotal > 0 ? Math.round((c.priestTotal/eldershipTotal)*100) : 0}%</td>
                        <td className="px-2 py-1 text-right text-[10px]">{congTotal > 0 ? Math.round((c.officersCash/congTotal)*100) : 0}%</td>
                        <td className="px-2 py-1 text-right text-[10px]">{congTotal > 0 ? Math.round((c.officersDeposit/congTotal)*100) : 0}%</td>
                        <td className="px-2 py-1 text-right text-[10px] font-bold" style={{ backgroundColor: C.officerTotal, color: "white" }}>{eldershipTotal > 0 ? Math.round((c.officerTotal/eldershipTotal)*100) : 0}%</td>
                      </tr>
                      {/* Expanded priest rows */}
                      {isExp && c.priests.map(p => (
                        <tr key={`${c.congId}-${p.officerCode}`} className="border-b" style={{ backgroundColor: p.officerTotal === 0 ? C.yellowHighlight : undefined }}>
                          <td></td><td className="px-2 py-1 pl-8">{p.officerCode}</td>
                          <td className="px-2 py-1 text-right">R {p.membersCash.toFixed(2)}</td>
                          <td className="px-2 py-1 text-right">R {p.membersDeposit.toFixed(2)}</td>
                          <td className="px-2 py-1 text-right font-medium">R {p.priestTotal.toFixed(2)}</td>
                          <td className="px-2 py-1 text-right">R {p.officersCash.toFixed(2)}</td>
                          <td className="px-2 py-1 text-right">R {p.officersDeposit.toFixed(2)}</td>
                          <td className="px-2 py-1 text-right font-medium">{p.officerTotal > 0 ? `R ${p.officerTotal.toFixed(2)}` : "R -"}</td>
                        </tr>
                      ))}
 </React.Fragment>);
                  })}
                </tbody>
              </table>
            </div>

            {/* Cash Risk Card */}
            <Card>
              <CardContent className="py-3">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <p className="text-xs font-bold mb-2">Cash Risk:</p>
                    <div className="flex gap-2">
                      {cashRisks.map((r, i) => (
                        <div key={i} className="text-center">
                          <p className="text-[10px] font-medium">{i+1}</p>
                          <p className="text-[10px]">{r.priestCode} - R{r.amount.toFixed(0)}</p>
                          <div className="h-4 rounded text-[9px] text-white flex items-center justify-center" style={{ backgroundColor: i === 0 ? C.cashRisk1 : i === 1 ? C.cashRisk2 : C.cashRisk3 }}>
                            {r.pct}% of total
                          </div>
                          <div className="h-4 rounded text-[9px] text-white flex items-center justify-center mt-0.5 bg-orange-600">
                            {r.cashPct}% of cash
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                  <div className="text-xs space-y-1">
                    <div className="flex justify-between"><span>Total Cash</span><b>R {totalCash.toFixed(2)}</b></div>
                    <div className="flex justify-between"><span>Total EFT/Debit</span><b>R {totalEFT.toFixed(2)}</b></div>
                    <div className="flex justify-between border-t pt-1"><span>Eldership Total</span><b>R {eldershipTotal.toFixed(2)}</b></div>
                    <div className="flex gap-2 mt-1">
                      <span className="text-[10px] bg-orange-100 px-1 rounded">{eldershipTotal > 0 ? Math.round((totalCash/eldershipTotal)*100) : 0}%</span>
                      <span className="text-[10px] bg-blue-100 px-1 rounded">{eldershipTotal > 0 ? Math.round((totalEFT/eldershipTotal)*100) : 0}%</span>
                    </div>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        )}

        {/* ─── TAB 4: RISK & AUDIT ─── */}
        {activeTab === "risk" && (
          <div className="overflow-x-auto">
            <table className="w-full text-xs border-collapse">
              <thead><tr style={{ backgroundColor: C.headerBg, color: C.headerText }}>
                <th className="px-3 py-2 text-left border-r border-white/20">Congregation</th>
                <th className="px-2 py-2 text-left border-r border-white/20">Week</th>
                <th className="px-2 py-2 text-left border-r border-white/20">Action</th>
                <th className="px-2 py-2 text-left border-r border-white/20">Comment</th>
                <th className="px-2 py-2 text-left">By</th>
              </tr></thead>
              <tbody>
                {auditRows.length === 0 ? <tr><td colSpan={5} className="px-3 py-4 text-center text-muted-foreground">No audit events for this period.</td></tr> : (
                  auditRows.map((r, i) => (
                    <tr key={i} className="border-b">
                      <td className="px-3 py-2">{r.congregation}</td>
                      <td className="px-2 py-2">{r.week}</td>
                      <td className="px-2 py-2">
                        <Badge variant="outline" className={`text-[9px] ${r.action === "Approved" ? "bg-green-50 text-green-700 border-green-300" : r.action === "Rejected" ? "bg-red-50 text-red-700 border-red-300" : ""}`}>
                          {r.action}
                        </Badge>
                      </td>
                      <td className="px-2 py-2 text-muted-foreground">{r.comment || "—"}</td>
                      <td className="px-2 py-2 font-medium">{r.by}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}
