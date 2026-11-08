// PRIORITY 1 — progressive dispatch controller. The scheduling decision is fail-closed on
// every missing precondition, and the controller is INERT while the feature gate is off so
// no build drains another saved user's queue under the wrong JWT before actor-replay is wired.
import { describe, it, expect, vi } from "vitest";
import {
  shouldDispatchNow,
  createSyncController,
  PROGRESSIVE_DISPATCH_ENABLED,
  type DispatchState,
} from "@/utils/syncController";

function state(over: Partial<DispatchState> = {}): DispatchState {
  return { enabled: true, online: true, hasActor: true, revalidated: true, inFlight: false, paused: false, ...over };
}

describe("shouldDispatchNow", () => {
  it("dispatches only when every precondition holds", () => {
    expect(shouldDispatchNow(state())).toBe(true);
  });
  it("is fail-closed on each missing precondition", () => {
    expect(shouldDispatchNow(state({ enabled: false }))).toBe(false);
    expect(shouldDispatchNow(state({ online: false }))).toBe(false);
    expect(shouldDispatchNow(state({ hasActor: false }))).toBe(false);
    expect(shouldDispatchNow(state({ revalidated: false }))).toBe(false);
    expect(shouldDispatchNow(state({ inFlight: true }))).toBe(false);
    expect(shouldDispatchNow(state({ paused: true }))).toBe(false);
  });
});

describe("createSyncController", () => {
  it("is gated: the demo build keeps automatic dispatch DISABLED", () => {
    // Locks the enable-gate default for the demo. Flip only after actor-replay + reconnect
    // re-validation are proven (local + hosted).
    expect(PROGRESSIVE_DISPATCH_ENABLED).toBe(false);
  });

  it("trigger() is a no-op while gated: it never resolves an actor or dispatches", async () => {
    const resolveActor = vi.fn(async () => "user-1");
    const revalidate = vi.fn(async () => true);
    const dispatch = vi.fn(async () => ({ attempted: 0, synced: 0, conflicts: 0, failed: 0, skipped: 0, blocked: 0, pending: 0 }));
    const ctrl = createSyncController({ resolveActor, revalidate, dispatch, isOnline: () => true });
    const r = await ctrl.trigger();
    expect(r).toBeNull();
    expect(resolveActor).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });
});
