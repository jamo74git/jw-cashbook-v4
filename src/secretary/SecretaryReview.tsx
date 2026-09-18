// ─────────────────────────────────────────────────────────────────────────────
// SECRETARY REVIEW (online-only, read-only). Congregational monthly finance-meeting
// agenda: the latest CLOSED month (Overseer has submitted → status SubmittedToHO or
// HOReviewed) plus the prior month for comparison. Consolidated totals only — NO
// transactional line items, NO tithing-type breakdown. Reads live from Supabase under
// RLS. No Dexie.
//
// "Closed month" = the congregation's month has been submitted up to HO by the Overseer
// (SubmittedToHO); Secretary can read it immediately, without waiting for HO to process
// (HOReviewed). Query: status IN ('SubmittedToHO','HOReviewed'). Dev fallback to
// OverseerApproved when nothing is closed yet.
//
// Scope: Secretary → own congregation (access.congregation_id). HO/Apostle → a
// congregation selector. Page gate: secretary.view (Secretary/HO/Apostle = "V").
// Route /secretary.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { getUserAccess, hasPermission } from "@/lib/permissions";
import { useOnlineStatus } from "@/lib/useOnlineStatus";
import { sectionTotals, type CaptureItem, type ItemType } from "@/lib/captureTotals";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { LineSection, Role, UserHierarchyAccess } from "@/lib/types";

const OFFLINE_MSG = "Offline Unavailable — Please connect to a stable network to view congregational finance.";
const CLOSED_STATUSES = ["SubmittedToHO", "HOReviewed"];

interface CongOption { id: string; name: string; code: string; }
interface SecPeriod { id: string; congregation_id: string; year: number; month: number; week: number; service: string; status: string; }
interface SecLineItem { id: string; period_id: string; section: string; item_type: string; amount: number; }
interface MonthTotals { members: number; officers: number; burial: number; expenses: number; grand: number; }

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const money = (n: number) => `R${n.toFixed(2)}`;
const monthLabel = (y: number, m: number) => `${MONTHS[m - 1]} ${y}`;
const toCaptureItems = (rows: SecLineItem[]): CaptureItem[] =>
  rows.map((r) => ({ section: r.section as LineSection, item_type: r.item_type as ItemType, amount: Number(r.amount), proof_status: null, item_count: null }));

function totalsOf(rows: SecLineItem[]): MonthTotals {
  const s = sectionTotals(toCaptureItems(rows));
  return { members: s.Members, officers: s.Officers, burial: s.Burial, expenses: s.Expenses, grand: s.Members + s.Officers + s.Burial - s.Expenses };
}

export function SecretaryReview() {
  const supabase = createClient();
  const online = useOnlineStatus();

  const [access, setAccess] = useState<UserHierarchyAccess | null>(null);
  const [loading, setLoading] = useState(true);
  const [congregations, setCongregations] = useState<CongOption[]>([]); // HO/Apostle selector
  const [congId, setCongId] = useState<string>("");
  const [congName, setCongName] = useState("");

  const [periods, setPeriods] = useState<SecPeriod[]>([]);
  const [items, setItems] = useState<SecLineItem[]>([]);
  const [usingFallback, setUsingFallback] = useState(false);

  const role = access?.role as Role | undefined;
  const isSelector = role === "HO" || role === "Apostle";

  // Resolve access + (HO/Apostle) congregation list; (Secretary) own congregation.
  useEffect(() => {
    let active = true;
    (async () => {
      const ua = await getUserAccess();
      if (!active) return;
      setAccess(ua);
      if (!ua) { setLoading(false); return; }

      if (ua.role === "HO" || ua.role === "Apostle") {
        const { data } = await supabase.from("congregations").select("id, name, code").order("name");
        if (!active) return;
        setCongregations((data ?? []) as CongOption[]);
        setLoading(false); // wait for a selection
      } else {
        if (ua.congregation_id) {
          setCongId(ua.congregation_id);
          const { data } = await supabase.from("congregations").select("name, code").eq("id", ua.congregation_id).maybeSingle();
          if (!active) return;
          if (data) setCongName(`${data.name} (${data.code})`);
        } else {
          setLoading(false);
        }
      }
    })();
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load the last two closed months for the resolved congregation.
  useEffect(() => {
    if (!congId) return;
    let active = true;
    (async () => {
      setLoading(true);
      setUsingFallback(false);

      const cols = "id, congregation_id, year, month, week, service, status";
      let { data: periodRows } = await supabase
        .from("cashbook_period")
        .select(cols)
        .eq("congregation_id", congId)
        .in("status", CLOSED_STATUSES)
        .order("year", { ascending: false })
        .order("month", { ascending: false });

      if (!periodRows || periodRows.length === 0) {
        // Dev fallback: nothing closed yet — show the latest Overseer-approved month.
        const fb = await supabase
          .from("cashbook_period")
          .select(cols)
          .eq("congregation_id", congId)
          .eq("status", "OverseerApproved")
          .order("year", { ascending: false })
          .order("month", { ascending: false });
        if (fb.data && fb.data.length > 0) {
          periodRows = fb.data;
          if (active) setUsingFallback(true);
        }
      }
      if (!active) return;

      const all = (periodRows ?? []) as SecPeriod[];
      // Latest two distinct (year, month) buckets.
      const monthKeys = [...new Set(all.map((p) => `${p.year}-${p.month}`))].slice(0, 2);
      const scoped = all.filter((p) => monthKeys.includes(`${p.year}-${p.month}`));
      setPeriods(scoped);

      const periodIds = scoped.map((p) => p.id);
      if (periodIds.length > 0) {
        const { data: itemRows } = await supabase
          .from("cashbook_line_item")
          .select("id, period_id, section, item_type, amount")
          .in("period_id", periodIds);
        if (!active) return;
        setItems((itemRows ?? []) as SecLineItem[]);
      } else {
        setItems([]);
      }
      setLoading(false);
    })();
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [congId]);

  if (!online) return <p className="p-6 text-sm text-amber-700">{OFFLINE_MSG}</p>;
  if (loading) return <p className="p-6 text-sm text-muted-foreground">Loading…</p>;
  if (!role || !hasPermission(role, "secretary.view")) {
    return <p className="p-6 text-sm text-destructive">Access denied. Secretary role required.</p>;
  }

  // Derive the two months present (desc).
  const months = [...new Set(periods.map((p) => `${p.year}-${p.month}`))]
    .map((k) => { const [y, m] = k.split("-").map(Number); return { y, m }; })
    .sort((a, b) => (b.y - a.y) || (b.m - a.m));
  const current = months[0];
  const prior = months[1];

  const periodsOf = (y: number, m: number) => periods.filter((p) => p.year === y && p.month === m);
  const itemsOf = (y: number, m: number) => {
    const ids = new Set(periodsOf(y, m).map((p) => p.id));
    return items.filter((i) => ids.has(i.period_id));
  };
  const statusOf = (y: number, m: number) => {
    const ps = periodsOf(y, m);
    return ps.some((p) => p.status === "HOReviewed") ? "HOReviewed" : ps.some((p) => p.status === "SubmittedToHO") ? "SubmittedToHO" : ps[0]?.status ?? "";
  };

  const curTotals = current ? totalsOf(itemsOf(current.y, current.m)) : null;
  const priorTotals = prior ? totalsOf(itemsOf(prior.y, prior.m)) : null;

  // Weekly breakdown for the meeting (current) month — combined AM+PM net totals only.
  const weeklyRows = current
    ? [...new Set(periodsOf(current.y, current.m).map((p) => p.week))].sort((a, b) => a - b).map((wk) => {
        const wkPeriods = periodsOf(current.y, current.m).filter((p) => p.week === wk);
        const wkIds = new Set(wkPeriods.map((p) => p.id));
        const wkTotal = totalsOf(items.filter((i) => wkIds.has(i.period_id))).grand;
        return { week: wk, services: wkPeriods.length, total: wkTotal };
      })
    : [];

  const statusBadge = (s: string) =>
    s === "HOReviewed" ? <Badge variant="outline" className="text-[9px] bg-purple-50 text-purple-700 border-purple-300">HO Reviewed</Badge>
      : s === "SubmittedToHO" ? <Badge variant="outline" className="text-[9px] bg-indigo-50 text-indigo-700 border-indigo-300">Submitted to HO</Badge>
      : <Badge variant="outline" className="text-[9px]">{s}</Badge>;

  return (
    <main className="mx-auto max-w-3xl p-6 space-y-4">
      <div className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight">Secretary — Congregational Finance</h1>
        <p className="text-sm text-muted-foreground">Monthly finance meeting agenda · consolidated totals (read-only).</p>
      </div>

      {isSelector && (
        <div>
          <label htmlFor="sec-cong" className="text-xs text-muted-foreground">Congregation</label>
          <select
            id="sec-cong"
            className="flex h-9 min-w-64 rounded-md border border-input bg-background px-2 py-1 text-sm"
            value={congId}
            onChange={(e) => {
              const id = e.target.value;
              setCongId(id);
              const c = congregations.find((x) => x.id === id);
              setCongName(c ? `${c.name} (${c.code})` : "");
            }}
          >
            <option value="">Select congregation to view Secretary finance…</option>
            {congregations.map((c) => <option key={c.id} value={c.id}>{c.name} ({c.code})</option>)}
          </select>
        </div>
      )}

      {!congId ? (
        <Card><CardContent className="py-6"><p className="text-sm text-muted-foreground">{isSelector ? "Select a congregation above to view its Secretary finance." : "No congregation is assigned to you."}</p></CardContent></Card>
      ) : !current ? (
        <Card><CardContent className="py-6"><p className="text-sm text-muted-foreground">No closed months yet for {congName || "this congregation"}. A month appears here once the Overseer submits it to HO.</p></CardContent></Card>
      ) : (
        <>
          {usingFallback && (
            <div className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-[11px] text-amber-800">
              Dev fallback: no month is closed (SubmittedToHO/HOReviewed) yet — showing the latest Overseer-approved month.
            </div>
          )}

          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">{congName}</CardTitle></CardHeader>
            <CardContent className="flex flex-wrap items-center gap-3 text-sm">
              <span className="flex items-center gap-2">
                <span className="font-medium">Month for Meeting: {monthLabel(current.y, current.m)}</span>
                {statusBadge(statusOf(current.y, current.m))}
              </span>
              {prior && (
                <span className="flex items-center gap-2 text-muted-foreground">
                  · Prior: {monthLabel(prior.y, prior.m)} {statusBadge(statusOf(prior.y, prior.m))}
                </span>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm">Month-over-Month</CardTitle></CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
                <CompareCard label="Members" cur={curTotals!.members} prior={priorTotals?.members} />
                <CompareCard label="Officers" cur={curTotals!.officers} prior={priorTotals?.officers} />
                <CompareCard label="Burial" cur={curTotals!.burial} prior={priorTotals?.burial} />
                <CompareCard label="Expenses" cur={curTotals!.expenses} prior={priorTotals?.expenses} invert />
                <CompareCard label="Grand Total" cur={curTotals!.grand} prior={priorTotals?.grand} strong />
              </div>
              {!prior && <p className="mt-2 text-[10px] text-muted-foreground">No prior closed month to compare against yet.</p>}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm">Weekly Breakdown · {monthLabel(current.y, current.m)}</CardTitle></CardHeader>
            <CardContent>
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="bg-muted text-left">
                    <th className="px-3 py-2">Week</th>
                    <th className="px-3 py-2 text-center">Services</th>
                    <th className="px-3 py-2 text-right">Weekly Total</th>
                  </tr>
                </thead>
                <tbody>
                  {weeklyRows.map((r) => (
                    <tr key={r.week} className="border-b">
                      <td className="px-3 py-2">Week {r.week}</td>
                      <td className="px-3 py-2 text-center">{r.services}</td>
                      <td className="px-3 py-2 text-right font-medium">{money(r.total)}</td>
                    </tr>
                  ))}
                  <tr className="font-bold border-t bg-muted/40">
                    <td className="px-3 py-2">Monthly Total</td>
                    <td className="px-3 py-2 text-center">{periodsOf(current.y, current.m).length}</td>
                    <td className="px-3 py-2 text-right">{money(curTotals!.grand)}</td>
                  </tr>
                </tbody>
              </table>
              <p className="mt-2 text-[10px] text-muted-foreground">Banking view: weekly totals only (combined AM+PM), matching the manual cashbook. Banking Total = Monthly Total ({money(curTotals!.grand)}).</p>
            </CardContent>
          </Card>
        </>
      )}
    </main>
  );
}

function CompareCard({ label, cur, prior, strong, invert }: { label: string; cur: number; prior?: number; strong?: boolean; invert?: boolean }) {
  const hasPrior = typeof prior === "number";
  const diff = hasPrior ? cur - (prior as number) : 0;
  const pct = hasPrior && (prior as number) !== 0 ? Math.round((diff / Math.abs(prior as number)) * 100) : null;
  const up = diff > 0;
  const flat = diff === 0;
  // Expenses: an increase is "bad" (red); income metrics: an increase is "good" (green).
  const good = invert ? diff < 0 : diff > 0;
  const color = flat ? "text-muted-foreground" : good ? "text-green-700" : "text-red-700";
  const arrow = flat ? "→" : up ? "▲" : "▼";
  return (
    <div className={`rounded-md border p-2 text-center ${strong ? "border-primary/40" : ""}`}>
      <p className="text-[10px] text-muted-foreground">{label}</p>
      <p className={`font-bold ${strong ? "text-base" : "text-sm"}`}>{`R${cur.toFixed(2)}`}</p>
      {hasPrior ? (
        <p className={`text-[10px] ${color}`}>
          {arrow} {`R${Math.abs(diff).toFixed(0)}`}{pct !== null ? ` (${diff >= 0 ? "+" : "−"}${Math.abs(pct)}%)` : ""}
        </p>
      ) : (
        <p className="text-[10px] text-muted-foreground">—</p>
      )}
    </div>
  );
}
