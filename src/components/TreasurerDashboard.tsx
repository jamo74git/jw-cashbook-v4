import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { resolveAccess } from "@/lib/routeGuard";
import { getSession } from "@/services/authService";
import { hasPermission } from "@/lib/permissions";
import * as capture from "@/db/captureRepo";
import * as dash from "@/db/dashboardRepo";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { Role } from "@/lib/types";

const money = (n: number): string => `R${n.toFixed(2)}`;

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
  const navigate = useNavigate();
  const [ctx, setCtx] = useState<
    | { status: "loading" }
    | { status: "error"; message: string }
    | { status: "ready"; role: Role; congregationId: string }
  >({ status: "loading" });
  const [settings, setSettings] = useState<dash.DashboardSettings | null>(null);
  const [kpis, setKpis] = useState<Kpis | null>(null);
  const [periods, setPeriods] = useState<dash.RecentPeriodRow[]>([]);
  const [active, setActive] = useState<Section>("capture");

  useEffect(() => {
    (async () => {
      try {
        const access = await resolveAccess();
        const session = getSession();
        const role = (access?.role ?? session?.role) as Role | undefined;
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
        const [s, outstanding, cvb, faithfulness, interim, recent] = await Promise.all([
          dash.getDashboardSettings(congregationId),
          dash.countOutstandingWeeks(congregationId),
          dash.getThisMonthCapturedVsBanked(congregationId),
          dash.countOfficerFaithfulness(congregationId),
          dash.countInterimInUse(congregationId),
          dash.listRecentPeriods(congregationId, 8),
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
        setCtx({ status: "ready", role, congregationId });
      } catch (err) {
        setCtx({
          status: "error",
          message: err instanceof Error ? err.message : "Failed to load dashboard.",
        });
      }
    })();
  }, []);

  if (ctx.status === "loading")
    return <p className="p-6 text-sm text-muted-foreground">Loading dashboard…</p>;
  if (ctx.status === "error")
    return (
      <p className="p-6 text-sm text-destructive" role="alert">
        {ctx.message}
      </p>
    );

  const canCapture = hasPermission(ctx.role, "capture.create");

  return (
    <main className="max-w-5xl mx-auto p-4 space-y-4">
      <h1 className="text-lg font-bold">Dashboard</h1>

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
          onOpenCapture={() => navigate("/capture")}
        />
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
  onOpenCapture,
}: {
  kpis: Kpis | null;
  periods: dash.RecentPeriodRow[];
  canCapture: boolean;
  onOpenCapture: () => void;
}) {
  if (!kpis) return <p className="text-sm text-muted-foreground">Loading figures…</p>;

  return (
    <div className="space-y-4">
      {/* KPI cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KpiCard title="Outstanding Weeks">
          <p className="text-2xl font-bold">{kpis.outstanding}</p>
          <p className="text-xs text-muted-foreground">Unsynced, before this week</p>
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

      {/* Last 8 periods */}
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">Recent weeks</h2>
        <Button size="sm" disabled={!canCapture} onClick={onOpenCapture}>
          + New Week
        </Button>
      </div>

      {periods.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No captured weeks yet. Use “+ New Week” to start.
        </p>
      ) : (
        <table className="w-full text-xs">
          <thead>
            <tr className="border-b text-left text-muted-foreground">
              <th className="py-1 pr-2 font-medium">Week Ending</th>
              <th className="py-1 pr-2 font-medium">Status</th>
              <th className="py-1 pr-2 font-medium text-right">Total</th>
              <th className="py-1 pr-2 font-medium text-right">Banked</th>
              <th className="py-1 font-medium text-center">Interim</th>
            </tr>
          </thead>
          <tbody>
            {periods.map((p) => (
              <tr key={p.localId} className="border-b last:border-0">
                <td className="p-0">
                  <button
                    type="button"
                    className="w-full py-1 pr-2 text-left hover:underline"
                    onClick={onOpenCapture}
                  >
                    {p.weekEnding} · {p.service}
                  </button>
                </td>
                <td className="py-1 pr-2">
                  <Badge variant="outline">{p.status}</Badge>
                </td>
                <td className="py-1 pr-2 text-right">{money(p.total)}</td>
                <td className="py-1 pr-2 text-right">{money(p.banked)}</td>
                <td className="py-1 text-center">
                  {p.hasInterim ? (
                    <span
                      className="inline-block h-2 w-2 rounded-full bg-amber-500"
                      aria-label="Uses interim officer"
                      title="Uses interim officer"
                    />
                  ) : (
                    <span className="text-muted-foreground">–</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
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
