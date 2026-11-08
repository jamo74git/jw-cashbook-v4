// PRIORITY 1 — progressive-dispatch bootstrap. Wires the SAME single reconciliation path
// (`syncPending`) to the connectivity-reactive controller, under the actor's own authority
// with reconnect re-validation. It is INERT while `PROGRESSIVE_DISPATCH_ENABLED` is false
// (the controller registers no listeners and never dispatches), so it is safe to start
// unconditionally — no build can drain another saved user's queue before the gate is flipped.

import { createSyncController, type SyncController } from "@/utils/syncController";
import { createClient } from "@/lib/supabase/client";
import { revalidateOnReconnect } from "@/services/authService";
import { syncPending } from "@/utils/syncEngine";

let controller: SyncController | null = null;

/** Start the (gated) progressive-dispatch controller. Returns a stop/cleanup function. */
export function startProgressiveDispatch(): () => void {
  if (!controller) {
    controller = createSyncController({
      // The authenticated actor whose queued work may be dispatched (fail-closed to null).
      resolveActor: async () => {
        try {
          const { data } = await createClient().auth.getUser();
          return data?.user?.id ?? null;
        } catch {
          return null;
        }
      },
      // Reconnect re-validation BEFORE dispatching that actor's ops (design D2).
      revalidate: async (actorUserId) => {
        const res = await revalidateOnReconnect(actorUserId);
        return res.ok;
      },
      // Single reconciliation path, scoped to the resolved actor (actor isolation).
      dispatch: async (actorUserId) => syncPending(new Date(), undefined, { actorUserId }),
    });
  }
  controller.start();
  return () => {
    controller?.stop();
  };
}
