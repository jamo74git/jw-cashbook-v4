import { useEffect, useState } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { resolveAccess, canViewOfficerFaithfulness, redirectTargetFor } from "@/lib/routeGuard";
import { getSession } from "@/services/authService";
import * as capture from "@/db/captureRepo";
import * as dash from "@/db/dashboardRepo";
import { listOfficersWithoutRecentTitheLive } from "@/elder/officerFaithfulnessLive";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { Role } from "@/lib/types";

/**
 * Officer Faithfulness detail: active cached officers with no tithe line in the last 4
 * periods (same computation as the dashboard card). Chairperson/Elder only; the gate
 * is the permission matrix via routeGuard. Reads the local Dexie store only.
 */
export function OfficerFaithfulnessPage() {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const congParam = params.get("cong");
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "denied"; target: string }
    | { status: "error"; message: string }
    | { status: "ready"; officers: dash.FaithfulnessOfficer[] }
  >({ status: "loading" });

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const access = await resolveAccess();
        const role = (access?.role ?? getSession()?.role) as Role | undefined;
        if (!role) return active && setState({ status: "error", message: "No active session." });
        if (!canViewOfficerFaithfulness(role)) {
          return active && setState({ status: "denied", target: redirectTargetFor(role) });
        }
        // Elder (no home congregation, online-only portal): read the selected congregation live.
        const liveCong = !access?.congregation_id && congParam ? congParam : null;
        if (liveCong) {
          const live = await listOfficersWithoutRecentTitheLive(liveCong);
          if (active) setState({ status: "ready", officers: live });
          return;
        }
        const existing = await capture.listPeriods();
        const congregationId = access?.congregation_id ?? existing[0]?.congregationId ?? null;
        if (!congregationId) {
          return (
            active &&
            setState({
              status: "error",
              message: "No congregation context yet. Connect online once to initialise.",
            })
          );
        }
        const officers = await dash.listOfficersWithoutRecentTithe(congregationId);
        if (active) setState({ status: "ready", officers });
      } catch (err) {
        if (active)
          setState({ status: "error", message: err instanceof Error ? err.message : "Failed to load." });
      }
    })();
    return () => {
      active = false;
    };
  }, [congParam]);

  if (state.status === "denied") return <Navigate to={state.target} replace />;

  function goBack() {
    if (window.history.length > 1) navigate(-1);
    else navigate(congParam ? "/elder" : "/dashboard");
  }

  return (
    <main className="max-w-3xl mx-auto p-4 space-y-4">
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={goBack}>
          ← Back
        </Button>
        <h1 className="text-lg font-bold">Officer Faithfulness</h1>
      </div>
      <p className="text-xs text-muted-foreground">
        Active priests and underdeacons (including interim officers) who have no tithe recorded
        against them in the last 4 periods captured on this device. AM and PM services count as
        separate periods.
      </p>

      {state.status === "loading" && <p className="text-sm text-muted-foreground">Loading…</p>}
      {state.status === "error" && (
        <p className="text-sm text-destructive" role="alert">
          {state.message}
        </p>
      )}
      {state.status === "ready" &&
        (state.officers.length === 0 ? (
          <p className="text-sm text-green-700 dark:text-green-400" role="status">
            Every active officer has a tithe recorded in the last 4 periods.
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs border-collapse">
              <thead>
                <tr className="bg-muted text-left">
                  <th className="px-3 py-2">Code</th>
                  <th className="px-2 py-2">Name</th>
                  <th className="px-2 py-2">Rank</th>
                </tr>
              </thead>
              <tbody>
                {state.officers.map((o) => (
                  <tr key={o.id} className="border-b">
                    <td className="px-3 py-2 font-medium">{o.officer_code}</td>
                    <td className="px-2 py-2">
                      {[o.first_name, o.last_name].filter(Boolean).join(" ")}
                      {o.is_interim && (
                        <Badge variant="outline" className="ml-2 text-[9px]">
                          Interim
                        </Badge>
                      )}
                    </td>
                    <td className="px-2 py-2">{o.rank}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
    </main>
  );
}
