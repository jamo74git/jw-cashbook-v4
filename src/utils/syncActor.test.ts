// PRIORITY 1 — actor isolation for shared-device transfer. Pure-logic tests: a build
// must never drain another saved user's queue, and an unknown actor authorizes nothing.
import { describe, it, expect } from "vitest";
import { filterQueueForActor, isReplayAuthorized, type QueueScope } from "@/utils/syncActor";

type Row = { congregationId: string; capturedByUserId: string; localId: string };
const rows: Row[] = [
  { localId: "a1", congregationId: "congX", capturedByUserId: "user1" },
  { localId: "a2", congregationId: "congX", capturedByUserId: "user2" },
  { localId: "b1", congregationId: "congY", capturedByUserId: "user1" },
];

describe("isReplayAuthorized (fail-closed)", () => {
  it("authorizes only the capturing actor", () => {
    expect(isReplayAuthorized({ capturedByUserId: "user1" }, "user1")).toBe(true);
    expect(isReplayAuthorized({ capturedByUserId: "user1" }, "user2")).toBe(false);
  });
  it("authorizes nothing for a missing/empty actor id", () => {
    expect(isReplayAuthorized({ capturedByUserId: "user1" }, "")).toBe(false);
    expect(isReplayAuthorized({ capturedByUserId: "user1" }, null)).toBe(false);
    expect(isReplayAuthorized({ capturedByUserId: "user1" }, undefined)).toBe(false);
  });
});

describe("filterQueueForActor", () => {
  it("keeps the congregation filter unchanged when no actor is given (backward compatible)", () => {
    const out = filterQueueForActor(rows, { congregationId: "congX" });
    expect(out.map((r) => r.localId)).toEqual(["a1", "a2"]);
  });

  it("isolates a shared device: only the authenticated actor's work dispatches", () => {
    const scope: QueueScope = { congregationId: "congX", actorUserId: "user1" };
    const out = filterQueueForActor(rows, scope);
    expect(out.map((r) => r.localId)).toEqual(["a1"]); // user2's a2 is excluded
  });

  it("excludes cross-actor work across congregations too", () => {
    const out = filterQueueForActor(rows, { actorUserId: "user1" });
    expect(out.map((r) => r.localId)).toEqual(["a1", "b1"]);
  });

  it("fail-closed: an empty actor id yields an empty queue even without a congregation filter", () => {
    expect(filterQueueForActor(rows, { actorUserId: "" })).toEqual([]);
  });

  it("no scope => everything (unchanged default behaviour)", () => {
    expect(filterQueueForActor(rows)).toHaveLength(3);
  });
});
