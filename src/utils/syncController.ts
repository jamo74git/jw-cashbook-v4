// ─────────────────────────────────────────────────────────────────────────────
// PROGRESSIVE DISPATCH CONTROLLER (PRIORITY 1) — "transfer as connectivity allows".
//
// Reacts to connectivity/visibility and schedules the SAME single reconciliation path
// (`syncPending`) — there is no second transfer path. Manual "Sync now" and this
// controller both call `syncPending`.
//
// FEATURE GATE (design delivery constraint, §"Ordering / FEATURE-GATE dependency"):
// AUTOMATIC dispatch stays DISABLED until actor-scoped authenticated replay AND
// reconnect re-validation are wired, so no build can drain another saved user's queue
// under the wrong JWT. While `PROGRESSIVE_DISPATCH_ENABLED` is false the controller is
// a no-op; manual, congregation + actor-scoped sync remains the only active path.
// ─────────────────────────────────────────────────────────────────────────────

import type { SyncReport } from "@/utils/syncEngine";

// Enable-gate. Flip to true ONLY once actor-scoped authenticated replay + reconnect
// re-validation are proven (local + hosted). Keep false for the demo build.
export const PROGRESSIVE_DISPATCH_ENABLED = false;

export interface DispatchState {
  enabled: boolean;
  online: boolean;
  /** An authenticated actor id is resolved (fail-closed: empty => not dispatchable). */
  hasActor: boolean;
  /** The actor's authority was re-validated on this reconnect (design D2). */
  revalidated: boolean;
  /** A dispatch is already running (single-flight). */
  inFlight: boolean;
  /** The user explicitly paused transfer. */
  paused: boolean;
}

/**
 * Pure scheduling decision: dispatch ONLY when enabled, online, an authenticated actor
 * is present AND re-validated, nothing is in flight, and transfer is not paused.
 * Fail-closed on every missing precondition.
 */
export function shouldDispatchNow(state: DispatchState): boolean {
  return (
    state.enabled &&
    state.online &&
    state.hasActor &&
    state.revalidated &&
    !state.inFlight &&
    !state.paused
  );
}

export interface SyncControllerDeps {
  /** Resolve the current authenticated actor id (null/"" => not dispatchable). */
  resolveActor: () => Promise<string | null>;
  /** Re-validate the actor's authority on reconnect; false => do not dispatch. */
  revalidate: (actorUserId: string) => Promise<boolean>;
  /** The single reconciliation path, scoped to the resolved actor. */
  dispatch: (actorUserId: string) => Promise<SyncReport>;
  /** Is the user currently online? Defaults to navigator.onLine. */
  isOnline?: () => boolean;
  /** Is transfer paused by the user? Defaults to never paused. */
  isPaused?: () => boolean;
  /** Debounce window for burst connectivity/visibility events (ms). */
  debounceMs?: number;
}

export interface SyncController {
  start: () => void;
  stop: () => void;
  /** Attempt a dispatch now, honouring every gate. Returns the report or null if skipped. */
  trigger: () => Promise<SyncReport | null>;
}

const defaultOnline = (): boolean => (typeof navigator === "undefined" ? true : navigator.onLine);

/**
 * Create a progressive-dispatch controller. It is inert while
 * `PROGRESSIVE_DISPATCH_ENABLED` is false (and `start()` registers no listeners), so it
 * is safe to bootstrap unconditionally; it only ever runs the gated, actor-scoped path.
 */
export function createSyncController(deps: SyncControllerDeps): SyncController {
  const isOnline = deps.isOnline ?? defaultOnline;
  const isPaused = deps.isPaused ?? (() => false);
  const debounceMs = deps.debounceMs ?? 1_500;

  let inFlight = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let started = false;

  async function trigger(): Promise<SyncReport | null> {
    if (
      !shouldDispatchNow({
        enabled: PROGRESSIVE_DISPATCH_ENABLED,
        online: isOnline(),
        hasActor: true, // re-checked precisely below once the actor is resolved
        revalidated: true, // re-checked below after revalidate()
        inFlight,
        paused: isPaused(),
      })
    ) {
      return null;
    }
    const actor = await deps.resolveActor();
    if (!actor) return null; // fail-closed: no authenticated actor
    const ok = await deps.revalidate(actor);
    if (!ok) return null; // reconnect re-validation failed -> never dispatch
    inFlight = true;
    try {
      return await deps.dispatch(actor);
    } finally {
      inFlight = false;
    }
  }

  function scheduleTrigger(): void {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void trigger();
    }, debounceMs);
  }

  function onOnline(): void {
    scheduleTrigger();
  }
  function onVisibility(): void {
    if (typeof document !== "undefined" && document.visibilityState === "visible") scheduleTrigger();
  }

  function start(): void {
    if (started || !PROGRESSIVE_DISPATCH_ENABLED) return; // inert while gated
    if (typeof window !== "undefined") {
      window.addEventListener("online", onOnline);
      if (typeof document !== "undefined") document.addEventListener("visibilitychange", onVisibility);
    }
    started = true;
  }

  function stop(): void {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (started && typeof window !== "undefined") {
      window.removeEventListener("online", onOnline);
      if (typeof document !== "undefined") document.removeEventListener("visibilitychange", onVisibility);
    }
    started = false;
  }

  return { start, stop, trigger };
}
