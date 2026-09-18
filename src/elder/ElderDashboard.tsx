// ─────────────────────────────────────────────────────────────────────────────
// ELDER PORTAL (online-only). Reads live from Supabase under RLS across one or more
// congregations. Three tabs — Governance (+ Submission Summary), Tithing Review, and
// Risk & Audit. The ONLY write is the month-end batch that advances AuditApproved
// periods to "SubmittedToOverseer" and logs MONTH_SUBMIT. No Dexie / offline path.
//
// Accountability (corrected against f6145ff1): the Elder submits ONLY up to the
// Overseer (SubmittedToOverseer). The Overseer — accountable at HO, consolidating
// multiple congregations — later advances SubmittedToHO. This portal never writes
// SubmittedToHO / OverseerApproved / HOReviewed.
//
// Editing/auditing is NOT rebuilt here: the per-week drill routes into the existing
// period-addressable /audit/:periodId screen, which already fires SELF_REVIEW_EXCEPTION
// for an Elder acting via its "O" override and returns to /elder.
//
// Access gate: month.submit_to_overseer is uniquely Elder in the permission matrix
// (Elder = "S", every other role = "-"), identifying the Elder's own portal without
// any inline role-string comparison (Req 6.3).
// ─────────────────────────────────────────────────────────────────────────────

import { Fragment, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { createClient } from "@/lib/supabase/client";
import { getUserAccess, hasPermission, logAuditAction } from "@/lib/permissions";
import { useOnlineStatus } from "@/lib/useOnlineStatus";
import { getOacWeeks } from "@/lib/oacWeeks";
import { sectionTotals, type CaptureItem, type ItemType } from "@/lib/captureTotals";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { LineSection, Role, UserHierarchyAccess } from "@/lib/types";

const OFFLINE_MSG =
  "Offline Unavailable — Please connect to a stable network to review and submit month-end cashbooks.";

// Status buckets (extended server vocabulary — Req 6.14, 6.25).
const IN_PROGRESS = ["Draft", "Rejected"];
const AT_OVERSEER_OR_BEYOND = ["SubmittedToOverseer", "OverseerApproved", "OverseerRejected", "SubmittedToHO", "HOReviewed"];
// Money classification by item_type (Req 6.13).
const CASH_TYPES = ["Cash", "CashBanked", "CashPending"];
const DEPOSIT_TYPES = ["EFT", "DirectDebit"];

// ─── Narrow query-result shapes ─────────────────────────────────────────────
interface CongOption { id: string; name: string; code: string; }
interface ElderPeriod { id: string; congregation_id: string; week: number; service: string; status: string; created_at: string; }
interface ElderLineItem { id: string; period_id: string; section: string; is_officer: boolean; item_type: string; amount: number; officer_id: string | null; proof_status: string | null; }
interface ElderOfficer { id: string; officer_code: string; congregation_id: string; }
interface AuditRow { date: string; congId: string; congregation: string; action: string; week: string; comment: string; by: string; }

// ─── Derived view models ────────────────────────────────────────────────────
interface GovRow {
  congId: string; congName: string; code: string;
  inProgress: number; awaitingAudit: number; auditApproved: number; submittedToOverseer: number;
  lastEdit: string | null; totalWeeks: number; capturedWeeks: number;
  members: number; officers: number; burial: number; expenses: number; total: number;
}
interface PriestRow { officerCode: string; membersCash: number; membersDeposit: number; priestTotal: number; officersCash: number; officersDeposit: number; officerTotal: number; }
interface PriestCong { congId: string; congName: string; membersCash: number; membersDeposit: number; priestTotal: number; officersCash: number; officersDeposit: number; officerTotal: number; priests: PriestRow[]; }
interface CashRisk { officerCode: string; amount: number; pct: number; cashPct: number; }

const money = (n: number) => `R${n.toFixed(2)}`;
const currentMonthValue = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};

const toCaptureItems = (rows: ElderLineItem[]): CaptureItem[] =>
  rows.map((r) => ({ section: r.section as LineSection, item_type: r.item_type as ItemType, amount: Number(r.amount), proof_status: r.proof_status, item_count: null }));
const sumCash = (rows: ElderLineItem[]) => rows.filter((i) => CASH_TYPES.includes(i.item_type)).reduce((s, i) => s + Number(i.amount), 0);
const sumDeposit = (rows: ElderLineItem[]) => rows.filter((i) => DEPOSIT_TYPES.includes(i.item_type)).reduce((s, i) => s + Number(i.amount), 0);

const fmtDate = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
const mapAction = (t: string) =>
  t === "AUDIT_APPROVE" ? "Approved" : t === "AUDIT_REJECT" ? "Rejected" : t === "SUBMIT" ? "Submitted" : t === "MONTH_SUBMIT" ? "Submitted to Overseer" : t === "SELF_REVIEW_EXCEPTION" ? "Override" : t;
const statusAction = (s: string) =>
  s === "AuditApproved" ? "Approved" : s === "Submitted" ? "Submitted for Audit" : s === "SubmittedToOverseer" ? "Submitted to Overseer" : s === "Rejected" ? "Rejected" : s;

type TabKey = "governance" | "priest" | "risk";
const TABS: { key: TabKey; label: string }[] = [
  { key: "governance", label: "Governance" },
  { key: "priest", label: "Tithing Review" },
  { key: "risk", label: "Risk & Audit" },
];

export function ElderDashboard() {
  const supabase = createClient();
  const navigate = useNavigate();
  const online = useOnlineStatus();

  const [access, setAccess] = useState<UserHierarchyAccess | null>(null);
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [activeTab, setActiveTab] = useState<TabKey>("governance");
  const [congregations, setCongregations] = useState<CongOption[]>([]);
  const [scope, setScope] = useState<string>("all");
  const [selectedMonth, setSelectedMonth] = useState<string>(currentMonthValue);

  const [periods, setPeriods] = useState<ElderPeriod[]>([]);
  const [items, setItems] = useState<ElderLineItem[]>([]);
  const [officers, setOfficers] = useState<ElderOfficer[]>([]);
  const [auditRows, setAuditRows] = useState<AuditRow[]>([]);

  const [reviewCongId, setReviewCongId] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [reloadKey, setReloadKey] = useState(0);

  const role = access?.role as Role | undefined;

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3000);
    return () => clearTimeout(t);
  }, [toast]);

  function handleMonthChange(val: string) {
    if (!val) return;
    const [y, m] = val.split("-").map(Number);
    const now = new Date();
    if (y > now.getFullYear() || (y === now.getFullYear() && m > now.getMonth() + 1)) {
      setToast("Cannot select future period");
      return;
    }
    setSelectedMonth(val);
  }

  function toggleExpand(id: string) {
    setExpanded((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  // ── Month-scope data controller ────────────────────────────────────────────
  useEffect(() => {
    let active = true;
    (async () => {
      setLoading(true);
      const ua = await getUserAccess();
      if (!active) return;
      if (!ua) { setLoading(false); return; }
      setAccess(ua);

      const { data: { user } } = await supabase.auth.getUser();
      if (!active) return;
      setEmail(user?.email ?? "");
      if (!user) { setLoading(false); return; }

      // Multi-congregation resolution: assignments (active) → eldership fallback.
      const { data: assignments } = await supabase
        .from("user_congregation_assignments")
        .select("congregation_id")
        .eq("user_id", user.id)
        .eq("status", "active");

      let congList: CongOption[] = [];
      const assignedIds = (assignments ?? []).map((a) => a.congregation_id as string);
      if (assignedIds.length > 0) {
        const { data: congs } = await supabase.from("congregations").select("id, name, code").in("id", assignedIds).order("name");
        congList = (congs ?? []) as CongOption[];
      } else {
        const { data: congs } = await supabase.from("congregations").select("id, name, code").eq("eldership_id", ua.hierarchy_id).order("name");
        congList = (congs ?? []) as CongOption[];
      }
      if (!active) return;
      setCongregations(congList);

      const ids = congList.map((c) => c.id);
      if (ids.length === 0) {
        setPeriods([]); setItems([]); setOfficers([]); setAuditRows([]);
        setLoading(false);
        return;
      }

      const [year, month] = selectedMonth.split("-").map(Number);

      const { data: periodRows } = await supabase
        .from("cashbook_period")
        .select("id, congregation_id, week, service, status, created_at")
        .in("congregation_id", ids)
        .eq("year", year)
        .eq("month", month);
      if (!active) return;
      const monthPeriods = (periodRows ?? []) as ElderPeriod[];
      setPeriods(monthPeriods);

      const periodIds = monthPeriods.map((p) => p.id);
      if (periodIds.length > 0) {
        const { data: itemRows } = await supabase
          .from("cashbook_line_item")
          .select("id, period_id, section, is_officer, item_type, amount, officer_id, proof_status")
          .in("period_id", periodIds);
        if (!active) return;
        setItems((itemRows ?? []) as ElderLineItem[]);
      } else {
        setItems([]);
      }

      const { data: officerRows } = await supabase
        .from("officers")
        .select("id, officer_code, congregation_id")
        .in("congregation_id", ids)
        .eq("is_active", true);
      if (!active) return;
      setOfficers((officerRows ?? []) as ElderOfficer[]);

      // Risk & Audit: audit_log for these periods, resolving actor roles.
      let auditData: AuditRow[] = [];
      if (periodIds.length > 0) {
        const { data: logs } = await supabase
          .from("audit_log")
          .select("user_id, action_type, entity_id, comment, created_at")
          .in("entity_id", periodIds)
          .order("created_at", { ascending: false })
          .limit(20);
        if (logs && logs.length > 0) {
          const userIds = [...new Set(logs.map((l) => l.user_id as string))];
          const { data: accessRows } = await supabase.from("user_hierarchy_access").select("user_id, role").in("user_id", userIds).eq("status", "active");
          const roleMap: Record<string, string> = {};
          (accessRows ?? []).forEach((a) => { roleMap[a.user_id as string] = a.role as string; });
          auditData = logs.map((l) => {
            const per = monthPeriods.find((p) => p.id === l.entity_id);
            const cg = congList.find((c) => c.id === per?.congregation_id);
            return {
              date: fmtDate(l.created_at as string),
              congId: per?.congregation_id ?? "",
              congregation: cg?.name ?? "",
              action: mapAction(l.action_type as string),
              week: per ? `Wk ${per.week} ${per.service}` : "—",
              comment: (l.comment as string) ?? "",
              by: roleMap[l.user_id as string] ?? "—",
            };
          });
        }
      }
      // Fallback: derive from non-Draft period status transitions.
      if (auditData.length === 0) {
        auditData = monthPeriods
          .filter((p) => p.status !== "Draft")
          .map((p) => {
            const cg = congList.find((c) => c.id === p.congregation_id);
            return { date: "—", congId: p.congregation_id, congregation: cg?.name ?? "", action: statusAction(p.status), week: `Wk ${p.week} ${p.service}`, comment: "", by: "—" };
          });
      }
      if (!active) return;
      setAuditRows(auditData);

      setLoading(false);
    })();
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedMonth, reloadKey]);

  // ── Guards ───────────────────────────────────────────────────────────────
  if (!online) return <p className="p-6 text-sm text-amber-700">{OFFLINE_MSG}</p>;
  if (loading) return <p className="p-6 text-sm text-muted-foreground">Loading…</p>;
  if (!role || !hasPermission(role, "month.submit_to_overseer")) {
    return <p className="p-6 text-sm text-destructive">Access denied. Elder role required.</p>;
  }

  const [year, month] = selectedMonth.split("-").map(Number);
  const totalWeeks = getOacWeeks(year, month).length;

  // ── Governance rows (all congregations) ────────────────────────────────────
  const govRows: GovRow[] = congregations.map((c) => {
    const cPeriods = periods.filter((p) => p.congregation_id === c.id);
    const cPeriodIds = new Set(cPeriods.map((p) => p.id));
    const cItems = items.filter((i) => cPeriodIds.has(i.period_id));
    const sec = sectionTotals(toCaptureItems(cItems));
    const lastTs = cPeriods.reduce((max, p) => Math.max(max, new Date(p.created_at).getTime()), 0);
    return {
      congId: c.id, congName: c.name, code: c.code,
      inProgress: cPeriods.filter((p) => IN_PROGRESS.includes(p.status)).length,
      awaitingAudit: cPeriods.filter((p) => p.status === "Submitted").length,
      auditApproved: cPeriods.filter((p) => p.status === "AuditApproved").length,
      submittedToOverseer: cPeriods.filter((p) => AT_OVERSEER_OR_BEYOND.includes(p.status)).length,
      lastEdit: lastTs > 0 ? fmtDate(new Date(lastTs).toISOString()) : null,
      totalWeeks,
      capturedWeeks: new Set(cPeriods.map((p) => p.week)).size,
      members: sec.Members, officers: sec.Officers, burial: sec.Burial, expenses: sec.Expenses,
      total: sec.Members + sec.Officers + sec.Burial - sec.Expenses,
    };
  });

  const shownGov = scope === "all" ? govRows : govRows.filter((r) => r.congId === scope);
  const scopedCongs = scope === "all" ? congregations : congregations.filter((c) => c.id === scope);

  // Submit gate operates over the WHOLE eldership (batch, all congregations).
  const submitReady = govRows.length > 0 && govRows.every((r) => r.auditApproved > 0 && r.inProgress === 0 && r.awaitingAudit === 0);

  // ── Tithing Review (scoped congregations) ──────────────────────────────────
  const priestCongs: PriestCong[] = scopedCongs.map((c) => {
    const cPeriodIds = new Set(periods.filter((p) => p.congregation_id === c.id).map((p) => p.id));
    const cItems = items.filter((i) => cPeriodIds.has(i.period_id));
    const cOfficers = officers.filter((o) => o.congregation_id === c.id);
    const priests: PriestRow[] = cOfficers.map((o) => {
      const oItems = cItems.filter((i) => i.officer_id === o.id);
      const memberItems = oItems.filter((i) => !i.is_officer);
      const officerItems = oItems.filter((i) => i.is_officer);
      const mCash = sumCash(memberItems), mDep = sumDeposit(memberItems);
      const oCash = sumCash(officerItems), oDep = sumDeposit(officerItems);
      return { officerCode: o.officer_code, membersCash: mCash, membersDeposit: mDep, priestTotal: mCash + mDep, officersCash: oCash, officersDeposit: oDep, officerTotal: oCash + oDep };
    });
    const membersCash = priests.reduce((s, p) => s + p.membersCash, 0);
    const membersDeposit = priests.reduce((s, p) => s + p.membersDeposit, 0);
    const officersCash = priests.reduce((s, p) => s + p.officersCash, 0);
    const officersDeposit = priests.reduce((s, p) => s + p.officersDeposit, 0);
    return { congId: c.id, congName: c.name, membersCash, membersDeposit, priestTotal: membersCash + membersDeposit, officersCash, officersDeposit, officerTotal: officersCash + officersDeposit, priests };
  });

  const allPriests = priestCongs.flatMap((c) => c.priests);
  const totalCash = allPriests.reduce((s, p) => s + p.membersCash + p.officersCash, 0);
  const totalEFT = allPriests.reduce((s, p) => s + p.membersDeposit + p.officersDeposit, 0);
  const eldershipTotal = totalCash + totalEFT;
  const cashRisks: CashRisk[] = allPriests
    .filter((p) => p.membersCash + p.officersCash > 0)
    .sort((a, b) => b.membersCash + b.officersCash - (a.membersCash + a.officersCash))
    .slice(0, 3)
    .map((p) => {
      const amount = p.membersCash + p.officersCash;
      return { officerCode: p.officerCode, amount, pct: eldershipTotal > 0 ? Math.round((amount / eldershipTotal) * 100) : 0, cashPct: totalCash > 0 ? Math.round((amount / totalCash) * 100) : 0 };
    });

  const shownAudit = scope === "all" ? auditRows : auditRows.filter((r) => r.congId === scope);
  const reviewPeriods = reviewCongId ? periods.filter((p) => p.congregation_id === reviewCongId).sort((a, b) => a.week - b.week) : [];

  // ── Month-end submission (Task 18) ─────────────────────────────────────────
  async function handleSubmitAll() {
    if (!access || submitting || !submitReady) return;
    setSubmitting(true);
    const congIds = congregations.map((c) => c.id);
    const [y, m] = selectedMonth.split("-").map(Number);
    const { data, error } = await supabase
      .from("cashbook_period")
      .update({ status: "SubmittedToOverseer" }) // NEVER SubmittedToHO — that is the Overseer's action.
      .in("congregation_id", congIds)
      .eq("year", y)
      .eq("month", m)
      .eq("status", "AuditApproved")
      .select("id, congregation_id");

    if (error) {
      setToast(error.message);
      setSubmitting(false);
      return;
    }

    const rows = (data ?? []) as { id: string; congregation_id: string }[];
    const submittedCongs = [...new Set(rows.map((r) => r.congregation_id))];
    for (const cid of submittedCongs) {
      await logAuditAction({
        userId: access.user_id,
        actionType: "MONTH_SUBMIT",
        entityType: "monthly_close",
        entityId: `${cid}_${y}_${m}`,
        comment: `Month ${y}/${String(m).padStart(2, "0")} submitted to Overseer`,
        metadata: { year: y, month: m, congregation_id: cid },
      });
    }

    setSubmitting(false);
    setToast(`Submitted ${rows.length} approved week(s) to Overseer.`);
    setReloadKey((k) => k + 1); // reload the month
  }

  return (
    <main className="mx-auto max-w-6xl p-4 py-4 space-y-4">
      {toast && (
        <div className="fixed top-16 left-1/2 -translate-x-1/2 z-50 bg-primary text-primary-foreground px-4 py-2 rounded-md text-xs shadow-lg">
          {toast}
        </div>
      )}

      <div className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight">Elder Portal</h1>
        <p className="text-sm text-muted-foreground">
          Role: <span className="font-medium">{role}</span>
          {email ? <> · {email}</> : null}
        </p>
      </div>

      {/* Context filters */}
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor="elder-cong" className="text-xs text-muted-foreground">Congregation</label>
          <select id="elder-cong" className="flex h-9 min-w-48 rounded-md border border-input bg-background px-2 py-1 text-sm" value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="all">All congregations ({congregations.length})</option>
            {congregations.map((c) => (
              <option key={c.id} value={c.id}>{c.name} ({c.code})</option>
            ))}
          </select>
        </div>
        <div>
          <label htmlFor="elder-month" className="text-xs text-muted-foreground">Month</label>
          <input id="elder-month" type="month" className="flex h-9 w-40 rounded-md border border-input bg-background px-2 py-1 text-sm" value={selectedMonth} max={currentMonthValue()} onChange={(e) => handleMonthChange(e.target.value)} />
        </div>
      </div>

      {congregations.length === 0 ? (
        <Card><CardContent className="py-6"><p className="text-sm text-muted-foreground">No congregations are assigned to your eldership. Nothing to review.</p></CardContent></Card>
      ) : (
        <>
          {/* Tabs */}
          <div className="flex gap-1 border-b">
            {TABS.map((t) => (
              <button key={t.key} onClick={() => setActiveTab(t.key)}
                className={`px-4 py-2 text-xs font-medium border-b-2 transition-colors ${activeTab === t.key ? "border-primary text-primary font-bold" : "border-transparent text-muted-foreground hover:text-foreground"}`}>
                {t.label}
              </button>
            ))}
          </div>

          {/* ── GOVERNANCE ── */}
          {activeTab === "governance" && (
            <div className="space-y-4">
              <div className="overflow-x-auto">
                <table className="w-full text-xs border-collapse">
                  <thead>
                    <tr className="bg-muted text-left">
                      <th className="px-3 py-2">Congregation</th><th className="px-2 py-2">Code</th>
                      <th className="px-2 py-2 text-center">In Progress</th><th className="px-2 py-2 text-center">Awaiting Audit</th>
                      <th className="px-2 py-2 text-center">Audit Approved</th><th className="px-2 py-2 text-center">Submitted to Overseer</th>
                      <th className="px-2 py-2 text-center">Last Edit</th><th className="px-2 py-2">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {shownGov.map((r) => (
                      <tr key={r.congId} className="border-b">
                        <td className="px-3 py-2 font-medium">{r.congName}</td>
                        <td className="px-2 py-2">{r.code}</td>
                        <td className="px-2 py-2 text-center font-bold text-orange-700">{r.inProgress || "-"}</td>
                        <td className="px-2 py-2 text-center font-bold text-amber-600">{r.awaitingAudit || "-"}</td>
                        <td className="px-2 py-2 text-center font-bold text-green-700">{r.auditApproved || "-"}</td>
                        <td className="px-2 py-2 text-center font-bold text-blue-700">{r.submittedToOverseer || "-"}</td>
                        <td className="px-2 py-2 text-center">{r.lastEdit ?? "—"}</td>
                        <td className="px-2 py-2">
                          <Button size="sm" variant="outline" className="h-6 text-[10px]" onClick={() => setReviewCongId(reviewCongId === r.congId ? null : r.congId)}>
                            {reviewCongId === r.congId ? "Close" : "Review"}
                          </Button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* Review panel — drill into a week via the override-aware /audit/:periodId */}
              {reviewCongId && (
                <Card className="border-primary/40">
                  <CardContent className="py-4">
                    <div className="flex items-center justify-between mb-3">
                      <h3 className="text-sm font-bold">Week Detail: {congregations.find((c) => c.id === reviewCongId)?.name ?? ""}</h3>
                      <Button size="sm" variant="ghost" className="h-6 text-[10px]" onClick={() => setReviewCongId(null)}>✕ Close</Button>
                    </div>
                    {reviewPeriods.length === 0 ? (
                      <p className="text-xs text-muted-foreground">No periods captured this month.</p>
                    ) : (
                      <div className="space-y-1">
                        {reviewPeriods.map((p) => (
                          <button key={p.id} onClick={() => navigate(`/audit/${p.id}`)}
                            className="w-full flex items-center justify-between px-3 py-2 rounded border text-xs hover:bg-muted transition-colors text-left">
                            <span className="font-medium">Week {p.week} — {p.service}</span>
                            <Badge variant="outline" className="text-[9px]">
                              {p.status === "AuditApproved" ? "Approved" : p.status === "Submitted" ? "Pending Audit" : p.status}
                            </Badge>
                          </button>
                        ))}
                        <p className="pt-1 text-[10px] text-muted-foreground">Opens the review screen. Elder actions there are logged as SELF_REVIEW_EXCEPTION.</p>
                      </div>
                    )}
                  </CardContent>
                </Card>
              )}

              {/* Submission Summary */}
              <Card>
                <CardContent className="py-4">
                  <h3 className="text-sm font-bold mb-3">Submission Summary</h3>
                  <div className="overflow-x-auto">
                    <table className="w-full text-xs border-collapse">
                      <thead>
                        <tr className="bg-muted">
                          <th className="px-2 py-2 w-6" />
                          <th className="px-2 py-2 text-left">Congregation</th><th className="px-2 py-2 text-center">Weeks</th>
                          <th className="px-2 py-2 text-right">Members</th><th className="px-2 py-2 text-right">Officers</th>
                          <th className="px-2 py-2 text-right">Burial</th><th className="px-2 py-2 text-right">Expenses</th><th className="px-2 py-2 text-right">Total</th>
                        </tr>
                      </thead>
                      <tbody>
                        {shownGov.map((r) => {
                          const isExp = expanded.has(`sub-${r.congId}`);
                          return (
                            <Fragment key={r.congId}>
                              <tr className="border-b cursor-pointer hover:bg-muted/30" onClick={() => toggleExpand(`sub-${r.congId}`)}>
                                <td className="px-2 py-2 text-center">{isExp ? "−" : "+"}</td>
                                <td className="px-2 py-2 font-medium">{r.congName}</td>
                                <td className="px-2 py-2 text-center">
                                  <Badge variant={r.capturedWeeks >= r.totalWeeks ? "default" : r.capturedWeeks > 0 ? "secondary" : "outline"} className="text-[9px]">{r.capturedWeeks}/{r.totalWeeks}</Badge>
                                </td>
                                <td className="px-2 py-2 text-right">{money(r.members)}</td>
                                <td className="px-2 py-2 text-right">{money(r.officers)}</td>
                                <td className="px-2 py-2 text-right">{money(r.burial)}</td>
                                <td className="px-2 py-2 text-right">{money(r.expenses)}</td>
                                <td className="px-2 py-2 text-right font-bold">{money(r.total)}</td>
                              </tr>
                              {isExp && Array.from({ length: r.totalWeeks }, (_, i) => i + 1).map((wk) => {
                                const wkPeriods = periods.filter((p) => p.congregation_id === r.congId && p.week === wk);
                                if (wkPeriods.length === 0) {
                                  return (
                                    <tr key={`${r.congId}-w${wk}`} className="border-b bg-muted/20 text-muted-foreground">
                                      <td /><td className="px-2 py-1 pl-8">Week {wk}</td>
                                      <td className="px-2 py-1 text-center"><Badge variant="outline" className="text-[8px]">Not captured</Badge></td>
                                      <td colSpan={5} />
                                    </tr>
                                  );
                                }
                                return wkPeriods.map((wp) => {
                                  const wItems = items.filter((i) => i.period_id === wp.id);
                                  const sec = sectionTotals(toCaptureItems(wItems));
                                  return (
                                    <tr key={wp.id} className="border-b text-muted-foreground">
                                      <td /><td className="px-2 py-1 pl-8">Wk {wk} {wp.service}</td>
                                      <td className="px-2 py-1 text-center text-[9px]">{wp.status}</td>
                                      <td className="px-2 py-1 text-right">{money(sec.Members)}</td>
                                      <td className="px-2 py-1 text-right">{money(sec.Officers)}</td>
                                      <td className="px-2 py-1 text-right">{money(sec.Burial)}</td>
                                      <td className="px-2 py-1 text-right">{money(sec.Expenses)}</td>
                                      <td className="px-2 py-1 text-right">{money(sec.Members + sec.Officers + sec.Burial - sec.Expenses)}</td>
                                    </tr>
                                  );
                                });
                              })}
                            </Fragment>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  <div className="pt-4 text-center space-y-1">
                    <Button onClick={() => void handleSubmitAll()} disabled={submitting || !submitReady} className="px-6">
                      {submitting ? "Submitting…" : "Submit All Approved to Overseer"}
                    </Button>
                    <p className="text-[10px] text-muted-foreground">
                      Advances every audit-approved week to <span className="font-medium">SubmittedToOverseer</span> across all {govRows.length} congregation(s) in your eldership.
                      {!submitReady && " Enabled once every congregation has approved weeks and none are in progress or awaiting audit."}
                    </p>
                  </div>
                </CardContent>
              </Card>
            </div>
          )}

          {/* ── TITHING REVIEW ── */}
          {activeTab === "priest" && (
            <div className="space-y-4">
              <div className="overflow-x-auto">
                <table className="w-full text-xs border-collapse">
                  <thead>
                    <tr className="bg-muted">
                      <th className="px-2 py-1 w-6" /><th className="px-2 py-1 text-left">Priest Review</th>
                      <th className="px-2 py-1 text-right">Members Cash</th><th className="px-2 py-1 text-right">Members Dep/EFT</th><th className="px-2 py-1 text-right">Priestship Total</th>
                      <th className="px-2 py-1 text-right">Officers Cash</th><th className="px-2 py-1 text-right">Officers Dep/EFT</th><th className="px-2 py-1 text-right">Officer Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {priestCongs.map((c) => {
                      const isExp = expanded.has(`pr-${c.congId}`);
                      const congTotal = c.priestTotal + c.officerTotal;
                      return (
                        <Fragment key={c.congId}>
                          <tr className="border-b font-medium">
                            <td className="px-2 py-2 text-center cursor-pointer" onClick={() => toggleExpand(`pr-${c.congId}`)}>{isExp ? "−" : "+"}</td>
                            <td className="px-2 py-2 font-bold">{c.congName}</td>
                            <td className="px-2 py-2 text-right">{money(c.membersCash)}</td>
                            <td className="px-2 py-2 text-right">{money(c.membersDeposit)}</td>
                            <td className="px-2 py-2 text-right font-bold text-white bg-red-700">{money(c.priestTotal)}</td>
                            <td className="px-2 py-2 text-right">{money(c.officersCash)}</td>
                            <td className="px-2 py-2 text-right">{money(c.officersDeposit)}</td>
                            <td className="px-2 py-2 text-right font-bold text-white bg-teal-600">{money(c.officerTotal)}</td>
                          </tr>
                          <tr className="border-b bg-blue-50">
                            <td /><td className="px-2 py-1 text-[10px] text-muted-foreground">% Split (of eldership)</td>
                            <td className="px-2 py-1 text-right text-[10px]">{congTotal > 0 ? Math.round((c.membersCash / congTotal) * 100) : 0}%</td>
                            <td className="px-2 py-1 text-right text-[10px]">{congTotal > 0 ? Math.round((c.membersDeposit / congTotal) * 100) : 0}%</td>
                            <td className="px-2 py-1 text-right text-[10px] font-bold">{eldershipTotal > 0 ? Math.round((c.priestTotal / eldershipTotal) * 100) : 0}%</td>
                            <td className="px-2 py-1 text-right text-[10px]">{congTotal > 0 ? Math.round((c.officersCash / congTotal) * 100) : 0}%</td>
                            <td className="px-2 py-1 text-right text-[10px]">{congTotal > 0 ? Math.round((c.officersDeposit / congTotal) * 100) : 0}%</td>
                            <td className="px-2 py-1 text-right text-[10px] font-bold">{eldershipTotal > 0 ? Math.round((c.officerTotal / eldershipTotal) * 100) : 0}%</td>
                          </tr>
                          {isExp && c.priests.map((p) => (
                            <tr key={`${c.congId}-${p.officerCode}`} className="border-b" style={p.officerTotal === 0 ? { backgroundColor: "#fef9c3" } : undefined}>
                              <td /><td className="px-2 py-1 pl-8">{p.officerCode}</td>
                              <td className="px-2 py-1 text-right">{money(p.membersCash)}</td>
                              <td className="px-2 py-1 text-right">{money(p.membersDeposit)}</td>
                              <td className="px-2 py-1 text-right font-medium">{money(p.priestTotal)}</td>
                              <td className="px-2 py-1 text-right">{money(p.officersCash)}</td>
                              <td className="px-2 py-1 text-right">{money(p.officersDeposit)}</td>
                              <td className="px-2 py-1 text-right font-medium">{p.officerTotal > 0 ? money(p.officerTotal) : "R -"}</td>
                            </tr>
                          ))}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Cash Risk */}
              <Card>
                <CardContent className="py-3">
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div>
                      <p className="text-xs font-bold mb-2">Cash Risk (top 3 priestships by cash)</p>
                      {cashRisks.length === 0 ? (
                        <p className="text-[10px] text-muted-foreground">No cash contributions this month.</p>
                      ) : (
                        <div className="flex gap-2">
                          {cashRisks.map((r, i) => (
                            <div key={r.officerCode} className="text-center flex-1">
                              <p className="text-[10px] font-medium">{i + 1}. {r.officerCode}</p>
                              <p className="text-[10px]">R{r.amount.toFixed(0)}</p>
                              <div className="h-4 rounded text-[9px] text-white flex items-center justify-center bg-blue-700">{r.pct}% of total</div>
                              <div className="h-4 rounded text-[9px] text-white flex items-center justify-center mt-0.5 bg-orange-600">{r.cashPct}% of cash</div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                    <div className="text-xs space-y-1">
                      <div className="flex justify-between"><span>Total Cash</span><b>{money(totalCash)}</b></div>
                      <div className="flex justify-between"><span>Total EFT/Debit</span><b>{money(totalEFT)}</b></div>
                      <div className="flex justify-between border-t pt-1"><span>Eldership Total</span><b>{money(eldershipTotal)}</b></div>
                      <div className="flex gap-2 mt-1">
                        <span className="text-[10px] bg-orange-100 px-1 rounded">{eldershipTotal > 0 ? Math.round((totalCash / eldershipTotal) * 100) : 0}% cash</span>
                        <span className="text-[10px] bg-blue-100 px-1 rounded">{eldershipTotal > 0 ? Math.round((totalEFT / eldershipTotal) * 100) : 0}% EFT</span>
                      </div>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>
          )}

          {/* ── RISK & AUDIT ── */}
          {activeTab === "risk" && (
            <div className="overflow-x-auto">
              <table className="w-full text-xs border-collapse">
                <thead>
                  <tr className="bg-muted text-left">
                    <th className="px-3 py-2">Date</th><th className="px-3 py-2">Congregation</th><th className="px-2 py-2">Week</th>
                    <th className="px-2 py-2">Action</th><th className="px-2 py-2">Comment</th><th className="px-2 py-2">By</th>
                  </tr>
                </thead>
                <tbody>
                  {shownAudit.length === 0 ? (
                    <tr><td colSpan={6} className="px-3 py-4 text-center text-muted-foreground">No audit events for this period.</td></tr>
                  ) : (
                    shownAudit.map((r, i) => (
                      <tr key={i} className="border-b">
                        <td className="px-3 py-2">{r.date}</td>
                        <td className="px-3 py-2">{r.congregation}</td>
                        <td className="px-2 py-2">{r.week}</td>
                        <td className="px-2 py-2">
                          <Badge variant="outline" className={`text-[9px] ${r.action === "Approved" ? "bg-green-50 text-green-700 border-green-300" : r.action === "Rejected" ? "bg-red-50 text-red-700 border-red-300" : ""}`}>{r.action}</Badge>
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
        </>
      )}
    </main>
  );
}
