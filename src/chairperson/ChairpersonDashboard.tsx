// ─────────────────────────────────────────────────────────────────────────────
// CHAIRPERSON PORTAL (online-only). Mirrors the Elder Portal but scoped to a SINGLE
// congregation. The Chairperson is normally a Priest, subordinate to the Elder, and
// acts as the FALLBACK month-end submitter to the Overseer when the Elder is
// unavailable/tech-averse. Reads live from Supabase under RLS. No Dexie / offline path.
//
// Three tabs — Governance (+ Submission Summary), Tithing Review, Risk & Audit.
//
// Accountability (corrected against f6145ff1): the fallback submit advances
// AuditApproved periods to "SubmittedToOverseer" and logs MONTH_SUBMIT. Because the
// Chairperson holds month.submit_to_overseer as "O" (Override), the submit ALSO logs a
// SELF_REVIEW_EXCEPTION (audited-override invariant + historical behavior). It NEVER
// writes SubmittedToHO — that remains the Overseer's action.
//
// Editing/auditing is NOT rebuilt here: the per-week drill routes into the existing
// period-addressable /audit/:periodId screen, which already fires SELF_REVIEW_EXCEPTION
// for a Chairperson acting via its "O" override and returns to /chairperson. (/capture
// is NOT period-addressable in the Vite app.)
//
// Access gate: month.submit_to_overseer (Elder "S" / Chairperson "O") — derived from
// permissions.ts, no inline role-string comparison (Req 6.3).
// ─────────────────────────────────────────────────────────────────────────────

import { Fragment, useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { createClient } from "@/lib/supabase/client";
import { getUserAccess, hasPermission, isOverrideAction, logAuditAction, logSelfReviewException } from "@/lib/permissions";
import { useOnlineStatus } from "@/lib/useOnlineStatus";
import { getOacWeeks } from "@/lib/oacWeeks";
import { sectionTotals, type CaptureItem, type ItemType } from "@/lib/captureTotals";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { LineSection, Role, UserHierarchyAccess } from "@/lib/types";

const OFFLINE_MSG =
  "Offline Unavailable — Please connect to a stable network to review and submit month-end cashbooks.";

const IN_PROGRESS = ["Draft", "Rejected"];
const AT_OVERSEER_OR_BEYOND = ["SubmittedToOverseer", "OverseerApproved", "OverseerRejected", "SubmittedToHO", "HOReviewed"];
const CASH_TYPES = ["Cash", "CashBanked", "CashPending"];
const DEPOSIT_TYPES = ["EFT", "DirectDebit"];

interface CongOption { id: string; name: string; code: string; }
interface ChairPeriod { id: string; congregation_id: string; week: number; service: string; status: string; created_at: string; }
interface ChairLineItem { id: string; period_id: string; section: string; is_officer: boolean; item_type: string; amount: number; officer_id: string | null; proof_status: string | null; }
interface ChairOfficer { id: string; officer_code: string; congregation_id: string; }
interface AuditRow { date: string; action: string; week: string; comment: string; by: string; }
interface PriestRow { officerCode: string; membersCash: number; membersDeposit: number; priestTotal: number; officersCash: number; officersDeposit: number; officerTotal: number; }

const money = (n: number) => `R${n.toFixed(2)}`;
const currentMonthValue = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};

const toCaptureItems = (rows: ChairLineItem[]): CaptureItem[] =>
  rows.map((r) => ({ section: r.section as LineSection, item_type: r.item_type as ItemType, amount: Number(r.amount), proof_status: r.proof_status, item_count: null }));
const sumCash = (rows: ChairLineItem[]) => rows.filter((i) => CASH_TYPES.includes(i.item_type)).reduce((s, i) => s + Number(i.amount), 0);
const sumDeposit = (rows: ChairLineItem[]) => rows.filter((i) => DEPOSIT_TYPES.includes(i.item_type)).reduce((s, i) => s + Number(i.amount), 0);
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

export function ChairpersonDashboard() {
  const supabase = createClient();
  const navigate = useNavigate();
  const online = useOnlineStatus();

  const [access, setAccess] = useState<UserHierarchyAccess | null>(null);
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [activeTab, setActiveTab] = useState<TabKey>("governance");
  const [congregation, setCongregation] = useState<CongOption | null>(null);
  const [selectedMonth, setSelectedMonth] = useState<string>(currentMonthValue);

  const [periods, setPeriods] = useState<ChairPeriod[]>([]);
  const [items, setItems] = useState<ChairLineItem[]>([]);
  const [officers, setOfficers] = useState<ChairOfficer[]>([]);
  const [auditRows, setAuditRows] = useState<AuditRow[]>([]);

  const [showReview, setShowReview] = useState(false);
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

  // ── Single-congregation resolver + month-scope controller ──────────────────
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

      const { data: assignments } = await supabase
        .from("user_congregation_assignments")
        .select("congregation_id")
        .eq("user_id", user.id)
        .eq("status", "active")
        .limit(1);

      let cong: CongOption | null = null;
      const assignedId = assignments?.[0]?.congregation_id as string | undefined;
      if (assignedId) {
        const { data } = await supabase.from("congregations").select("id, name, code").eq("id", assignedId).maybeSingle();
        cong = (data as CongOption) ?? null;
      } else {
        const { data } = await supabase.from("congregations").select("id, name, code").eq("eldership_id", ua.hierarchy_id).limit(1).maybeSingle();
        cong = (data as CongOption) ?? null;
      }
      if (!active) return;
      setCongregation(cong);

      if (!cong) {
        setPeriods([]); setItems([]); setOfficers([]); setAuditRows([]);
        setLoading(false);
        return;
      }

      const [year, month] = selectedMonth.split("-").map(Number);

      const { data: periodRows } = await supabase
        .from("cashbook_period")
        .select("id, congregation_id, week, service, status, created_at")
        .eq("congregation_id", cong.id)
        .eq("year", year)
        .eq("month", month);
      if (!active) return;
      const monthPeriods = (periodRows ?? []) as ChairPeriod[];
      setPeriods(monthPeriods);

      const periodIds = monthPeriods.map((p) => p.id);
      if (periodIds.length > 0) {
        const { data: itemRows } = await supabase
          .from("cashbook_line_item")
          .select("id, period_id, section, is_officer, item_type, amount, officer_id, proof_status")
          .in("period_id", periodIds);
        if (!active) return;
        setItems((itemRows ?? []) as ChairLineItem[]);
      } else {
        setItems([]);
      }

      const { data: officerRows } = await supabase
        .from("officers")
        .select("id, officer_code, congregation_id")
        .eq("congregation_id", cong.id)
        .eq("is_active", true);
      if (!active) return;
      setOfficers((officerRows ?? []) as ChairOfficer[]);

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
            return {
              date: fmtDate(l.created_at as string),
              action: mapAction(l.action_type as string),
              week: per ? `Wk ${per.week} ${per.service}` : "—",
              comment: (l.comment as string) ?? "",
              by: roleMap[l.user_id as string] ?? "—",
            };
          });
        }
      }
      if (auditData.length === 0) {
        auditData = monthPeriods
          .filter((p) => p.status !== "Draft")
          .map((p) => ({ date: "—", action: statusAction(p.status), week: `Wk ${p.week} ${p.service}`, comment: "", by: "—" }));
      }
      if (!active) return;
      setAuditRows(auditData);

      setLoading(false);
    })();
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedMonth, reloadKey]);

  // ── Guards ─────────────────────────────────────────────────────────────────
  if (!online) return <p className="p-6 text-sm text-amber-700">{OFFLINE_MSG}</p>;
  if (loading) return <p className="p-6 text-sm text-muted-foreground">Loading…</p>;
  if (!role || !hasPermission(role, "month.submit_to_overseer")) {
    return <p className="p-6 text-sm text-destructive">Access denied. Chairperson role required.</p>;
  }

  const [year, month] = selectedMonth.split("-").map(Number);
  const totalWeeks = getOacWeeks(year, month).length;

  // ── Governance (single congregation) ───────────────────────────────────────
  const sec = sectionTotals(toCaptureItems(items));
  const inProgress = periods.filter((p) => IN_PROGRESS.includes(p.status)).length;
  const awaitingAudit = periods.filter((p) => p.status === "Submitted").length;
  const auditApproved = periods.filter((p) => p.status === "AuditApproved").length;
  const submittedToOverseer = periods.filter((p) => AT_OVERSEER_OR_BEYOND.includes(p.status)).length;
  const capturedWeeks = new Set(periods.map((p) => p.week)).size;
  const lastTs = periods.reduce((max, p) => Math.max(max, new Date(p.created_at).getTime()), 0);
  const govTotal = sec.Members + sec.Officers + sec.Burial - sec.Expenses;
  const submitReady = periods.length > 0 && auditApproved > 0 && inProgress === 0 && awaitingAudit === 0;

  // ── Tithing Review ─────────────────────────────────────────────────────────
  const priests: PriestRow[] = officers.map((o) => {
    const oItems = items.filter((i) => i.officer_id === o.id);
    const memberItems = oItems.filter((i) => !i.is_officer);
    const officerItems = oItems.filter((i) => i.is_officer);
    const mCash = sumCash(memberItems), mDep = sumDeposit(memberItems), oCash = sumCash(officerItems), oDep = sumDeposit(officerItems);
    return { officerCode: o.officer_code, membersCash: mCash, membersDeposit: mDep, priestTotal: mCash + mDep, officersCash: oCash, officersDeposit: oDep, officerTotal: oCash + oDep };
  });
  const totalCash = priests.reduce((s, p) => s + p.membersCash + p.officersCash, 0);
  const totalEFT = priests.reduce((s, p) => s + p.membersDeposit + p.officersDeposit, 0);
  const congTotal = totalCash + totalEFT;
  const cashRisks = priests
    .filter((p) => p.membersCash + p.officersCash > 0)
    .sort((a, b) => b.membersCash + b.officersCash - (a.membersCash + a.officersCash))
    .slice(0, 3)
    .map((p) => {
      const amount = p.membersCash + p.officersCash;
      return { officerCode: p.officerCode, amount, pct: congTotal > 0 ? Math.round((amount / congTotal) * 100) : 0, cashPct: totalCash > 0 ? Math.round((amount / totalCash) * 100) : 0 };
    });

  const reviewPeriods = [...periods].sort((a, b) => a.week - b.week);

  // ── Month-end fallback submission (Task 24) ────────────────────────────────
  async function handleSubmitAll() {
    if (!access || !congregation || submitting || !submitReady) return;
    setSubmitting(true);
    const [y, m] = selectedMonth.split("-").map(Number);
    const { data, error } = await supabase
      .from("cashbook_period")
      .update({ status: "SubmittedToOverseer" }) // NEVER SubmittedToHO — that is the Overseer's action.
      .eq("congregation_id", congregation.id)
      .eq("year", y)
      .eq("month", m)
      .eq("status", "AuditApproved")
      .select("id");

    if (error) {
      setToast(error.message);
      setSubmitting(false);
      return;
    }
    const rows = (data ?? []) as { id: string }[];
    const entityId = `${congregation.id}_${y}_${m}`;

    // Chairperson submit is an Override ("O") → audited self-review exception (invariant #6).
    if (role && isOverrideAction(role, "month.submit_to_overseer")) {
      await logSelfReviewException({
        userId: access.user_id,
        entityType: "monthly_close",
        entityId,
        assumedRole: "Elder",
        comment: "Chairperson submitted to Overseer (Elder fallback)",
      });
    }
    // Mandatory month submission trace.
    await logAuditAction({
      userId: access.user_id,
      actionType: "MONTH_SUBMIT",
      entityType: "monthly_close",
      entityId,
      comment: `Month ${y}/${String(m).padStart(2, "0")} submitted to Overseer by Chairperson (Elder fallback)`,
      metadata: { year: y, month: m, congregation_id: congregation.id },
    });

    setSubmitting(false);
    setToast(`Submitted ${rows.length} approved week(s) to Overseer.`);
    setReloadKey((k) => k + 1);
  }

  return (
    <main className="mx-auto max-w-4xl p-4 py-4 space-y-4">
      {toast && (
        <div className="fixed top-16 left-1/2 -translate-x-1/2 z-50 bg-primary text-primary-foreground px-4 py-2 rounded-md text-xs shadow-lg">
          {toast}
        </div>
      )}

      <div className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight">Chairperson Portal</h1>
        <p className="text-sm text-muted-foreground">
          Role: <span className="font-medium">{role}</span>
          {email ? <> · {email}</> : null} · fallback submitter to Overseer
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor="chair-month" className="text-xs text-muted-foreground">Month</label>
          <input id="chair-month" type="month" className="flex h-9 w-40 rounded-md border border-input bg-background px-2 py-1 text-sm" value={selectedMonth} max={currentMonthValue()} onChange={(e) => handleMonthChange(e.target.value)} />
        </div>
      </div>

      {!congregation ? (
        <Card><CardContent className="py-6"><p className="text-sm text-muted-foreground">No congregation is assigned to you. Nothing to review.</p></CardContent></Card>
      ) : (
        <>
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
              <div className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
                Fallback role: submit the month to the Overseer only when the Elder is unavailable or tech-averse. This action is logged as a self-review exception.
              </div>

              <div className="overflow-x-auto">
                <table className="w-full text-xs border-collapse">
                  <thead>
                    <tr className="bg-muted text-left">
                      <th className="px-3 py-2">Congregation</th>
                      <th className="px-2 py-2 text-center">In Progress</th><th className="px-2 py-2 text-center">Awaiting Audit</th>
                      <th className="px-2 py-2 text-center">Audit Approved</th><th className="px-2 py-2 text-center">Submitted to Overseer</th>
                      <th className="px-2 py-2 text-center">Last Edit</th><th className="px-2 py-2">Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    <tr className="border-b">
                      <td className="px-3 py-2 font-medium">{congregation.name} ({congregation.code})</td>
                      <td className="px-2 py-2 text-center font-bold text-orange-700">{inProgress || "-"}</td>
                      <td className="px-2 py-2 text-center font-bold text-amber-600">{awaitingAudit || "-"}</td>
                      <td className="px-2 py-2 text-center font-bold text-green-700">{auditApproved || "-"}</td>
                      <td className="px-2 py-2 text-center font-bold text-blue-700">{submittedToOverseer || "-"}</td>
                      <td className="px-2 py-2 text-center">{lastTs > 0 ? fmtDate(new Date(lastTs).toISOString()) : "—"}</td>
                      <td className="px-2 py-2">
                        <Button size="sm" variant="outline" className="h-6 text-[10px]" onClick={() => setShowReview((v) => !v)}>
                          {showReview ? "Close" : "Review"}
                        </Button>
                      </td>
                    </tr>
                  </tbody>
                </table>
              </div>

              {/* Review panel — drill into a week via the override-aware /audit/:periodId */}
              {showReview && (
                <Card className="border-primary/40">
                  <CardContent className="py-4">
                    <div className="flex items-center justify-between mb-3">
                      <h3 className="text-sm font-bold">Week Detail: {congregation.name}</h3>
                      <Button size="sm" variant="ghost" className="h-6 text-[10px]" onClick={() => setShowReview(false)}>✕ Close</Button>
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
                        <p className="pt-1 text-[10px] text-muted-foreground">Opens the review screen. Chairperson actions there are logged as SELF_REVIEW_EXCEPTION.</p>
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
                        <Fragment>
                          <tr className="border-b cursor-pointer hover:bg-muted/30" onClick={() => toggleExpand("sub")}>
                            <td className="px-2 py-2 text-center">{expanded.has("sub") ? "−" : "+"}</td>
                            <td className="px-2 py-2 font-medium">{congregation.name}</td>
                            <td className="px-2 py-2 text-center">
                              <Badge variant={capturedWeeks >= totalWeeks ? "default" : capturedWeeks > 0 ? "secondary" : "outline"} className="text-[9px]">{capturedWeeks}/{totalWeeks}</Badge>
                            </td>
                            <td className="px-2 py-2 text-right">{money(sec.Members)}</td>
                            <td className="px-2 py-2 text-right">{money(sec.Officers)}</td>
                            <td className="px-2 py-2 text-right">{money(sec.Burial)}</td>
                            <td className="px-2 py-2 text-right">{money(sec.Expenses)}</td>
                            <td className="px-2 py-2 text-right font-bold">{money(govTotal)}</td>
                          </tr>
                          {expanded.has("sub") && Array.from({ length: totalWeeks }, (_, i) => i + 1).map((wk) => {
                            const wkPeriods = periods.filter((p) => p.week === wk);
                            if (wkPeriods.length === 0) {
                              return (
                                <tr key={`w${wk}`} className="border-b bg-muted/20 text-muted-foreground">
                                  <td /><td className="px-2 py-1 pl-8">Week {wk}</td>
                                  <td className="px-2 py-1 text-center"><Badge variant="outline" className="text-[8px]">Not captured</Badge></td>
                                  <td colSpan={5} />
                                </tr>
                              );
                            }
                            return wkPeriods.map((wp) => {
                              const wItems = items.filter((i) => i.period_id === wp.id);
                              const ws = sectionTotals(toCaptureItems(wItems));
                              return (
                                <tr key={wp.id} className="border-b text-muted-foreground">
                                  <td /><td className="px-2 py-1 pl-8">Wk {wk} {wp.service}</td>
                                  <td className="px-2 py-1 text-center text-[9px]">{wp.status}</td>
                                  <td className="px-2 py-1 text-right">{money(ws.Members)}</td>
                                  <td className="px-2 py-1 text-right">{money(ws.Officers)}</td>
                                  <td className="px-2 py-1 text-right">{money(ws.Burial)}</td>
                                  <td className="px-2 py-1 text-right">{money(ws.Expenses)}</td>
                                  <td className="px-2 py-1 text-right">{money(ws.Members + ws.Officers + ws.Burial - ws.Expenses)}</td>
                                </tr>
                              );
                            });
                          })}
                        </Fragment>
                      </tbody>
                    </table>
                  </div>

                  <div className="pt-4 text-center space-y-1">
                    <Button onClick={() => void handleSubmitAll()} disabled={submitting || !submitReady} className="px-6">
                      {submitting ? "Submitting…" : "Submit All Approved to Overseer (Fallback)"}
                    </Button>
                    <p className="text-[10px] text-muted-foreground">
                      Advances every audit-approved week to <span className="font-medium">SubmittedToOverseer</span>; logs MONTH_SUBMIT + SELF_REVIEW_EXCEPTION.
                      {!submitReady && " Enabled once the congregation has approved weeks and none are in progress or awaiting audit."}
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
                      <th className="px-2 py-1 text-left">Priest</th>
                      <th className="px-2 py-1 text-right">Members Cash</th><th className="px-2 py-1 text-right">Members Dep/EFT</th><th className="px-2 py-1 text-right">Priestship Total</th>
                      <th className="px-2 py-1 text-right">Officers Cash</th><th className="px-2 py-1 text-right">Officers Dep/EFT</th><th className="px-2 py-1 text-right">Officer Total</th>
                    </tr>
                  </thead>
                  <tbody>
                    {priests.length === 0 ? (
                      <tr><td colSpan={7} className="px-2 py-4 text-center text-muted-foreground">No active officers.</td></tr>
                    ) : (
                      priests.map((p) => (
                        <tr key={p.officerCode} className="border-b" style={p.priestTotal + p.officerTotal === 0 ? { backgroundColor: "#fef9c3" } : undefined}>
                          <td className="px-2 py-1 font-medium">{p.officerCode}</td>
                          <td className="px-2 py-1 text-right">{money(p.membersCash)}</td>
                          <td className="px-2 py-1 text-right">{money(p.membersDeposit)}</td>
                          <td className="px-2 py-1 text-right font-bold">{money(p.priestTotal)}</td>
                          <td className="px-2 py-1 text-right">{money(p.officersCash)}</td>
                          <td className="px-2 py-1 text-right">{money(p.officersDeposit)}</td>
                          <td className="px-2 py-1 text-right font-bold">{p.officerTotal > 0 ? money(p.officerTotal) : "R -"}</td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>

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
                      <div className="flex justify-between border-t pt-1"><span>Congregation Total</span><b>{money(congTotal)}</b></div>
                      <div className="flex gap-2 mt-1">
                        <span className="text-[10px] bg-orange-100 px-1 rounded">{congTotal > 0 ? Math.round((totalCash / congTotal) * 100) : 0}% cash</span>
                        <span className="text-[10px] bg-blue-100 px-1 rounded">{congTotal > 0 ? Math.round((totalEFT / congTotal) * 100) : 0}% EFT</span>
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
                    <th className="px-3 py-2">Date</th><th className="px-2 py-2">Week</th>
                    <th className="px-2 py-2">Action</th><th className="px-2 py-2">Comment</th><th className="px-2 py-2">By</th>
                  </tr>
                </thead>
                <tbody>
                  {auditRows.length === 0 ? (
                    <tr><td colSpan={5} className="px-3 py-4 text-center text-muted-foreground">No audit events for this period.</td></tr>
                  ) : (
                    auditRows.map((r, i) => (
                      <tr key={i} className="border-b">
                        <td className="px-3 py-2">{r.date}</td>
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
