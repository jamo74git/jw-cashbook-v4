import { useCallback, useEffect, useState } from "react";
import { resolveAccess } from "@/lib/routeGuard";
import { getSession } from "@/services/authService";
import * as capture from "@/db/captureRepo";
import { getOacWeeks, getCurrentOacWeek, type OacWeek } from "@/lib/oacWeeks";
import { CashbookForm } from "@/components/CashbookForm";
import type { LocalPeriod, OfficerLookup } from "@/db/schema";
import type { Role } from "@/lib/types";

/**
 * Treasurer capture workspace. Resolves role + congregation, offers OAC week + AM/PM
 * selection, resolves (or creates) the local provisional period, and renders the
 * cashbook form bound to Dexie. Fully offline-capable once reference data is cached.
 */
export function CapturePage() {
  const [ctx, setCtx] = useState<
    | { status: "loading" }
    | { status: "error"; message: string }
    | { status: "ready"; role: Role; congregationId: string; userId: string }
  >({ status: "loading" });

  const [weeks, setWeeks] = useState<OacWeek[]>([]);
  const [base, setBase] = useState<{ year: number; month: number }>({ year: 0, month: 0 });
  const [weekKey, setWeekKey] = useState("");
  const [service, setService] = useState<"AM" | "PM">("AM");
  const [officers, setOfficers] = useState<OfficerLookup[]>([]);
  const [proofMandatory, setProofMandatory] = useState(false);
  const [period, setPeriod] = useState<LocalPeriod | null>(null);

  // Resolve role + congregation once.
  useEffect(() => {
    (async () => {
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
          message: "No congregation context yet. Connect online once to initialise, then capture offline.",
        });
        return;
      }
      const cur = getCurrentOacWeek();
      setBase({ year: cur.year, month: cur.month });
      setWeeks(getOacWeeks(cur.year, cur.month));
      setWeekKey(cur.weekKey);
      setOfficers(await capture.listOfficers(congregationId));
      setProofMandatory(await capture.getProofMandatory(congregationId));
      setCtx({ status: "ready", role, congregationId, userId });
    })();
  }, []);

  // Resolve/create the local period whenever week or service changes.
  const resolvePeriod = useCallback(async () => {
    if (ctx.status !== "ready" || !weekKey) return;
    const wk = weeks.find((w) => w.weekKey === weekKey);
    const p = await capture.getOrCreateLocalPeriod({
      congregationId: ctx.congregationId,
      weekKey,
      service,
      year: base.year,
      month: base.month,
      week: wk?.weekNum ?? 1,
      userId: ctx.userId,
    });
    setPeriod(p);
  }, [ctx, weekKey, service, weeks, base]);

  useEffect(() => {
    void resolvePeriod();
  }, [resolvePeriod]);

  const reloadPeriod = useCallback(async () => {
    if (period) {
      const p = await capture.getPeriod(period.localId);
      if (p) setPeriod(p);
    }
  }, [period]);

  if (ctx.status === "loading") return <p className="text-sm text-muted-foreground">Loading capture…</p>;
  if (ctx.status === "error") return <p className="text-sm text-destructive">{ctx.message}</p>;

  return (
    <div className="max-w-5xl mx-auto space-y-3">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <h1 className="text-lg font-bold">Cashbook Capture</h1>
        <div className="flex items-center gap-2 text-xs">
          <select
            className="h-8 rounded border border-input bg-background px-2 text-xs max-w-[220px]"
            value={weekKey}
            onChange={(e) => setWeekKey(e.target.value)}
          >
            {weeks.map((w) => (
              <option key={w.weekKey} value={w.weekKey}>
                {w.label}
              </option>
            ))}
          </select>
          <select
            className="h-8 w-16 rounded border border-input bg-background px-2 text-xs font-bold"
            value={service}
            onChange={(e) => setService(e.target.value as "AM" | "PM")}
          >
            <option value="AM">AM</option>
            <option value="PM">PM</option>
          </select>
          {period && (
            <span className="rounded bg-muted px-2 py-1 text-[10px] font-medium">{period.status}</span>
          )}
        </div>
      </div>

      {period ? (
        <CashbookForm
          key={period.localId}
          period={period}
          role={ctx.role}
          officers={officers}
          proofMandatory={proofMandatory}
          onChanged={reloadPeriod}
        />
      ) : (
        <p className="text-sm text-muted-foreground">Resolving period…</p>
      )}
    </div>
  );
}
