// ─────────────────────────────────────────────────────────────────────────────
// OVERSEER / APOSTLE REVIEW (online-only). Consolidated hierarchy rollup for an
// Overseership: all congregations under the Overseer's node, grouped by eldership.
// Three tabs — Governance (status rollup + drill + approval + submit-to-HO),
// Tithing Review (per-priest cash-vs-deposit with subtotals + cash risk), and
// Risk & Audit (audit_log feed). Reads live from Supabase under RLS. No Dexie.
//
// Option B two-stage flow:
//   (1) Individual approve/reject of SubmittedToOverseer periods (optimistic lock on
//       status=SubmittedToOverseer). Approve → OverseerApproved (+OVERSEER_APPROVE);
//       Reject (comment required) → OverseerRejected (+OVERSEER_REJECT).
//   (2) Batch "Submit All OverseerApproved to HO": OverseerApproved → SubmittedToHO
//       (idempotent), logs MONTH_SUBMIT_TO_HO per congregation-month. Never writes
//       HOReviewed (that is HO's action).
//
// Permission mapping: approve/reject gate on month.overseer_approve/reject (Overseer
// ="A"); batch submit gate on month.submit_to_ho (Overseer="S"); page gate on
// overseer.view. All via permissions.ts. Canonical route /review (+ /overseer alias).
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { createClient } from "@/lib/supabase/client";
import { getUserAccess, hasPermission, logAuditAction } from "@/lib/permissions";
import { useOnlineStatus } from "@/lib/useOnlineStatus";
import { getOacWeeks } from "@/lib/oacWeeks";
import { sectionTotals, type CaptureItem, type ItemType } from "@/lib/captureTotals";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { LineSection, Role, UserHierarchyAccess } from "@/lib/types";

const OFFLINE_MSG =
  "Offline Unavailable — Please connect to a stable network to review submissions.";

const IN_PROGRESS = ["Draft", "Rejected"];
const AT_HO = ["SubmittedToHO", "HOReviewed"];
const CASH_TYPES = ["Cash", "CashBanked", "CashPending"];
const DEPOSIT_TYPES = ["EFT", "DirectDebit"];

interface ReviewCong { id: string; name: string; code: string; eldership_id: string | null; }
interface ReviewPeriod { id: string; congregation_id: string; week: number; service: string; status: string; created_at: string; }
interface ReviewLineItem { id: string; period_id: string; section: string; is_officer: boolean; item_type: string; amount: number; officer_id: string | null; proof_status: string | null; }
interface ReviewOfficer { id: string; officer_code: string; congregation_id: string; }
interface EldershipGroup { eldershipId: string; eldershipName: string; congregations: ReviewCong[]; }
interface AuditRow { date: string; congregation: string; week: string; action: string; comment: string; by: string; }
interface PriestRow { officerCode: string; congId: string; membersCash: number; membersDeposit: number; officersCash: number; officersDeposit: number; priestTotal: number; officerTotal: number; }

interface CongBuckets {
  inProgress: number; awaitingAudit: number; auditApproved: number;
  submittedToOverseer: number; overseerApproved: number; overseerRejected: number; submittedToHO: number;
}

type TabKey = "governance" | "priest" | "risk";
const TABS: { key: TabKey; label: string }[] = [
  { key: "governance", label: "Governance" },
  { key: "priest", label: "Tithing Review" },
  { key: "risk", label: "Risk & Audit" },
];

const money = (n: number) => `R${n.toFixed(2)}`;
const currentMonthValue = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};
const toCaptureItems = (rows: ReviewLineItem[]): CaptureItem[] =>
  rows.map((r) => ({ section: r.section as LineSection, item_type: r.item_type as ItemType, amount: Number(r.amount), proof_status: r.proof_status, item_count: null }));
const sumCash = (rows: ReviewLineItem[]) => rows.filter((i) => CASH_TYPES.includes(i.item_type)).reduce((s, i) => s + Number(i.amount), 0);
const sumDeposit = (rows: ReviewLineItem[]) => rows.filter((i) => DEPOSIT_TYPES.includes(i.item_type)).reduce((s, i) => s + Number(i.amount), 0);
const fmtDate = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
const mapAction = (t: string) =>
  t === "AUDIT_APPROVE" ? "Audit Approved"
    : t === "AUDIT_REJECT" ? "Audit Rejected"
    : t === "SUBMIT" ? "Submitted for Audit"
    : t === "MONTH_SUBMIT" ? "Submitted to Overseer"
    : t === "OVERSEER_APPROVE" ? "Overseer Approved"
    : t === "OVERSEER_REJECT" ? "Overseer Rejected"
    : t === "MONTH_SUBMIT_TO_HO" ? "Submitted to HO"
    : t === "SELF_REVIEW_EXCEPTION" ? "Override"
    : t === "HO_REVIEW" ? "HO Reviewed"
    : t;
const statusAction = (s: string) =>
  s === "AuditApproved" ? "Audit Approved"
    : s === "Submitted" ? "Submitted for Audit"
    : s === "SubmittedToOverseer" ? "Submitted to Overseer"
    : s === "OverseerApproved" ? "Overseer Approved"
    : s === "OverseerRejected" ? "Overseer Rejected"
    : s === "SubmittedToHO" ? "Submitted to HO"
    : s === "HOReviewed" ? "HO Reviewed"
    : s === "Rejected" ? "Rejected"
    : s;

export function OverseerReview() {
  const supabase = createClient();
  const navigate = useNavigate();
  const online = useOnlineStatus();

  const [access, setAccess] = useState<UserHierarchyAccess | null>(null);
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<string | null>(null);
  const [processing, setProcessing] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [activeTab, setActiveTab] = useState<TabKey>("governance");

  const [congregations, setCongregations] = useState<ReviewCong[]>([]);
  const [groups, setGroups] = useState<EldershipGroup[]>([]);
  const [selectedMonth, setSelectedMonth] = useState<string>(currentMonthValue);

  const [periods, setPeriods] = useState<ReviewPeriod[]>([]);
  const [items, setItems] = useState<ReviewLineItem[]>([]);
  const [officers, setOfficers] = useState<ReviewOfficer[]>([]);
  const [auditRows, setAuditRows] = useState<AuditRow[]>([]);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [reloadKey, setReloadKey] = useState(0);

  const role = access?.role as Role | undefined;
  const canApprove = role ? hasPermission(role, "month.overseer_approve") : false;
  const canReject = role ? hasPermission(role, "month.overseer_reject") : false;
  const canSubmitHO = role ? hasPermission(role, "month.submit_to_ho") : false;

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
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

  // ── Overseership resolver + month-scope controller ─────────────────────────
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

      const { data: congRows } = await supabase
        .from("congregations")
        .select("id, name, code, eldership_id")
        .eq("overseership_id", ua.hierarchy_id)
        .order("name");
      if (!active) return;
      const congs = (congRows ?? []) as ReviewCong[];
      setCongregations(congs);

      const eldIds = [...new Set(congs.map((c) => c.eldership_id).filter((x): x is string => !!x))];
      const eldNames: Record<string, string> = {};
      if (eldIds.length > 0) {
        const { data: elds } = await supabase.from("hierarchy_levels").select("id, name").in("id", eldIds);
        (elds ?? []).forEach((e) => { eldNames[e.id as string] = e.name as string; });
      }
      const byEld = new Map<string, EldershipGroup>();
      for (const c of congs) {
        const key = c.eldership_id ?? "unassigned";
        if (!byEld.has(key)) byEld.set(key, { eldershipId: key, eldershipName: eldNames[key] ?? (c.eldership_id ? "Eldership" : "Unassigned"), congregations: [] });
        byEld.get(key)!.congregations.push(c);
      }
      if (!active) return;
      setGroups([...byEld.values()]);

      const ids = congs.map((c) => c.id);
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
      const monthPeriods = (periodRows ?? []) as ReviewPeriod[];
      setPeriods(monthPeriods);

      const periodIds = monthPeriods.map((p) => p.id);
      if (periodIds.length > 0) {
        const { data: itemRows } = await supabase
          .from("cashbook_line_item")
          .select("id, period_id, section, is_officer, item_type, amount, officer_id, proof_status")
          .in("period_id", periodIds);
        if (!active) return;
        setItems((itemRows ?? []) as ReviewLineItem[]);
      } else {
        setItems([]);
      }

      const { data: officerRows } = await supabase
        .from("officers")
        .select("id, officer_code, congregation_id")
        .in("congregation_id", ids)
        .eq("is_active", true);
      if (!active) return;
      setOfficers((officerRows ?? []) as ReviewOfficer[]);

      // Risk & Audit: period-level events AND monthly_close events (MONTH_SUBMIT /
      // MONTH_SUBMIT_TO_HO log against `{congId}_{year}_{month}`), limit 50.
      const monthlyKeys = ids.map((cid) => `${cid}_${year}_${month}`);
      const auditEntityIds = [...periodIds, ...monthlyKeys];
      let auditData: AuditRow[] = [];
      if (auditEntityIds.length > 0) {
        const { data: logs } = await supabase
          .from("audit_log")
          .select("user_id, action_type, entity_id, comment, created_at")
          .in("entity_id", auditEntityIds)
          .order("created_at", { ascending: false })
          .limit(50);
        if (logs && logs.length > 0) {
          const userIds = [...new Set(logs.map((l) => l.user_id as string))];
          const { data: accessRows } = await supabase.from("user_hierarchy_access").select("user_id, role").in("user_id", userIds).eq("status", "active");
          const roleMap: Record<string, string> = {};
          (accessRows ?? []).forEach((a) => { roleMap[a.user_id as string] = a.role as string; });
          const pById = new Map(monthPeriods.map((p) => [p.id, p]));
          const cById = new Map(congs.map((c) => [c.id, c]));
          auditData = logs.map((l) => {
            const eid = l.entity_id as string;
            const per = pById.get(eid);
            let congName = "";
            let week = "";
            if (per) { congName = cById.get(per.congregation_id)?.name ?? ""; week = `Wk ${per.week} ${per.service}`; }
            else { congName = cById.get(eid.split("_")[0])?.name ?? ""; week = "Month"; }
            return {
              date: fmtDate(l.created_at as string),
              congregation: congName,
              week,
              action: mapAction(l.action_type as string),
              comment: (l.comment as string) ?? "",
              by: roleMap[l.user_id as string] ?? "—",
            };
          });
        }
      }
      if (auditData.length === 0) {
        auditData = monthPeriods
          .filter((p) => p.status !== "Draft")
          .map((p) => ({ date: "—", congregation: congs.find((c) => c.id === p.congregation_id)?.name ?? "", week: `Wk ${p.week} ${p.service}`, action: statusAction(p.status), comment: "", by: "—" }));
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
  if (!role || !hasPermission(role, "overseer.view")) {
    return <p className="p-6 text-sm text-destructive">Access denied. Overseer role required.</p>;
  }

  const [year, month] = selectedMonth.split("-").map(Number);
  const totalWeeks = getOacWeeks(year, month).length;

  const bucketsFor = (congId: string): CongBuckets => {
    const cp = periods.filter((p) => p.congregation_id === congId);
    return {
      inProgress: cp.filter((p) => IN_PROGRESS.includes(p.status)).length,
      awaitingAudit: cp.filter((p) => p.status === "Submitted").length,
      auditApproved: cp.filter((p) => p.status === "AuditApproved").length,
      submittedToOverseer: cp.filter((p) => p.status === "SubmittedToOverseer").length,
      overseerApproved: cp.filter((p) => p.status === "OverseerApproved").length,
      overseerRejected: cp.filter((p) => p.status === "OverseerRejected").length,
      submittedToHO: cp.filter((p) => AT_HO.includes(p.status)).length,
    };
  };

  const submitReady =
    congregations.length > 0 &&
    congregations.every((c) => {
      const b = bucketsFor(c.id);
      return b.overseerApproved > 0 && b.inProgress === 0 && b.awaitingAudit === 0 && b.submittedToOverseer === 0 && b.overseerRejected === 0;
    });

  const overseershipSec = sectionTotals(toCaptureItems(items));
  const overseershipTotal = overseershipSec.Members + overseershipSec.Officers + overseershipSec.Burial - overseershipSec.Expenses;

  // ── Tithing Review (per priest, aggregated to congregation/eldership/overseership) ──
  const priestRows: PriestRow[] = officers.map((o) => {
    const oItems = items.filter((i) => i.officer_id === o.id);
    const m = oItems.filter((i) => !i.is_officer);
    const of = oItems.filter((i) => i.is_officer);
    const mc = sumCash(m), md = sumDeposit(m), oc = sumCash(of), od = sumDeposit(of);
    return { officerCode: o.officer_code, congId: o.congregation_id, membersCash: mc, membersDeposit: md, officersCash: oc, officersDeposit: od, priestTotal: mc + md, officerTotal: oc + od };
  });
  const priestsForCong = (congId: string) => priestRows.filter((p) => p.congId === congId);
  const congCashDep = (congId: string) => {
    const rows = priestsForCong(congId);
    const cash = rows.reduce((s, p) => s + p.membersCash + p.officersCash, 0);
    const dep = rows.reduce((s, p) => s + p.membersDeposit + p.officersDeposit, 0);
    return { cash, dep, total: cash + dep };
  };
  const ovTotalCash = priestRows.reduce((s, p) => s + p.membersCash + p.officersCash, 0);
  const ovTotalDeposit = priestRows.reduce((s, p) => s + p.membersDeposit + p.officersDeposit, 0);
  const ovTithingTotal = ovTotalCash + ovTotalDeposit;
  const cashRisk = priestRows
    .filter((p) => p.membersCash + p.officersCash > 0)
    .sort((a, b) => b.membersCash + b.officersCash - (a.membersCash + a.officersCash))
    .slice(0, 3)
    .map((p) => {
      const amount = p.membersCash + p.officersCash;
      return { officerCode: p.officerCode, amount, pct: ovTithingTotal > 0 ? Math.round((amount / ovTithingTotal) * 100) : 0, cashPct: ovTotalCash > 0 ? Math.round((amount / ovTotalCash) * 100) : 0 };
    });

  // ── Stage 1: individual approve/reject (optimistic lock) ───────────────────
  async function decide(periodId: string, kind: "approve" | "reject") {
    if (!access) return;
    if (kind === "approve" && !canApprove) return;
    if (kind === "reject" && !canReject) return;

    let comment = "";
    if (kind === "reject") {
      const input = window.prompt("Rejection comment (required):");
      if (!input || !input.trim()) return;
      comment = input.trim();
    }

    setProcessing(periodId);
    const newStatus = kind === "approve" ? "OverseerApproved" : "OverseerRejected";
    const patch: Record<string, unknown> = { status: newStatus };
    if (kind === "reject") patch.overseer_comment = comment;

    const { data, error } = await supabase
      .from("cashbook_period")
      .update(patch)
      .eq("id", periodId)
      .eq("status", "SubmittedToOverseer")
      .select("id");

    if (error) { setToast(error.message); setProcessing(null); return; }
    if (!data || data.length === 0) {
      setToast("This period was already actioned elsewhere. Reloading…");
      setProcessing(null);
      setReloadKey((k) => k + 1);
      return;
    }
    await logAuditAction({
      userId: access.user_id,
      actionType: kind === "approve" ? "OVERSEER_APPROVE" : "OVERSEER_REJECT",
      entityType: "cashbook_period",
      entityId: periodId,
      comment: kind === "approve" ? "Overseer approved" : comment,
    });
    setProcessing(null);
    setToast(kind === "approve" ? "Period approved." : "Period rejected.");
    setReloadKey((k) => k + 1);
  }

  // ── Stage 2: batch submit OverseerApproved → SubmittedToHO ──────────────────
  async function handleSubmitToHO() {
    if (!access || submitting || !submitReady || !canSubmitHO) return;
    setSubmitting(true);
    const [y, m] = selectedMonth.split("-").map(Number);
    const congIds = congregations.map((c) => c.id);

    const { data, error } = await supabase
      .from("cashbook_period")
      .update({ status: "SubmittedToHO" }) // NEVER HOReviewed — that is HO's action.
      .in("congregation_id", congIds)
      .eq("year", y)
      .eq("month", m)
      .eq("status", "OverseerApproved")
      .select("id, congregation_id");

    if (error) { setToast(error.message); setSubmitting(false); return; }
    const rows = (data ?? []) as { id: string; congregation_id: string }[];
    const submittedCongs = [...new Set(rows.map((r) => r.congregation_id))];
    for (const cid of submittedCongs) {
      await logAuditAction({
        userId: access.user_id,
        actionType: "MONTH_SUBMIT_TO_HO",
        entityType: "monthly_close",
        entityId: `${cid}_${y}_${m}`,
        comment: `Month ${y}/${String(m).padStart(2, "0")} submitted to HO by Overseer`,
        metadata: { year: y, month: m, congregation_id: cid },
      });
    }
    setSubmitting(false);
    setToast(`Submitted ${rows.length} approved week(s) to HO.`);
    setReloadKey((k) => k + 1);
  }

  const statusBadge = (status: string) => {
    const cls =
      status === "OverseerApproved" ? "bg-green-50 text-green-700 border-green-300"
        : status === "OverseerRejected" || status === "Rejected" ? "bg-red-50 text-red-700 border-red-300"
        : status === "SubmittedToOverseer" ? "bg-blue-50 text-blue-700 border-blue-300"
        : AT_HO.includes(status) ? "bg-purple-50 text-purple-700 border-purple-300"
        : "bg-muted text-muted-foreground";
    return <Badge variant="outline" className={`text-[9px] ${cls}`}>{status}</Badge>;
  };

  return (
    <main className="mx-auto max-w-5xl p-4 py-4 space-y-4">
      {toast && (
        <div className="fixed top-16 left-1/2 -translate-x-1/2 z-50 bg-primary text-primary-foreground px-4 py-2 rounded-md text-xs shadow-lg">
          {toast}
        </div>
      )}

      <div className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight">Overseer Review</h1>
        <p className="text-sm text-muted-foreground">
          Role: <span className="font-medium">{role}</span>
          {email ? <> · {email}</> : null}
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor="ov-month" className="text-xs text-muted-foreground">Month</label>
          <input id="ov-month" type="month" className="flex h-9 w-40 rounded-md border border-input bg-background px-2 py-1 text-sm" value={selectedMonth} max={currentMonthValue()} onChange={(e) => handleMonthChange(e.target.value)} />
        </div>
      </div>

      {congregations.length === 0 ? (
        <Card>
          <CardContent className="py-6">
            <p className="text-sm text-muted-foreground">
              No congregations resolve under your Overseership.
              {role !== "Overseer" ? " Consolidated Apostle/HO drill-down is a later slice." : ""}
            </p>
          </CardContent>
        </Card>
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
              <Card>
                <CardHeader className="pb-2"><CardTitle className="text-sm">Governance Rollup</CardTitle></CardHeader>
                <CardContent className="space-y-2">
                  {groups.map((g) => {
                    const gKey = `eld-${g.eldershipId}`;
                    const gExp = expanded.has(gKey);
                    return (
                      <div key={g.eldershipId} className="rounded border">
                        <button className="w-full flex items-center justify-between px-3 py-2 text-left hover:bg-muted/40" onClick={() => toggleExpand(gKey)}>
                          <span className="text-xs font-bold">{gExp ? "−" : "+"} {g.eldershipName}</span>
                          <span className="text-[10px] text-muted-foreground">{g.congregations.length} congregation(s)</span>
                        </button>

                        {gExp && g.congregations.map((c) => {
                          const cKey = `cong-${c.id}`;
                          const cExp = expanded.has(cKey);
                          const b = bucketsFor(c.id);
                          return (
                            <div key={c.id} className="border-t">
                              <button className="w-full flex items-center justify-between px-3 py-2 pl-6 text-left hover:bg-muted/30" onClick={() => toggleExpand(cKey)}>
                                <span className="text-xs font-medium">{cExp ? "−" : "+"} {c.name} ({c.code})</span>
                                <span className="flex flex-wrap gap-1 text-[9px]">
                                  <BucketPill label="In Progress" n={b.inProgress} tone="orange" />
                                  <BucketPill label="Awaiting Audit" n={b.awaitingAudit} tone="amber" />
                                  <BucketPill label="Audit Approved" n={b.auditApproved} tone="green" />
                                  <BucketPill label="To Overseer" n={b.submittedToOverseer} tone="blue" />
                                  <BucketPill label="Overseer Approved" n={b.overseerApproved} tone="green" />
                                  <BucketPill label="Overseer Rejected" n={b.overseerRejected} tone="red" />
                                  <BucketPill label="To HO" n={b.submittedToHO} tone="purple" />
                                </span>
                              </button>

                              {cExp && (
                                <div className="px-3 pb-2 pl-10">
                                  {Array.from({ length: totalWeeks }, (_, i) => i + 1).map((wk) => {
                                    const wkPeriods = periods.filter((p) => p.congregation_id === c.id && p.week === wk);
                                    if (wkPeriods.length === 0) {
                                      return (
                                        <div key={`${c.id}-w${wk}`} className="flex items-center justify-between py-1 text-[11px] text-muted-foreground border-b last:border-0">
                                          <span>Week {wk}</span>
                                          <Badge variant="outline" className="text-[8px]">Not captured</Badge>
                                        </div>
                                      );
                                    }
                                    return wkPeriods.map((p) => (
                                      <div key={p.id} className="flex items-center justify-between gap-2 py-1 text-[11px] border-b last:border-0">
                                        <button className="font-medium underline-offset-2 hover:underline" onClick={() => navigate(`/audit/${p.id}`)}>
                                          Week {p.week} — {p.service}
                                        </button>
                                        <span className="flex items-center gap-2">
                                          {statusBadge(p.status)}
                                          {p.status === "SubmittedToOverseer" && (
                                            <>
                                              {canApprove && (
                                                <Button size="sm" variant="outline" className="h-6 text-[10px] border-green-400 text-green-700" disabled={processing === p.id} onClick={() => void decide(p.id, "approve")}>
                                                  {processing === p.id ? "…" : "Approve"}
                                                </Button>
                                              )}
                                              {canReject && (
                                                <Button size="sm" variant="outline" className="h-6 text-[10px] border-red-400 text-red-700" disabled={processing === p.id} onClick={() => void decide(p.id, "reject")}>
                                                  Reject
                                                </Button>
                                              )}
                                            </>
                                          )}
                                        </span>
                                      </div>
                                    ));
                                  })}
                                </div>
                              )}
                            </div>
                          );
                        })}
                      </div>
                    );
                  })}
                </CardContent>
              </Card>

              <Card>
                <CardContent className="py-4 space-y-3">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-bold">Submission Summary</h3>
                    <span className="text-sm">Overseership Total: <b>{money(overseershipTotal)}</b></span>
                  </div>
                  <p className="text-[10px] text-muted-foreground">
                    {congregations.length} congregation(s) · {officers.length} active officer(s) across the Overseership.
                  </p>
                  <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 text-center text-[11px]">
                    <div className="rounded border p-2"><p className="font-bold">{money(overseershipSec.Members)}</p><p className="text-muted-foreground">Members</p></div>
                    <div className="rounded border p-2"><p className="font-bold">{money(overseershipSec.Officers)}</p><p className="text-muted-foreground">Officers</p></div>
                    <div className="rounded border p-2"><p className="font-bold">{money(overseershipSec.Burial)}</p><p className="text-muted-foreground">Burial</p></div>
                    <div className="rounded border p-2"><p className="font-bold">{money(overseershipSec.Expenses)}</p><p className="text-muted-foreground">Expenses</p></div>
                  </div>

                  <div className="pt-2 text-center space-y-1">
                    <Button onClick={() => void handleSubmitToHO()} disabled={submitting || !submitReady || !canSubmitHO} className="px-6">
                      {submitting ? "Submitting…" : "Submit All Overseer-Approved to HO"}
                    </Button>
                    <p className="text-[10px] text-muted-foreground">
                      Advances every Overseer-approved week to <span className="font-medium">SubmittedToHO</span> across all {congregations.length} congregation(s).
                      {!submitReady && " Enabled once every congregation has approved weeks and none remain in progress, awaiting audit, awaiting overseer, or overseer-rejected."}
                    </p>
                  </div>
                </CardContent>
              </Card>
            </div>
          )}

          {/* ── TITHING REVIEW ── */}
          {activeTab === "priest" && (
            <div className="space-y-4">
              {groups.map((g) => {
                const gCash = g.congregations.reduce((s, c) => s + congCashDep(c.id).cash, 0);
                const gDep = g.congregations.reduce((s, c) => s + congCashDep(c.id).dep, 0);
                return (
                  <Card key={g.eldershipId}>
                    <CardHeader className="pb-2">
                      <div className="flex items-center justify-between">
                        <CardTitle className="text-sm">{g.eldershipName}</CardTitle>
                        <span className="text-[11px] text-muted-foreground">Cash {money(gCash)} · Dep/EFT {money(gDep)} · Total <b>{money(gCash + gDep)}</b></span>
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-2">
                      {g.congregations.map((c) => {
                        const cd = congCashDep(c.id);
                        const key = `tp-${c.id}`;
                        const exp = expanded.has(key);
                        const priests = priestsForCong(c.id);
                        return (
                          <div key={c.id} className="rounded border">
                            <button className="w-full flex items-center justify-between px-3 py-2 text-left hover:bg-muted/30" onClick={() => toggleExpand(key)}>
                              <span className="text-xs font-medium">{exp ? "−" : "+"} {c.name} ({c.code})</span>
                              <span className="text-[10px]">
                                Cash {money(cd.cash)} · Dep {money(cd.dep)} · <b>{money(cd.total)}</b>
                                <span className="ml-2 text-muted-foreground">{ovTithingTotal > 0 ? Math.round((cd.total / ovTithingTotal) * 100) : 0}% of Overseership</span>
                              </span>
                            </button>
                            {exp && (
                              <div className="overflow-x-auto">
                                <table className="w-full text-[11px] border-collapse">
                                  <thead>
                                    <tr className="bg-muted text-left">
                                      <th className="px-2 py-1">Priest</th>
                                      <th className="px-2 py-1 text-right">Members Cash</th><th className="px-2 py-1 text-right">Members Dep/EFT</th><th className="px-2 py-1 text-right">Priestship</th>
                                      <th className="px-2 py-1 text-right">Officers Cash</th><th className="px-2 py-1 text-right">Officers Dep/EFT</th><th className="px-2 py-1 text-right">Officer Total</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {priests.length === 0 ? (
                                      <tr><td colSpan={7} className="px-2 py-2 text-center text-muted-foreground">No active officers.</td></tr>
                                    ) : priests.map((p) => (
                                      <tr key={p.officerCode} className="border-b last:border-0" style={p.priestTotal + p.officerTotal === 0 ? { backgroundColor: "#fef9c3" } : undefined}>
                                        <td className="px-2 py-1 font-medium">{p.officerCode}</td>
                                        <td className="px-2 py-1 text-right">{money(p.membersCash)}</td>
                                        <td className="px-2 py-1 text-right">{money(p.membersDeposit)}</td>
                                        <td className="px-2 py-1 text-right font-bold">{money(p.priestTotal)}</td>
                                        <td className="px-2 py-1 text-right">{money(p.officersCash)}</td>
                                        <td className="px-2 py-1 text-right">{money(p.officersDeposit)}</td>
                                        <td className="px-2 py-1 text-right font-bold">{p.officerTotal > 0 ? money(p.officerTotal) : "R -"}</td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </CardContent>
                  </Card>
                );
              })}

              <Card>
                <CardContent className="py-3">
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                    <div>
                      <p className="text-xs font-bold mb-2">Cash Risk (top 3 priestships across Overseership)</p>
                      {cashRisk.length === 0 ? (
                        <p className="text-[10px] text-muted-foreground">No cash contributions this month.</p>
                      ) : (
                        <div className="flex gap-2">
                          {cashRisk.map((r, i) => (
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
                      <div className="flex justify-between"><span>Total Cash</span><b>{money(ovTotalCash)}</b></div>
                      <div className="flex justify-between"><span>Total EFT/Debit</span><b>{money(ovTotalDeposit)}</b></div>
                      <div className="flex justify-between border-t pt-1"><span>Overseership Tithing Total</span><b>{money(ovTithingTotal)}</b></div>
                      <div className="flex gap-2 mt-1">
                        <span className="text-[10px] bg-orange-100 px-1 rounded">{ovTithingTotal > 0 ? Math.round((ovTotalCash / ovTithingTotal) * 100) : 0}% cash</span>
                        <span className="text-[10px] bg-blue-100 px-1 rounded">{ovTithingTotal > 0 ? Math.round((ovTotalDeposit / ovTithingTotal) * 100) : 0}% EFT</span>
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
                  {auditRows.length === 0 ? (
                    <tr><td colSpan={6} className="px-3 py-4 text-center text-muted-foreground">No audit events for this period.</td></tr>
                  ) : (
                    auditRows.map((r, i) => (
                      <tr key={i} className="border-b">
                        <td className="px-3 py-2">{r.date}</td>
                        <td className="px-3 py-2">{r.congregation}</td>
                        <td className="px-2 py-2">{r.week}</td>
                        <td className="px-2 py-2">
                          <Badge variant="outline" className={`text-[9px] ${r.action.includes("Approved") ? "bg-green-50 text-green-700 border-green-300" : r.action.includes("Rejected") ? "bg-red-50 text-red-700 border-red-300" : r.action === "Override" ? "bg-amber-50 text-amber-700 border-amber-300" : ""}`}>{r.action}</Badge>
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

function BucketPill({ label, n, tone }: { label: string; n: number; tone: "orange" | "amber" | "green" | "blue" | "red" | "purple" }) {
  if (n === 0) return null;
  const cls =
    tone === "orange" ? "bg-orange-100 text-orange-800"
      : tone === "amber" ? "bg-amber-100 text-amber-800"
      : tone === "green" ? "bg-green-100 text-green-800"
      : tone === "blue" ? "bg-blue-100 text-blue-800"
      : tone === "red" ? "bg-red-100 text-red-800"
      : "bg-purple-100 text-purple-800";
  return <span className={`px-1.5 py-0.5 rounded ${cls}`}>{label}: {n}</span>;
}
