import { useEffect, useState } from "react";
import { resolveAccess } from "@/lib/routeGuard";
import { getSession } from "@/services/authService";
import * as capture from "@/db/captureRepo";
import { CashbookForm } from "@/components/CashbookForm";
import type { Role, ServiceType } from "@/lib/types";

/**
 * Offline-first capture workspace. Resolves the current role + congregation context,
 * loads (or creates) a local draft service in Dexie, and renders the cashbook form
 * bound to the Local_Store. Zero network dependency once a congregation context is known.
 */
export function CapturePage() {
  const [state, setState] = useState<
    | { status: "loading" }
    | { status: "error"; message: string }
    | { status: "ready"; role: Role; congregationId: string; serviceLocalId: string }
  >({ status: "loading" });

  useEffect(() => {
    (async () => {
      const access = await resolveAccess();
      const session = getSession();
      const role = (access?.role ?? session?.role) as Role | undefined;
      if (!role) {
        setState({ status: "error", message: "No active session." });
        return;
      }

      // Congregation context: online access record, else the most recent local service.
      const existing = await capture.listServices();
      const congregationId = access?.congregation_id ?? existing[0]?.congregationId ?? null;
      if (!congregationId) {
        setState({
          status: "error",
          message: "No congregation context yet. Connect online once to initialise your congregation, then capture offline.",
        });
        return;
      }

      // Reuse the latest local draft for this congregation, or create a new one.
      const draft = existing.find(
        (s) => s.congregationId === congregationId && s.serviceStatus === "Draft" && s.localStatus !== "synced"
      );
      let serviceLocalId = draft?.localId;
      if (!serviceLocalId) {
        const now = new Date();
        serviceLocalId = await capture.createLocalService({
          congregationId,
          capturedByUserId: session?.userId ?? access?.user_id ?? "",
          capturedRole: role,
          year: now.getFullYear(),
          month: now.getMonth() + 1,
          week: Math.ceil(now.getDate() / 7),
          service_type: "AM" as ServiceType,
          service_date: now.toISOString().slice(0, 10),
        });
      }

      setState({ status: "ready", role, congregationId, serviceLocalId });
    })();
  }, []);

  if (state.status === "loading") return <p className="text-sm text-muted-foreground">Loading capture…</p>;
  if (state.status === "error") return <p className="text-sm text-destructive">{state.message}</p>;

  return (
    <div className="max-w-4xl mx-auto space-y-4">
      <h1 className="text-lg font-bold">Cashbook Capture</h1>
      <CashbookForm
        serviceLocalId={state.serviceLocalId}
        congregationId={state.congregationId}
        role={state.role}
        isLocked={false}
      />
    </div>
  );
}
