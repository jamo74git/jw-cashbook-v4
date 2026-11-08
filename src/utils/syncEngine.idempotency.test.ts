// PRIORITY 1 — idempotent replay at the sync-engine level. Proves that a retry AFTER a
// LOST ACKNOWLEDGEMENT (the governance insert committed server-side but its response was
// lost) does NOT create a duplicate ACTING_AS_TREASURER event: the pre-insert lookup finds
// the committed row and the engine marks it flushed without re-inserting.
//
// NOTE: the durable guarantee is the authored server-side unique key on
// (entity_id, action_type, user_id) — NOT applied here; verify with hosted testing.
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, vi } from "vitest";

const store = vi.hoisted(() => ({
  auditRows: [] as { id: string; entity_id: string; action_type: string; user_id: string }[],
  // When true, attempt-1 insert COMMITS (pushes the row) but returns an error (ack lost).
  loseNextInsertAck: true,
  insertCalls: 0,
}));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    rpc: async () => ({ data: { id: "srv-p1", status: "Submitted" }, error: null }),
    storage: { from: () => ({ upload: async () => ({ error: null }), download: async () => ({ data: null, error: null }) }) },
    from: (table: string) => {
      let op: string | null = null;
      let payload: Record<string, unknown> | null = null;
      const b = {
        insert(row: Record<string, unknown>) { op = "insert"; payload = row; return b; },
        update() { op = op ?? "update"; return b; },
        select() { op = op ?? "select"; return b; },
        eq() { return b; },
        limit() { return b; },
        single() { return b; },
        then(resolve: (v: unknown) => void) {
          if (table !== "audit_log") return resolve({ data: null, error: null });
          if (op === "select") {
            const matches = store.auditRows.filter(
              (r) => r.entity_id === "srv-p1" && r.action_type === "ACTING_AS_TREASURER"
            );
            return resolve({ data: matches.map((m) => ({ id: m.id })), error: null });
          }
          // insert
          store.insertCalls++;
          store.auditRows.push({
            id: `aud-${store.auditRows.length + 1}`,
            entity_id: "srv-p1",
            action_type: "ACTING_AS_TREASURER",
            user_id: String(payload?.user_id ?? ""),
          });
          if (store.loseNextInsertAck) {
            store.loseNextInsertAck = false;
            return resolve({ data: null, error: { message: "network lost after commit" } }); // ack lost
          }
          return resolve({ data: [{ id: "aud-ok" }], error: null });
        },
      };
      return b;
    },
  }),
}));

import { db, type LocalPeriod } from "@/db/schema";
import { syncPending } from "@/utils/syncEngine";

function makePeriod(over: Partial<LocalPeriod> = {}): LocalPeriod {
  const ts = new Date().toISOString();
  return {
    localId: "p1", naturalKey: "cong1|2020-01-W1|AM", serverId: null,
    congregationId: "cong1", year: 2020, month: 1, week: 1, weekKey: "2020-01-W1",
    service: "AM", status: "Submitted", submittedAt: ts, capturedByUserId: "user1",
    requestorComment: null, elderApprovalComment: null,
    depositBlob: null, depositFileName: null, depositDate: null, depositBankRef: null,
    localStatus: "pending", createdAt: ts, updatedAt: ts, syncAttempts: 0, lastError: null,
    actingAsRole: "Chairperson", actingAsAuditedAt: null,
    ...over,
  };
}

beforeEach(async () => {
  vi.stubGlobal("navigator", { onLine: true });
  await db.periods.clear();
  await db.lineItems.clear();
  await db.syncMeta.clear();
  store.auditRows = [];
  store.loseNextInsertAck = true;
  store.insertCalls = 0;
});

describe("acting-as audit: idempotent replay after a lost ack", () => {
  it("does not duplicate the event on retry; marks it flushed once the committed row is found", async () => {
    await db.periods.add(makePeriod());

    // Attempt 1: the insert commits server-side but the ack is lost -> period stays retryable.
    const r1 = await syncPending();
    expect(r1.failed).toBe(1);
    expect((await db.periods.get("p1"))?.actingAsAuditedAt).toBeFalsy();
    expect(store.auditRows).toHaveLength(1); // the row DID commit
    expect(store.insertCalls).toBe(1);

    // Retry (after backoff): the pre-insert lookup finds the committed row -> NO second insert.
    const r2 = await syncPending(new Date(Date.now() + 10 * 60_000));
    expect(r2.synced).toBe(1);
    expect((await db.periods.get("p1"))?.actingAsAuditedAt).toBeTruthy();
    expect(store.auditRows).toHaveLength(1); // still exactly one — no duplicate
    expect(store.insertCalls).toBe(1); // insert was NOT called again
  });
});
