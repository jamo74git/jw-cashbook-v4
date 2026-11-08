import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { resolveAccess } from "@/lib/routeGuard";
import { getSession } from "@/services/authService";
import {
  hasPermission,
  CENSUS_VIEW,
  CENSUS_EDIT,
  CAPTURE_R0_CONFIRM,
  MONTH_SUBMIT,
  logActingAsTreasurer,
} from "@/lib/permissions";
import * as capture from "@/db/captureRepo";
import * as dash from "@/db/dashboardRepo";
import { resolveSignOff } from "@/lib/completeCapture";
import { syncPending } from "@/utils/syncEngine";
import { useOnlineStatus } from "@/lib/useOnlineStatus";
import { getCurrentOacWeek } from "@/lib/oacWeeks";
import { periodStatusLabel } from "@/lib/statusLabels";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

import { CensusManager } from "@/components/CensusManager";
import type { Role } from "@/lib/types";
import type { MonthStatus } from "@/lib/phaseTypes";
import type { LocalPeriod } from "@/db/schema";

const money = (n: number): string => `R${n.toFixed(2)}`;

// Sync presentation: compact, user-facing sync label per recent period. Longer explanations live in
// the accessible (i) legend, not only in hover tooltips. Future-dated records are shown as "Future
// date" (never dev wording) and are retained on-device, not auto-synced.
const syncBadge = (ls: string, isFuture: boolean, lastError: string | null): { t: string; title: string; c: string } => {
  const slate = "bg-slate-100 text-slate-700 border-slate-300 dark:bg-slate-700 dark:text-slate-100";
  if (isFuture)
    return { t: "Future date", title: "The service date has not arrived yet, so it cannot be transferred. Saved on this device.", c: "bg-blue-100 text-blue-700 border-blue-300 dark:bg-blue-900 dark:text-blue-200" };
  if (ls === "synced")
    return { t: "Synced", title: "Acknowledged by the server.", c: "bg-green-100 text-green-700 border-green-300 dark:bg-green-900 dark:text-green-200" };
  if (ls === "failed")
    return { t: "Sync failed", title: lastError ? `Last sync error: ${lastError}` : "Last sync attempt failed; retry when connected.", c: "bg-red-100 text-red-700 border-red-300 dark:bg-red-900 dark:text-red-200" };
  if (ls === "conflict")
    return { t: "Conflict", title: "Server advanced beyond this version; needs resolution.", c: "bg-amber-100 text-amber-800 border-amber-300 dark:bg-amber-900 dark:text-amber-200" };
  return { t: "Not synced", title: "Saved on this device, awaiting transfer to the server.", c: slate };
};

// Role-specific dashboard title (removes "who is signed in" confusion even when the
// view is shared). Label mapping only — not a permission check.
const DASHBOARD_TITLES: Partial<Record<Role, string>> = {
  HO: "Head Office Dashboard",
  Apostle: "Apostle Dashboard",
  Overseer: "Overseer Dashboard",
  Elder: "Elder Dashboard",
  Chairperson: "Chairperson Dashboard",
  Treasurer: "Treasurer Dashboard",
  Auditor: "Auditor Dashboard",
  Secretary: "Secretary Dashboard",
};
function dashboardTitle(role: Role): string {
  return DASHBOARD_TITLES[role] ?? `${role} Dashboard`;
}

// Section selectors (Capture first, Census LAST). The three non-Capture panels are
// Phase B–D placeholders; each maps to a treasurer flag on congregation_settings.
type FlagKey = keyof Pick<
  dash.DashboardSettings,
  "allow_treasurer_census" | "allow_treasurer_new_members" | "allow_treasurer_baptisms"
>;
const PLACEHOLDER_SECTIONS: { key: string; label: string; flag: FlagKey }[] = [
  { key: "first-sunday", label: "First Sunday Stats", flag: "allow_treasurer_baptisms" },
  { key: "new-members", label: "New Members", flag: "allow_treasurer_new_members" },
  { key: "census", label: "Census", flag: "allow_treasurer_census" },
];

type Section = "capture" | string;

interface Kpis {
  outstanding: number;
  captured: number;
  banked: number;
  faithfulness: number;
  interim: number;
}

export function TreasurerDashboard() {
  const [ctx, setCtx] = useState<
    | { status: "loading" }
    | { status: "error"; message: string }
    | { status: "ready"; role: Role; congregationId: string; userId: string }
  >({ status: "loading" });
  const [settings, setSettings] = useState<dash.DashboardSettings | null>(null);
  const [kpis, setKpis] = useState<Kpis | null>(null);
  const [periods, setPeriods] = useState<dash.RecentPeriodRow[]>([]);
  const [monthStatus, setMonthStatus] = useState<MonthStatus>("Open");
  const [active, setActive] = useState<Section>("capture");
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    (async () => {
      try {
        const access = await resolveAccess();
        const session = getSession();
        const role = (access?.role ?? session?.role) as Role | undefined;
        const userId = access?.user_id ?? session?.userId ?? "";
        if (!role) {
          setCtx({ status: "error", message: "No active session." });
          return;
        }
        const existing = await capture.listPeriods();
        const congregationId = access?.congregation_id ?? existing[0]?.congregationId ?? null;
        if (!congregationId) {
          setCtx({
            status: "error",
            message:
              "No congregation context yet. Connect online once to initialise, then work offline.",
          });
          return;
        }
        const cur = getCurrentOacWeek();
        const [s, outstanding, cvb, faithfulness, interim, recent, mStatus] = await Promise.all([
          dash.getDashboardSettings(congregationId),
          dash.countOutstandingWeeks(congregationId),
          dash.getThisMonthCapturedVsBanked(congregationId),
          dash.countOfficerFaithfulness(congregationId),
          dash.countInterimInUse(congregationId),
          dash.listRecentPeriods(congregationId, 8),
          capture.recomputeMonthStatus(congregationId, cur.year, cur.month),
        ]);
        setSettings(s);
        setKpis({
          outstanding,
          captured: cvb.captured,
          banked: cvb.banked,
          faithfulness,
          interim,
        });
        setPeriods(recent);
        setMonthStatus(mStatus);
        setCtx({ status: "ready", role, congregationId, userId });
      } catch (err) {
        setCtx({
          status: "error",
          message: err instanceof Error ? err.message : "Failed to load dashboard.",
        });
      }
    })();
  }, [reloadTick]);

  if (ctx.status === "loading")
    return <p className="p-6 text-sm text-muted-foreground">Loading dashboard…</p>;
  if (ctx.status === "error")
    return (
      <p className="p-6 text-sm text-destructive" role="alert">
        {ctx.message}
      </p>
    );

  const canCapture = hasPermission(ctx.role, "capture.create");
  const readyCtx = ctx;

  return (
    <main className="max-w-5xl mx-auto p-4 space-y-4">
      <h1 className="text-lg font-bold">{dashboardTitle(readyCtx.role)}</h1>

      {/* Top selectors — Capture first, Census last. */}
      <div className="flex flex-wrap gap-2">
        <Button
          variant={active === "capture" ? "default" : "outline"}
          size="sm"
          disabled={!canCapture}
          onClick={() => setActive("capture")}
        >
          Capture
        </Button>
        {PLACEHOLDER_SECTIONS.map((s) => (
          <Button
            key={s.key}
            variant={active === s.key ? "default" : "outline"}
            size="sm"
            onClick={() => setActive(s.key)}
          >
            {s.label}
          </Button>
        ))}
      </div>

      {active === "capture" ? (
        <CaptureLanding
          kpis={kpis}
          periods={periods}
          canCapture={canCapture}
          role={readyCtx.role}
          congregationId={readyCtx.congregationId}
          userId={readyCtx.userId}
          monthStatus={monthStatus}
          onRefresh={() => setReloadTick((t) => t + 1)}
        />
      ) : active === "census" ? (
        <CensusPanel role={ctx.role} congregationId={ctx.congregationId} settings={settings} />
      ) : (
        <PlaceholderPanel sectionKey={active} settings={settings} />
      )}
    </main>
  );
}

function CaptureLanding({
  kpis,
  periods,
  canCapture,
  role,
  congregationId,
  userId,
  monthStatus,
  onRefresh,
}: {
  kpis: Kpis | null;
  periods: dash.RecentPeriodRow[];
  canCapture: boolean;
  role: Role;
  congregationId: string;
  userId: string;
  monthStatus: MonthStatus;
  onRefresh: () => void;
}) {
  const navigate = useNavigate();
  const [showNewWeek, setShowNewWeek] = useState(false);
  const [monthBusy, setMonthBusy] = useState(false);
  const online = useOnlineStatus();
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState<string | null>(null);
  const [showSyncHelp, setShowSyncHelp] = useState(false);

  const canSubmitMonth = hasPermission(role, MONTH_SUBMIT);

  async function handleSubmitMonth() {
    setMonthBusy(true);
    try {
      const cur = getCurrentOacWeek();
      await capture.bulkSubmitMonthToOverseer({
        congregationId,
        year: cur.year,
        month: cur.month,
        userId,
      });
      onRefresh();
    } finally {
      setMonthBusy(false);
    }
  }

  // Task 2: manual "Sync pending work", scoped to THIS congregation (actor isolation via scope +
  // server RLS). Future-dated periods are skipped by the engine. Only confirmed server acks show as
  // Synced; local data/proofs are preserved on failure. No automatic scheduling is enabled.
  async function handleSync() {
    if (syncing) return;
    setSyncMsg(null);
    setSyncing(true);
    try {
      // Actor isolation: scope to this congregation AND the authenticated actor so a shared
      // device never dispatches another user's queued work under the current identity.
      const r = await syncPending(new Date(), congregationId, { actorUserId: userId });
      const parts: string[] = [];
      if (r.synced) parts.push(`${r.synced} synced`);
      if (r.failed) parts.push(`${r.failed} failed`);
      if (r.conflicts) parts.push(`${r.conflicts} conflict(s)`);
      if (r.pending) parts.push(`${r.pending} still pending`);
      if (r.skipped) parts.push(`${r.skipped} skipped (future-dated or not yet due)`);
      setSyncMsg(parts.length ? parts.join(" · ") : "Nothing pending to sync.");
    } catch (e) {
      setSyncMsg(e instanceof Error ? `Sync error: ${e.message}` : "Sync error.");
    } finally {
      setSyncing(false);
      onRefresh();
    }
  }

  if (!kpis) return <p className="text-sm text-muted-foreground">Loading figures…</p>;

  return (
    <div className="space-y-4">
      {/* KPI cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard title="Outstanding Weeks">
          <p className="text-2xl font-bold">{kpis.outstanding}</p>
          <p className="text-xs text-muted-foreground">Overdue prior weeks (before this week; future weeks are not counted)</p>
        </KpiCard>

        <KpiCard title="This Month">
          <p className="text-sm">
            Captured <span className="font-bold">{money(kpis.captured)}</span>
          </p>
          <p className="text-sm">
            Banked <span className="font-bold">{money(kpis.banked)}</span>
          </p>
        </KpiCard>

        <KpiCard title="Officer Faithfulness">
          <p className="text-2xl font-bold">{kpis.faithfulness}</p>
          <p className="text-xs text-muted-foreground">0 in last 4 periods</p>
        </KpiCard>

        {/* Interim In Use — amber-styled per the existing R500 governance block. */}
        <Card className="border-amber-300 bg-amber-50 text-amber-800">
          <CardHeader className="p-3 pb-0">
            <CardTitle className="text-xs font-semibold leading-none">Interim In Use</CardTitle>
          </CardHeader>
          <CardContent className="p-3 pt-1">
            <p className="text-2xl font-bold">{kpis.interim}</p>
            <p className="text-xs">Interim officers this month</p>
          </CardContent>
        </Card>
      </div>

      {/* All weeks Closed -> Chair/Elder may bulk-submit the month to the Overseer. */}
      {monthStatus === "AllWeeksClosed" && canSubmitMonth && (
        <div className="flex items-center justify-between rounded border border-emerald-300 bg-emerald-50 p-2">
          <p className="text-xs font-medium text-emerald-800">
            All weeks closed for this month. Ready to submit to Overseer.
          </p>
          <Button size="sm" disabled={monthBusy} onClick={handleSubmitMonth}>
            {monthBusy ? "Submitting…" : "Submit Month to Overseer"}
          </Button>
        </div>
      )}
      {monthStatus === "MonthSubmittedToOverseer" && (
        <div className="rounded border border-sky-300 bg-sky-50 p-2 text-xs font-medium text-sky-800" role="status">
          Month submitted to Overseer.
        </div>
      )}

      {/* Last 8 periods */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="flex items-center gap-1.5">
          <h2 className="text-sm font-semibold">Recent weeks</h2>
          <button
            type="button"
            aria-expanded={showSyncHelp}
            aria-controls="sync-legend"
            title="What the Sync labels mean"
            className="flex h-5 w-5 items-center justify-center rounded-full border text-[11px] font-semibold text-muted-foreground hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={() => setShowSyncHelp((v) => !v)}
          >
            <span aria-hidden="true">i</span>
            <span className="sr-only">What the Sync labels mean</span>
          </button>
        </div>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={!online || syncing}
            title={online ? "Push this congregation's pending captures to the server" : "Connect to sync"}
            onClick={() => void handleSync()}
          >
            {syncing ? "Syncing…" : `Sync pending work${kpis.outstanding ? ` (${kpis.outstanding})` : ""}`}
          </Button>
          <Button
            size="sm"
            disabled={!canCapture}
            title="Capture cashbook for a new week"
            onClick={() => setShowNewWeek(true)}
          >
            + New Week
          </Button>
        </div>
      </div>
      {showSyncHelp && (
        <div id="sync-legend" className="rounded border bg-muted/30 p-2 text-[11px] space-y-1">
          <p><b>Synced</b> — acknowledged by the server.</p>
          <p><b>Not synced</b> — saved on this device, awaiting transfer. Use &ldquo;Sync pending work&rdquo; when online.</p>
          <p><b>Sync failed</b> — the last attempt did not go through; the reason is shown under the badge. Retry with &ldquo;Sync pending work&rdquo;.</p>
          <p><b>Conflict</b> — the server moved ahead of this version; it needs resolution.</p>
          <p><b>Future date</b> — the service date has not arrived, so it is not transferable yet. It stays saved on this device and is never auto-synced. When the date arrives it is no longer future-dated, but there is no automatic reconnect sync — transfer it with &ldquo;Sync pending work&rdquo;.</p>
        </div>
      )}
      {syncMsg && (
        <p className="text-[11px] text-muted-foreground" role="status">
          {syncMsg}. Only confirmed server acknowledgements show as Synced; skipped work is NOT synced; future-dated weeks are never auto-synced; local data and proofs are preserved on failure.
        </p>
      )}

      {showNewWeek && (
        <NewWeekDialog
          role={role}
          congregationId={congregationId}
          userId={userId}
          onClose={() => setShowNewWeek(false)}
          onDone={(localId) => {
            setShowNewWeek(false);
            navigate("/capture/" + localId);
          }}
        />
      )}

      {periods.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No captured weeks yet. Use “+ New Week” to start.
        </p>
      ) : (
        <div className="overflow-x-auto">
        <table className="w-full text-xs min-w-[680px]">
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              <th className="py-1 pr-2 font-medium">Period</th>
              <th className="py-1 pr-2 font-medium">Sync</th>
              <th className="py-1 pr-2 font-medium text-right">Total</th>
              <th className="py-1 pr-2 font-medium text-right">Banked</th>
              <th className="py-1 pr-2 font-medium text-right">Burial</th>
              <th className="py-1 pr-2 font-medium text-right">Expenses</th>
              <th className="py-1 font-medium text-center">Interim</th>
            </tr>
          </thead>
          <tbody>
            {periods.map((p) => {
              const sb = syncBadge(p.localStatus, p.isFuture, p.lastError);
              const pending = p.total - p.banked;
              return (
              <tr key={p.localId} className="border-b last:border-0">
                <td className="p-0">
                  <button
                    type="button"
                    className="w-full py-1 pr-2 text-left hover:underline"
                    title={`${p.weekEnding} · ${p.service} · ${periodStatusLabel(p.status)}`}
                    onClick={() => navigate("/capture/" + p.localId)}
                  >
                    <span className="font-medium">Wk {p.week} · {p.serviceDate} {p.year}</span>
                    <span className="ml-1 inline-block rounded bg-primary/10 px-1 text-[9px] font-bold text-primary">{p.service}</span>
                    <span className="ml-1 text-[10px] text-muted-foreground">{periodStatusLabel(p.status)}</span>
                  </button>
                </td>
                <td className="py-1 pr-2">
                  <span className={`inline-block rounded border px-1.5 py-0.5 text-[9px] font-medium ${sb.c}`} title={sb.title}>{sb.t}</span>
                  {p.localStatus === "failed" && p.lastError && (
                    <span className="block max-w-[180px] truncate text-[9px] text-red-600 dark:text-red-400" title={p.lastError}>{p.lastError}</span>
                  )}
                </td>
                <td className="py-1 pr-2 text-right">{money(p.total)}</td>
                <td className="py-1 pr-2 text-right">
                  {money(p.banked)}
                  {pending > 0.005 && (
                    <span className="block text-[9px] text-amber-700 dark:text-amber-400">pending {money(pending)}</span>
                  )}
                </td>
                <td className="py-1 pr-2 text-right">{money(p.burial)}</td>
                <td className="py-1 pr-2 text-right">{money(p.expenses)}</td>
                <td className="py-1 text-center">
                  {p.hasInterim ? (
                    <span className="inline-flex items-center gap-1 text-[9px] text-amber-700 dark:text-amber-400" title="Uses an interim officer (pending HO)">
                      <span className="inline-block h-2 w-2 rounded-full bg-amber-500" aria-hidden="true" />Interim
                    </span>
                  ) : (
                    <span className="text-muted-foreground">–</span>
                  )}
                </td>
              </tr>
              );
            })}
          </tbody>
        </table>
        </div>
      )}
    </div>
  );
}

// New-Week guard + R0 flow (Decision 3; the R0 UI lives HERE, not in CashbookForm).
// Behaviour:
//  - Hard block (independent of the modal): getOrCreateLocalPeriod's unique naturalKey
//    (`${congregationId}|${weekKey}|${service}`) returns the EXISTING period, so we
//    never create a duplicate of the same week-number for the same congregation+month.
//  - If OUTSTANDING weeks exist (not yet Closed, before the current week), warn and
//    offer [Go to Outstanding] or [Create Week{N} anyway].
//  - "No tithing this week" ticks the R0 path: a confirmation sub-modal, then a direct
//    Draft -> Submitted with the R0 audit trail.
//  - A Chairperson acts-as-Treasurer (ACTING_AS_TREASURER logged / queued).
function NewWeekDialog({
  role,
  congregationId,
  userId,
  onClose,
  onDone,
}: {
  role: Role;
  congregationId: string;
  userId: string;
  onClose: () => void;
  onDone: (periodLocalId: string) => void;
}) {
  const cur = getCurrentOacWeek();
  const targetWeekNum = parseInt(cur.weekKey.split("-W")[1] ?? "1", 10);
  const [outstanding, setOutstanding] = useState<LocalPeriod[]>([]);
  const [noTithing, setNoTithing] = useState(false);
  const [confirmR0, setConfirmR0] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const service: "AM" | "PM" = "AM";
  const canConfirmR0 = hasPermission(role, CAPTURE_R0_CONFIRM);
  // Matrix-routed (no role-string check): Treasurer signs off by default; any other eligible
  // submitter (e.g. Chairperson when the Treasurer is ill) acts AS Treasurer and is audited.
  const signOff = resolveSignOff(role);
  const actingAsRole: Role | null = signOff.requiresException ? signOff.signOffRole : null;

  useEffect(() => {
    (async () => {
      setOutstanding(await capture.listOutstandingWeeks(congregationId));
    })();
  }, [congregationId]);

  async function logActingAsIfOnline(periodLocalId: string) {
    if (!actingAsRole) return;
    const online = typeof navigator === "undefined" ? true : navigator.onLine;
    if (!online) return; // offline: flushed by the Sync_Engine on reconnect
    try {
      await logActingAsTreasurer({
        userId,
        entityType: "cashbook_period",
        entityId: periodLocalId,
      });
    } catch {
      // Non-fatal; the audit flush also runs on sync.
    }
  }

  async function proceedCreate() {
    setBusy(true);
    setError(null);
    try {
      const p = await capture.getOrCreateLocalPeriod({
        congregationId,
        weekKey: cur.weekKey,
        service,
        year: cur.year,
        month: cur.month,
        week: targetWeekNum,
        userId,
      });
      if (actingAsRole) await logActingAsIfOnline(p.localId);
      onDone(p.localId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create the week.");
      setBusy(false);
    }
  }

  async function proceedR0() {
    setBusy(true);
    setError(null);
    try {
      const p = await capture.confirmR0NoTithing({
        congregationId,
        weekKey: cur.weekKey,
        service,
        year: cur.year,
        month: cur.month,
        week: targetWeekNum,
        userId,
        actingAsRole,
      });
      await logActingAsIfOnline(p.localId);
      // Task 1: a zero-value R0 submission is a real "Submitted for audit" action - push it to the
      // server like CashbookForm.submit does, so an acknowledged zero submission reaches the Auditor
      // queue. Offline or on failure it stays pending on THIS device and is pushed on the NEXT
      // user-triggered sync (another capture submit/R0); there is NO automatic reconnect sync here.
      void syncPending(new Date(), congregationId, { actorUserId: userId }).catch(() => {}); // actor isolation: congregation + actor
      onDone(p.localId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to confirm R0.");
      setBusy(false);
    }
  }

  // When the user proceeds: R0 ticked -> confirmation sub-modal; else create directly.
  function handleProceed() {
    if (noTithing && canConfirmR0) {
      setConfirmR0(true);
      return;
    }
    void proceedCreate();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-week-title"
    >
      <div className="w-full max-w-md rounded-md border bg-background p-4 shadow-lg space-y-3">
        <h2 id="new-week-title" className="text-sm font-semibold">
          New Week — Week {targetWeekNum}
        </h2>

        {!confirmR0 ? (
          <>
            {outstanding.length > 0 && (
              <div
                className="rounded border border-amber-300 bg-amber-50 p-2 text-xs text-amber-800"
                role="status"
              >
                Week{outstanding[0].week} {monthName(outstanding[0].month)} outstanding (
                {periodStatusLabel(outstanding[0].status)}).
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => onDone(outstanding[0].localId)}
                  >
                    Go to Outstanding
                  </Button>
                </div>
              </div>
            )}

            {canConfirmR0 && (
              <label className="flex items-center gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={noTithing}
                  onChange={(e) => setNoTithing(e.target.checked)}
                />
                No tithing this week
              </label>
            )}

            {actingAsRole && (
              <p className="text-[11px] text-muted-foreground">
                You are acting as Treasurer; this action is logged.
              </p>
            )}

            {error && (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            )}

            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={onClose} disabled={busy}>
                Cancel
              </Button>
              <Button size="sm" onClick={handleProceed} disabled={busy}>
                {busy
                  ? "Working…"
                  : outstanding.length > 0
                  ? `Create Week${targetWeekNum} anyway`
                  : noTithing && canConfirmR0
                  ? "Continue — No tithing"
                  : `Create Week${targetWeekNum}`}
              </Button>
            </div>
          </>
        ) : (
          <>
            <p className="text-xs">
              Confirm no tithing for Week {targetWeekNum} as R0.00 — will be submitted for
              audit as R0.00.
            </p>
            {error && (
              <p role="alert" className="text-xs text-destructive">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="ghost" onClick={() => setConfirmR0(false)} disabled={busy}>
                Back
              </Button>
              <Button size="sm" onClick={() => void proceedR0()} disabled={busy}>
                {busy ? "Submitting…" : "Confirm R0.00"}
              </Button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const MONTH_NAMES = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];
function monthName(month: number): string {
  return MONTH_NAMES[month - 1] ?? String(month);
}

function KpiCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader className="p-3 pb-0">
        <CardTitle className="text-xs font-semibold leading-none text-muted-foreground">
          {title}
        </CardTitle>
      </CardHeader>
      <CardContent className="p-3 pt-1 space-y-0.5">{children}</CardContent>
    </Card>
  );
}

function PlaceholderPanel({
  sectionKey,
  settings,
}: {
  sectionKey: string;
  settings: dash.DashboardSettings | null;
}) {
  const section = PLACEHOLDER_SECTIONS.find((s) => s.key === sectionKey);
  if (!section) return null;
  const treasurerAllowed = settings ? settings[section.flag] : false;

  return (
    <Card>
      <CardHeader className="p-4 pb-0">
        <CardTitle className="text-base font-semibold">{section.label}</CardTitle>
      </CardHeader>
      <CardContent className="p-4 space-y-2">
        <p className="text-sm text-muted-foreground">Coming in Phase B/C/D</p>
        {!treasurerAllowed && (
          <p className="text-xs font-medium text-amber-700">Managed by Chairperson</p>
        )}
      </CardContent>
    </Card>
  );
}

// Census section — gated PURELY through the permissions matrix + the
// allow_treasurer_census flag (no role-string checks). A role with CENSUS_EDIT
// (Chairperson) always edits; a role with CENSUS_VIEW only (Treasurer) is upgraded
// to edit by the per-congregation flag, otherwise it gets a read-only view.
function CensusPanel({
  role,
  congregationId,
  settings,
}: {
  role: Role;
  congregationId: string;
  settings: dash.DashboardSettings | null;
}) {
  const canView = hasPermission(role, CENSUS_VIEW);
  const canEditBase = hasPermission(role, CENSUS_EDIT);
  const allowTreasurerCensus = settings?.allow_treasurer_census ?? false;
  const canEdit = canEditBase || (canView && allowTreasurerCensus);

  if (!canView) {
    return (
      <Card>
        <CardContent className="p-4">
          <p className="text-sm text-muted-foreground" role="alert">
            You do not have access to census data.
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      {!canEdit && (
        <div
          className="rounded border border-amber-300 bg-amber-50 p-2 text-xs font-medium text-amber-800"
          role="status"
        >
          Managed by Chairperson — read-only view.
        </div>
      )}
      <CensusManager congregationId={congregationId} readOnly={!canEdit} />
    </div>
  );
}
