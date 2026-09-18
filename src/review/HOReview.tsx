// ─────────────────────────────────────────────────────────────────────────────
// HO / APOSTLE REVIEW (online-only). Top-level DISTRICT-SEGREGATED rollup, drilled
// HO → Overseership → Eldership → Congregation → Week → Service. Reads live from
// Supabase under RLS. No Dexie.
//
// Scope (Task 34): HO = congregations whose denormalized district_id ∈ the HO's
// ho_district_assignments (invariant #3; zero assignments → no data). Apostle =
// congregations under the Apostleship. No SuperAdmin role exists.
//
// Final write (Task 36, approve-only): SubmittedToHO → HOReviewed, gated on ho.review,
// optimistic lock (.eq status SubmittedToHO), logs HO_REVIEW (optional review comment
// captured in the audit_log entry — no schema dependency). HOReviewed is terminal;
// there is NO reject branch. Individual approve + batch "Approve All".
//
// Page gate: ho.view. Canonical route /ho.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { createClient } from "@/lib/supabase/client";
import { getUserAccess, hasPermission, getHODistrictIds, logAuditAction } from "@/lib/permissions";
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

interface HoCong { id: string; name: string; code: string; eldership_id: string | null; overseership_id: string | null; }
interface HoPeriod { id: string; congregation_id: string; week: number; service: string; status: string; created_at: string; }
interface HoLineItem { id: string; period_id: string; section: string; is_officer: boolean; item_type: string; amount: number; officer_id: string | null; proof_status: string | null; }
interface HoOfficer { id: string; officer_code: string; congregation_id: string; }
interface EldershipGroup { eldershipId: string; eldershipName: string; congregations: HoCong[]; }
interface OverseershipGroup { overseershipId: string; overseershipName: string; elderships: EldershipGroup[]; }
interface CongBuckets {
  inProgress: number; awaitingAudit: number; auditApproved: number;
  submittedToOverseer: number; overseerApproved: number; overseerRejected: number;
  submittedToHO: number; hoReviewed: number;
}
interface AuditRow { date: string; congregation: string; week: string; action: string; comment: string; by: string; }
type TabKey = "governance" | "risk";

const money = (n: number) => `R${n.toFixed(2)}`;
const currentMonthValue = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
};
const toCaptureItems = (rows: HoLineItem[]): CaptureItem[] =>
  rows.map((r) => ({ section: r.section as LineSection, item_type: r.item_type as ItemType, amount: Number(r.amount), proof_status: r.proof_status, item_count: null }));
const fmtDate = (iso: string) => new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
const mapAction = (t: string) =>
  t === "AUDIT_APPROVE" ? "Audit Approved" : t === "AUDIT_REJECT" ? "Audit Rejected" : t === "SUBMIT" ? "Submitted for Audit" : t === "MONTH_SUBMIT" ? "Submitted to Overseer" : t === "OVERSEER_APPROVE" ? "Overseer Approved" : t === "OVERSEER_REJECT" ? "Overseer Rejected" : t === "MONTH_SUBMIT_TO_HO" ? "Submitted to HO" : t === "HO_REVIEW" ? "HO Reviewed" : t === "SELF_REVIEW_EXCEPTION" ? "Override" : t;
const statusAction = (s: string) =>
  s === "AuditApproved" ? "Audit Approved" : s === "Submitted" ? "Submitted for Audit" : s === "SubmittedToOverseer" ? "Submitted to Overseer" : s === "OverseerApproved" ? "Overseer Approved" : s === "OverseerRejected" ? "Overseer Rejected" : s === "SubmittedToHO" ? "Submitted to HO" : s === "HOReviewed" ? "HO Reviewed" : s === "Rejected" ? "Rejected" : s;
const TABS: { key: TabKey; label: string }[] = [
  { key: "governance", label: "Governance" },
  { key: "risk", label: "Risk & Audit" },
];

export function HOReview() {
  const supabase = createClient();
  const navigate = useNavigate();
  const online = useOnlineStatus();

  const [access, setAccess] = useState<UserHierarchyAccess | null>(null);
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<string | null>(null);
  const [processing, setProcessing] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [congregations, setCongregations] = useState<HoCong[]>([]);
  const [tree, setTree] = useState<OverseershipGroup[]>([]);
  const [selectedMonth, setSelectedMonth] = useState<string>(currentMonthValue);

  const [periods, setPeriods] = useState<HoPeriod[]>([]);
  const [items, setItems] = useState<HoLineItem[]>([]);
  const [officers, setOfficers] = useState<HoOfficer[]>([]);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [reloadKey, setReloadKey] = useState(0);
  const [activeTab, setActiveTab] = useState<TabKey>("governance");
  const [auditRows, setAuditRows] = useState<AuditRow[]>([]);

  const role = access?.role as Role | undefined;
  const canReview = role ? hasPermission(role, "ho.review") : false;

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

  // ── Scope resolver + month-scope controller ────────────────────────────────
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

      // District-segregated (HO) or apostleship (Apostle) congregation scope.
      let congs: HoCong[] = [];
      if (ua.role === "HO") {
        const districtIds = await getHODistrictIds(ua.user_id);
        if (!active) return;
        if (districtIds.length > 0) {
          const { data } = await supabase
            .from("congregations")
            .select("id, name, code, eldership_id, overseership_id")
            .in("district_id", districtIds)
            .order("name");
          congs = (data ?? []) as HoCong[];
        }
      } else if (ua.role === "Apostle") {
        const { data } = await supabase
          .from("congregations")
          .select("id, name, code, eldership_id, overseership_id")
          .eq("apostleship_id", ua.hierarchy_id)
          .order("name");
        congs = (data ?? []) as HoCong[];
      }
      if (!active) return;
      setCongregations(congs);

      // Resolve hierarchy names (overseerships + elderships) for grouping.
      const oversIds = [...new Set(congs.map((c) => c.overseership_id).filter((x): x is string => !!x))];
      const eldIds = [...new Set(congs.map((c) => c.eldership_id).filter((x): x is string => !!x))];
      const names: Record<string, string> = {};
      const nameIds = [...new Set([...oversIds, ...eldIds])];
      if (nameIds.length > 0) {
        const { data: levels } = await supabase.from("hierarchy_levels").select("id, name").in("id", nameIds);
        (levels ?? []).forEach((l) => { names[l.id as string] = l.name as string; });
      }

      // Build Overseership → Eldership → Congregation tree.
      const oversMap = new Map<string, OverseershipGroup>();
      for (const c of congs) {
        const oKey = c.overseership_id ?? "unassigned-o";
        if (!oversMap.has(oKey)) oversMap.set(oKey, { overseershipId: oKey, overseershipName: names[oKey] ?? (c.overseership_id ? "Overseership" : "Unassigned"), elderships: [] });
        const og = oversMap.get(oKey)!;
        const eKey = c.eldership_id ?? "unassigned-e";
        let eg = og.elderships.find((e) => e.eldershipId === eKey);
        if (!eg) { eg = { eldershipId: eKey, eldershipName: names[eKey] ?? (c.eldership_id ? "Eldership" : "Unassigned"), congregations: [] }; og.elderships.push(eg); }
        eg.congregations.push(c);
      }
      if (!active) return;
      setTree([...oversMap.values()]);

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
      const monthPeriods = (periodRows ?? []) as HoPeriod[];
      setPeriods(monthPeriods);

      const periodIds = monthPeriods.map((p) => p.id);
      if (periodIds.length > 0) {
        const { data: itemRows } = await supabase
          .from("cashbook_line_item")
          .select("id, period_id, section, is_officer, item_type, amount, officer_id, proof_status")
          .in("period_id", periodIds);
        if (!active) return;
        setItems((itemRows ?? []) as HoLineItem[]);
      } else {
        setItems([]);
      }

      const { data: officerRows } = await supabase
        .from("officers")
        .select("id, officer_code, congregation_id")
        .in("congregation_id", ids)
        .eq("is_active", true);
      if (!active) return;
      setOfficers((officerRows ?? []) as HoOfficer[]);

      // Risk & Audit: period-level + monthly_close events across scope, limit 100.
      const monthlyKeys = ids.map((cid) => `${cid}_${year}_${month}`);
      const auditEntityIds = [...periodIds, ...monthlyKeys];
      let auditData: AuditRow[] = [];
      if (auditEntityIds.length > 0) {
        const { data: logs } = await supabase
          .from("audit_log")
          .select("user_id, action_type, entity_id, comment, created_at")
          .in("entity_id", auditEntityIds)
          .order("created_at", { ascending: false })
          .limit(100);
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
  if (!role || !hasPermission(role, "ho.view")) {
    return <p className="p-6 text-sm text-destructive">Access denied. Head Office role required.</p>;
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
      submittedToHO: cp.filter((p) => p.status === "SubmittedToHO").length,
      hoReviewed: cp.filter((p) => p.status === "HOReviewed").length,
    };
  };

  // Batch gate: everything has reached SubmittedToHO or HOReviewed, with ≥1 awaiting review.
  const submitReady =
    congregations.length > 0 &&
    congregations.some((c) => bucketsFor(c.id).submittedToHO > 0) &&
    congregations.every((c) => {
      const b = bucketsFor(c.id);
      return b.inProgress === 0 && b.awaitingAudit === 0 && b.auditApproved === 0 && b.submittedToOverseer === 0 && b.overseerApproved === 0 && b.overseerRejected === 0;
    });

  const sec = sectionTotals(toCaptureItems(items));
  const hoGrandTotal = sec.Members + sec.Officers + sec.Burial - sec.Expenses;

  // ── HO approve (individual, optimistic lock) ───────────────────────────────
  async function approve(periodId: string) {
    if (!access || !canReview) return;
    const input = window.prompt("Optional HO review comment (leave blank to approve without a comment; Cancel to abort):");
    if (input === null) return; // cancelled
    const comment = input.trim();

    setProcessing(periodId);
    const { data, error } = await supabase
      .from("cashbook_period")
      .update({ status: "HOReviewed" }) // terminal — never any earlier status.
      .eq("id", periodId)
      .eq("status", "SubmittedToHO")
      .select("id");

    if (error) { setToast(error.message); setProcessing(null); return; }
    if (!data || data.length === 0) {
      setToast("This period was already reviewed elsewhere. Reloading…");
      setProcessing(null);
      setReloadKey((k) => k + 1);
      return;
    }
    await logAuditAction({
      userId: access.user_id,
      actionType: "HO_REVIEW",
      entityType: "cashbook_period",
      entityId: periodId,
      comment: comment || "HO reviewed",
    });
    setProcessing(null);
    setToast("Period reviewed.");
    setReloadKey((k) => k + 1);
  }

  // ── HO batch approve (idempotent) ──────────────────────────────────────────
  async function approveAll() {
    if (!access || submitting || !submitReady || !canReview) return;
    setSubmitting(true);
    const [y, m] = selectedMonth.split("-").map(Number);
    const congIds = congregations.map((c) => c.id);

    const { data, error } = await supabase
      .from("cashbook_period")
      .update({ status: "HOReviewed" })
      .in("congregation_id", congIds)
      .eq("year", y)
      .eq("month", m)
      .eq("status", "SubmittedToHO")
      .select("id, congregation_id");

    if (error) { setToast(error.message); setSubmitting(false); return; }
    const rows = (data ?? []) as { id: string; congregation_id: string }[];
    const reviewedCongs = [...new Set(rows.map((r) => r.congregation_id))];
    for (const cid of reviewedCongs) {
      await logAuditAction({
        userId: access.user_id,
        actionType: "HO_REVIEW",
        entityType: "monthly_close",
        entityId: `${cid}_${y}_${m}`,
        comment: `Month ${y}/${String(m).padStart(2, "0")} reviewed by HO`,
        metadata: { year: y, month: m, congregation_id: cid },
      });
    }
    setSubmitting(false);
    setToast(`Reviewed ${rows.length} week(s) as HOReviewed.`);
    setReloadKey((k) => k + 1);
  }

  const statusBadge = (status: string) => {
    const cls =
      status === "HOReviewed" ? "bg-purple-50 text-purple-700 border-purple-300"
        : status === "SubmittedToHO" ? "bg-indigo-50 text-indigo-700 border-indigo-300"
        : status === "OverseerApproved" ? "bg-green-50 text-green-700 border-green-300"
        : status === "OverseerRejected" || status === "Rejected" ? "bg-red-50 text-red-700 border-red-300"
        : status === "SubmittedToOverseer" ? "bg-blue-50 text-blue-700 border-blue-300"
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
        <h1 className="text-2xl font-bold tracking-tight">Head Office Review</h1>
        <p className="text-sm text-muted-foreground">
          Role: <span className="font-medium">{role}</span>
          {email ? <> · {email}</> : null}
          {role === "HO" ? <> · district-segregated scope</> : null}
        </p>
      </div>

      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor="ho-month" className="text-xs text-muted-foreground">Month</label>
          <input id="ho-month" type="month" className="flex h-9 w-40 rounded-md border border-input bg-background px-2 py-1 text-sm" value={selectedMonth} max={currentMonthValue()} onChange={(e) => handleMonthChange(e.target.value)} />
        </div>
      </div>

      {congregations.length === 0 ? (
        <Card>
          <CardContent className="py-6">
            <p className="text-sm text-muted-foreground">
              {role === "HO"
                ? "No congregations resolve within your assigned districts. An HO with no district assignments sees no data."
                : "No congregations resolve under your Apostleship."}
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

          {activeTab === "governance" && (
            <div className="space-y-4">
          {/* Governance rollup: HO → Overseership → Eldership → Congregation → Week → Service */}
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm">Governance Rollup</CardTitle></CardHeader>
            <CardContent className="space-y-2">
              {tree.map((og) => {
                const oKey = `ov-${og.overseershipId}`;
                const oExp = expanded.has(oKey);
                const oCongs = og.elderships.flatMap((e) => e.congregations);
                const oPending = oCongs.reduce((s, c) => s + bucketsFor(c.id).submittedToHO, 0);
                return (
                  <div key={og.overseershipId} className="rounded border">
                    <button className="w-full flex items-center justify-between px-3 py-2 text-left hover:bg-muted/40" onClick={() => toggleExpand(oKey)}>
                      <span className="text-xs font-bold">{oExp ? "−" : "+"} {og.overseershipName}</span>
                      <span className="text-[10px] text-muted-foreground">
                        {oCongs.length} congregation(s){oPending > 0 ? <> · <span className="text-indigo-700 font-medium">{oPending} awaiting HO</span></> : null}
                      </span>
                    </button>

                    {oExp && og.elderships.map((eg) => {
                      const eKey = `${oKey}-eld-${eg.eldershipId}`;
                      const eExp = expanded.has(eKey);
                      return (
                        <div key={eg.eldershipId} className="border-t">
                          <button className="w-full flex items-center justify-between px-3 py-2 pl-6 text-left hover:bg-muted/30" onClick={() => toggleExpand(eKey)}>
                            <span className="text-xs font-semibold">{eExp ? "−" : "+"} {eg.eldershipName}</span>
                            <span className="text-[10px] text-muted-foreground">{eg.congregations.length} congregation(s)</span>
                          </button>

                          {eExp && eg.congregations.map((c) => {
                            const cKey = `${eKey}-cong-${c.id}`;
                            const cExp = expanded.has(cKey);
                            const b = bucketsFor(c.id);
                            return (
                              <div key={c.id} className="border-t">
                                <button className="w-full flex items-center justify-between px-3 py-2 pl-10 text-left hover:bg-muted/20" onClick={() => toggleExpand(cKey)}>
                                  <span className="text-xs font-medium">{cExp ? "−" : "+"} {c.name} ({c.code})</span>
                                  <span className="flex flex-wrap gap-1 text-[9px]">
                                    <BucketPill label="In Progress" n={b.inProgress} tone="orange" />
                                    <BucketPill label="Awaiting Audit" n={b.awaitingAudit} tone="amber" />
                                    <BucketPill label="Audit Approved" n={b.auditApproved} tone="green" />
                                    <BucketPill label="To Overseer" n={b.submittedToOverseer} tone="blue" />
                                    <BucketPill label="Overseer Approved" n={b.overseerApproved} tone="green" />
                                    <BucketPill label="Overseer Rejected" n={b.overseerRejected} tone="red" />
                                    <BucketPill label="To HO" n={b.submittedToHO} tone="indigo" />
                                    <BucketPill label="HO Reviewed" n={b.hoReviewed} tone="purple" />
                                  </span>
                                </button>

                                {cExp && (
                                  <div className="px-3 pb-2 pl-14">
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
                                            {p.status === "SubmittedToHO" && canReview && (
                                              <Button size="sm" variant="outline" className="h-6 text-[10px] border-purple-400 text-purple-700" disabled={processing === p.id} onClick={() => void approve(p.id)}>
                                                {processing === p.id ? "…" : "Review"}
                                              </Button>
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
                  </div>
                );
              })}
            </CardContent>
          </Card>

          {/* Submission Summary + batch review */}
          <Card>
            <CardContent className="py-4 space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-bold">Submission Summary</h3>
                <span className="text-sm">HO Grand Total: <b>{money(hoGrandTotal)}</b></span>
              </div>
              <p className="text-[10px] text-muted-foreground">
                {tree.length} overseership(s) · {congregations.length} congregation(s) · {officers.length} active officer(s) in scope.
              </p>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 text-center text-[11px]">
                <div className="rounded border p-2"><p className="font-bold">{money(sec.Members)}</p><p className="text-muted-foreground">Members</p></div>
                <div className="rounded border p-2"><p className="font-bold">{money(sec.Officers)}</p><p className="text-muted-foreground">Officers</p></div>
                <div className="rounded border p-2"><p className="font-bold">{money(sec.Burial)}</p><p className="text-muted-foreground">Burial</p></div>
                <div className="rounded border p-2"><p className="font-bold">{money(sec.Expenses)}</p><p className="text-muted-foreground">Expenses</p></div>
              </div>

              <div className="pt-2 text-center space-y-1">
                <Button onClick={() => void approveAll()} disabled={submitting || !submitReady || !canReview} className="px-6">
                  {submitting ? "Reviewing…" : "Approve All Submitted to HO"}
                </Button>
                <p className="text-[10px] text-muted-foreground">
                  Advances every <span className="font-medium">SubmittedToHO</span> week to <span className="font-medium">HOReviewed</span> (terminal) across all {congregations.length} congregation(s).
                  {!submitReady && " Enabled once ≥1 week is awaiting HO and nothing remains earlier in the chain."}
                </p>
              </div>
            </CardContent>
          </Card>
            </div>
          )}

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
                          <Badge variant="outline" className={`text-[9px] ${r.action.includes("Approved") || r.action === "HO Reviewed" ? "bg-green-50 text-green-700 border-green-300" : r.action.includes("Rejected") ? "bg-red-50 text-red-700 border-red-300" : r.action === "Override" ? "bg-amber-50 text-amber-700 border-amber-300" : ""}`}>{r.action}</Badge>
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

function BucketPill({ label, n, tone }: { label: string; n: number; tone: "orange" | "amber" | "green" | "blue" | "red" | "indigo" | "purple" }) {
  if (n === 0) return null;
  const cls =
    tone === "orange" ? "bg-orange-100 text-orange-800"
      : tone === "amber" ? "bg-amber-100 text-amber-800"
      : tone === "green" ? "bg-green-100 text-green-800"
      : tone === "blue" ? "bg-blue-100 text-blue-800"
      : tone === "red" ? "bg-red-100 text-red-800"
      : tone === "indigo" ? "bg-indigo-100 text-indigo-800"
      : "bg-purple-100 text-purple-800";
  return <span className={`px-1.5 py-0.5 rounded ${cls}`}>{label}: {n}</span>;
}
