// Tranche 4 r2 (R01/R02/R03/R06/R09): proof identity/path + sync acknowledgement harness.
// Env: Vitest (node). Dexie on fake-indexeddb; the Supabase client is mocked with
// configurable per-operation results, affected-row shapes, a download stub for duplicate
// verification, and an interleave hook that fires just before local finalisation.
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, vi } from "vitest";

const mock = vi.hoisted(() => ({
  rpc: { data: { id: "srv-p1", status: "Draft" } as unknown, error: null as unknown },
  upload: { data: { path: "x" } as unknown, error: null as unknown },
  download: { data: null as unknown, error: null as unknown },
  lineUpsert: { data: { id: "srv-li-1" } as unknown, error: null as unknown },
  lineStatus: { data: [{ id: "srv-li-1" }] as unknown, error: null as unknown },
  attachSelect: { data: [] as unknown, error: null as unknown },
  attachInsert: { data: [{ id: "att-1" }] as unknown, error: null as unknown },
  periodUpdate: { data: [{ id: "srv-p1" }] as unknown, error: null as unknown },
  auditInsert: { data: [{ id: "aud-1" }] as unknown, error: null as unknown },
  beforeStatusResolve: null as null | (() => Promise<void> | void),
}));

function resultFor(table: string, op: string | null): unknown {
  if (table === "cashbook_line_item") return op === "upsert" ? mock.lineUpsert : mock.lineStatus;
  if (table === "cashbook_attachment") return op === "insert" ? mock.attachInsert : mock.attachSelect;
  if (table === "cashbook_period") return mock.periodUpdate;
  if (table === "audit_log") return mock.auditInsert;
  return { data: null, error: null };
}

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    rpc: async () => mock.rpc,
    storage: {
      from: () => ({
        upload: async () => mock.upload,
        download: async () => mock.download,
      }),
    },
    from: (table: string) => {
      let op: string | null = null;
      const b = {
        upsert() { op = "upsert"; return b; },
        insert() { op = "insert"; return b; },
        update() { op = op ?? "update"; return b; },
        select() { op = op ?? "select"; return b; },
        eq() { return b; },
        limit() { return b; },
        single() { return b; },
        then(resolve: (v: unknown) => void) {
          const finish = () => resolve(resultFor(table, op));
          if (table === "cashbook_line_item" && op === "update" && mock.beforeStatusResolve) {
            Promise.resolve(mock.beforeStatusResolve()).then(finish);
          } else {
            finish();
          }
        },
      };
      return b;
    },
  }),
}));

import { db, type LocalPeriod, type LocalLineItem } from "@/db/schema";
import { buildProofPath, syncPending } from "@/utils/syncEngine";
import * as capture from "@/db/captureRepo";

function makePeriod(over: Partial<LocalPeriod> = {}): LocalPeriod {
  const ts = new Date().toISOString();
  return {
    localId: "p1", naturalKey: "cong1|2020-01-W1|AM", serverId: null,
    congregationId: "cong1", year: 2020, month: 1, week: 1, weekKey: "2020-01-W1",
    service: "AM", status: "Draft", submittedAt: null, capturedByUserId: "user1",
    requestorComment: null, elderApprovalComment: null,
    depositBlob: null, depositFileName: null, depositDate: null, depositBankRef: null,
    localStatus: "pending", createdAt: ts, updatedAt: ts, syncAttempts: 0, lastError: null,
    ...over,
  };
}
function makeItem(over: Partial<LocalLineItem> = {}): LocalLineItem {
  return {
    localId: "li1", periodLocalId: "p1", serverId: null, section: "Expenses",
    is_officer: false, item_type: "Expense", payment_type: "Expense", officer_id: null,
    amount: 10, item_count: null, receipt_number: null, manual_reference: "x",
    transaction_date: "2026-10-20", proof_status: null, proof_reference: null,
    proofBlob: new Blob(["img"], { type: "image/jpeg" }), proofFileName: "p.jpg",
    proofBankRef: null, proofDate: null, localStatus: "pending",
    proofObjectKey: "li1-keyA-proof.jpg", proofHash: "hashA", proofSize: 3,
    ...over,
  };
}

beforeEach(async () => {
  vi.stubGlobal("navigator", { onLine: true });
  await db.periods.clear();
  await db.lineItems.clear();
  await db.syncMeta.clear();
  mock.rpc = { data: { id: "srv-p1", status: "Draft" }, error: null };
  mock.upload = { data: { path: "x" }, error: null };
  mock.download = { data: null, error: null };
  mock.lineUpsert = { data: { id: "srv-li-1" }, error: null };
  mock.lineStatus = { data: [{ id: "srv-li-1" }], error: null };
  mock.attachSelect = { data: [], error: null };
  mock.attachInsert = { data: [{ id: "att-1" }], error: null };
  mock.periodUpdate = { data: [{ id: "srv-p1" }], error: null };
  mock.auditInsert = { data: [{ id: "aud-1" }], error: null };
  mock.beforeStatusResolve = null;
});

describe("buildProofPath (item 4)", () => {
  const period = {
    congregationId: "cong1", year: 2026, month: 10, service: "AM" as const,
    weekKey: "2026-10-W3", capturedByUserId: "user1",
  };
  it("lays out cong/year/month/service_weekKey/userId/file for policy parsing", () => {
    expect(buildProofPath(period, "abc-proof.jpg")).toBe("cong1/2026/10/AM_2026-10-W3/user1/abc-proof.jpg");
  });
  it("pads month and keeps distinct stable keys distinct", () => {
    expect(buildProofPath({ ...period, month: 3 }, "k.jpg")).toContain("/03/");
    expect(buildProofPath(period, "k1.jpg")).not.toBe(buildProofPath(period, "k2.jpg"));
  });
});

describe("acknowledgement (R01/R02/R03)", () => {
  it("retains the Blob + marks retryable when the attachment insert fails (R03)", async () => {
    await db.periods.add(makePeriod());
    await db.lineItems.add(makeItem());
    mock.attachInsert = { data: null, error: { message: "attach fail" } };
    const r = await syncPending();
    expect(r.failed).toBe(1);
    const li = await db.lineItems.get("li1");
    expect(li?.proofBlob).not.toBeNull();
    const p = await db.periods.get("p1");
    expect(p?.localStatus).toBe("failed");
  });

  it("fails (no false synced) when the upsert returns no server id (R02)", async () => {
    await db.periods.add(makePeriod());
    await db.lineItems.add(makeItem({ serverId: null }));
    mock.lineUpsert = { data: null, error: null }; // missing required id
    const r = await syncPending();
    expect(r.failed).toBe(1);
    const li = await db.lineItems.get("li1");
    expect(li?.proofBlob).not.toBeNull();
    expect((await db.periods.get("p1"))?.localStatus).toBe("failed");
  });

  it("does not release bytes when the status update affects zero rows (R03)", async () => {
    await db.periods.add(makePeriod());
    await db.lineItems.add(makeItem());
    mock.lineStatus = { data: [], error: null }; // 0 rows, no error
    const r = await syncPending();
    expect(r.failed).toBe(1);
    expect((await db.lineItems.get("li1"))?.proofBlob).not.toBeNull();
  });

  it("releases the Blob + stable key on a fully acknowledged pass", async () => {
    await db.periods.add(makePeriod());
    await db.lineItems.add(makeItem());
    const r = await syncPending();
    expect(r.synced).toBe(1);
    const li = await db.lineItems.get("li1");
    expect(li?.proofBlob).toBeNull();
    expect(li?.proof_status).toBe("Deposited");
  });

  it("R01: a replacement arriving between ack and clear keeps the NEW bytes pending", async () => {
    await db.periods.add(makePeriod());
    await db.lineItems.add(makeItem());
    // Simulate capture replacing bytes + identity just before local finalisation.
    mock.beforeStatusResolve = async () => {
      await db.lineItems.update("li1", {
        proofObjectKey: "li1-keyNEW-proof.jpg",
        proofBlob: new Blob(["NEW"], { type: "image/jpeg" }),
        proofHash: "hashNEW",
      });
    };
    const r = await syncPending();
    const li = await db.lineItems.get("li1");
    expect(li?.proofObjectKey).toBe("li1-keyNEW-proof.jpg");
    expect(li?.proofBlob).not.toBeNull(); // replacement bytes survive
    const p = await db.periods.get("p1");
    expect(p?.localStatus).not.toBe("synced"); // parent not falsely synced
    expect(r.synced).toBe(0);
  });
});

async function sha(bytesStr: string) {
  const blob = new Blob([bytesStr], { type: "image/jpeg" });
  const buf = await blob.arrayBuffer();
  const d = await globalThis.crypto.subtle.digest("SHA-256", buf);
  const hash = Array.from(new Uint8Array(d)).map((x) => x.toString(16).padStart(2, "0")).join("");
  return { blob, hash, size: blob.size };
}

describe("duplicate verification (R06)", () => {
  it("treats a byte-identical existing object as idempotent success", async () => {
    const dup = await sha("identical-bytes");
    await db.periods.add(makePeriod());
    await db.lineItems.add(makeItem({ proofBlob: dup.blob, proofHash: dup.hash, proofSize: dup.size }));
    mock.upload = { data: null, error: { message: "The resource already exists", statusCode: "409" } };
    mock.download = { data: dup.blob, error: null };
    const r = await syncPending();
    expect(r.synced).toBe(1);
    expect((await db.lineItems.get("li1"))?.proofBlob).toBeNull();
  });

  it("retains bytes when an existing object's content differs (R06)", async () => {
    const mine = await sha("my-bytes");
    const other = await sha("someone-elses-bytes");
    await db.periods.add(makePeriod());
    await db.lineItems.add(makeItem({ proofBlob: mine.blob, proofHash: mine.hash, proofSize: mine.size }));
    mock.upload = { data: null, error: { message: "Duplicate", statusCode: "409" } };
    mock.download = { data: other.blob, error: null }; // different content
    const r = await syncPending();
    expect(r.failed).toBe(1);
    expect((await db.lineItems.get("li1"))?.proofBlob).not.toBeNull();
  });
});

describe("blocked side effects (R09)", () => {
  it("writes NO server metadata and retains bytes when parent already Submitted", async () => {
    mock.rpc = { data: { id: "srv-p1", status: "Submitted" }, error: null };
    await db.periods.add(makePeriod({ status: "Submitted" }));
    await db.lineItems.add(makeItem({ serverId: null }));
    const r = await syncPending();
    expect(r.blocked).toBe(1);
    const li = await db.lineItems.get("li1");
    expect(li?.proofBlob).not.toBeNull();
    expect(li?.serverId).toBeNull(); // no upsert => no server metadata write
    expect((await db.periods.get("p1"))?.localStatus).toBe("failed");
  });

  it("fails closed (conflict) for a later Overseer status without remapping workflow", async () => {
    mock.rpc = { data: { id: "srv-p1", status: "SubmittedToOverseer" }, error: null };
    await db.periods.add(makePeriod({ status: "Submitted" }));
    await db.lineItems.add(makeItem({ serverId: null }));
    const r = await syncPending();
    expect(r.conflicts).toBe(1);
    expect((await db.lineItems.get("li1"))?.serverId).toBeNull();
  });

  it("retains the deposit slip when not every banked item is acked", async () => {
    await db.periods.add(makePeriod({ depositBlob: new Blob(["slip"], { type: "image/jpeg" }), depositFileName: "d.jpg" }));
    const r = await syncPending();
    expect(r.failed).toBe(1);
    expect((await db.periods.get("p1"))?.depositBlob).not.toBeNull();
  });
});

describe("Tranche 4 round-2 (Area 1/2/3)", () => {
  it("Area1 shared slip: a deposit replacement between upload and clear retains the NEW slip", async () => {
    await db.periods.add(makePeriod({
      depositBlob: new Blob(["slipOLD"], { type: "image/jpeg" }), depositFileName: "d.jpg",
      depositObjectKey: "p1-depA-deposit-slip.jpg", depositHash: "depHashA", depositSize: 7,
    }));
    await db.lineItems.add(makeItem({ localId: "li1", item_type: "CashBanked", serverId: "srv-li-1", proofBlob: null }));
    mock.beforeStatusResolve = async () => {
      await db.periods.update("p1", {
        depositObjectKey: "p1-depNEW-deposit-slip.jpg",
        depositBlob: new Blob(["slipNEW"], { type: "image/jpeg" }),
        depositHash: "depHashNEW",
      });
    };
    const r = await syncPending();
    const p = await db.periods.get("p1");
    expect(p?.depositObjectKey).toBe("p1-depNEW-deposit-slip.jpg");
    expect(p?.depositBlob).not.toBeNull(); // newer slip bytes survive
    expect(p?.localStatus).not.toBe("synced");
    expect(r.synced).toBe(0);
  });

  it("Area2: a locked period with unacknowledged (un-pushed) capture is NOT marked synced", async () => {
    mock.rpc = { data: { id: "srv-p1", status: "Submitted" }, error: null };
    await db.periods.add(makePeriod({ status: "Submitted" }));
    await db.lineItems.add(makeItem({ serverId: null, proofBlob: null })); // no proof, never pushed
    const r = await syncPending();
    expect(r.conflicts).toBe(1);
    const p = await db.periods.get("p1");
    expect(p?.localStatus).toBe("conflict");
    expect((await db.lineItems.get("li1"))?.serverId).toBeNull(); // no server write
  });

  it("Area3: a zero-row period submission is not reported successful", async () => {
    await db.periods.add(makePeriod({ status: "Submitted" }));
    await db.lineItems.add(makeItem({ proofBlob: null }));
    mock.periodUpdate = { data: [], error: null }; // RLS-filtered: 0 rows, no error
    const r = await syncPending();
    expect(r.failed).toBe(1);
    expect((await db.periods.get("p1"))?.localStatus).toBe("failed");
  });

  it("Area3: a zero-row acting-as audit insert is not reported flushed", async () => {
    await db.periods.add(makePeriod({ status: "Submitted", actingAsRole: "Chairperson", actingAsAuditedAt: null }));
    await db.lineItems.add(makeItem({ proofBlob: null }));
    mock.auditInsert = { data: [], error: null }; // 0 rows, no error
    const r = await syncPending();
    expect(r.failed).toBe(1);
    const p = await db.periods.get("p1");
    expect(p?.actingAsAuditedAt).toBeFalsy(); // not marked flushed
  });
});

describe("locked-period CURRENT-version acknowledgement (Task 1 / Task 2)", () => {
  it("Task1: a synced item edited via the real repo path is NOT reported synced on a locked period", async () => {
    mock.rpc = { data: { id: "srv-p1", status: "Submitted" }, error: null };
    await db.periods.add(makePeriod({ status: "Submitted", localStatus: "pending" }));
    // previously-synced item: has a serverId and is in the synced state, no pending proof.
    await db.lineItems.add(makeItem({ serverId: "srv-li-1", localStatus: "synced", proofBlob: null, amount: 10 }));
    // real capture repository update path flips the acknowledged row back to pending.
    await capture.updateLineItem("li1", { amount: 999 });
    expect((await db.lineItems.get("li1"))?.localStatus).toBe("pending");

    const r = await syncPending();
    expect(r.conflicts).toBe(1);
    expect(r.synced).toBe(0);
    const p = await db.periods.get("p1");
    expect(p?.localStatus).toBe("conflict"); // actionable, not falsely synced
    expect((await db.lineItems.get("li1"))?.amount).toBe(999); // local edit preserved
  });

  it("a genuinely acknowledged locked period (all items synced, no proof, no acting-as) is synced, not blocked", async () => {
    mock.rpc = { data: { id: "srv-p1", status: "Submitted" }, error: null };
    await db.periods.add(makePeriod({ status: "Submitted", localStatus: "pending" }));
    await db.lineItems.add(makeItem({ serverId: "srv-li-1", localStatus: "synced", proofBlob: null }));
    const r = await syncPending();
    expect(r.synced).toBe(1);
    expect((await db.periods.get("p1"))?.localStatus).toBe("synced");
  });

  it("Task2: a locked period with an unacknowledged acting-as audit is not falsely synced, then flushes on retry", async () => {
    mock.rpc = { data: { id: "srv-p1", status: "Submitted" }, error: null };
    await db.periods.add(makePeriod({
      status: "Submitted", localStatus: "pending", actingAsRole: "Chairperson", actingAsAuditedAt: null,
    }));
    await db.lineItems.add(makeItem({ serverId: "srv-li-1", localStatus: "synced", proofBlob: null }));

    // First attempt: audit insert returns zero rows -> must NOT be synced; stays retryable.
    mock.auditInsert = { data: [], error: null };
    const r1 = await syncPending();
    expect(r1.synced).toBe(0);
    expect(r1.failed).toBe(1);
    expect((await db.periods.get("p1"))?.actingAsAuditedAt).toBeFalsy();

    // Retry (after backoff): audit insert succeeds -> audit flushed, period synced.
    mock.auditInsert = { data: [{ id: "aud-1" }], error: null };
    const r2 = await syncPending(new Date(Date.now() + 10 * 60_000));
    expect((await db.periods.get("p1"))?.actingAsAuditedAt).toBeTruthy();
    expect(r2.synced).toBe(1);
  });
});

describe("Task 1 - zero-value (no line-item) submission sync", () => {
  it("a Submitted period with NO line items syncs: server period acknowledged, marked synced", async () => {
    await db.periods.add(makePeriod({ status: "Submitted", localStatus: "pending" }));
    // no line items (zero-value R0 "No tithing" period)
    const r = await syncPending();
    expect(r.synced).toBe(1);
    const p = await db.periods.get("p1");
    expect(p?.localStatus).toBe("synced");
    expect(p?.serverId).toBe("srv-p1"); // reached the server -> visible to the Auditor queue
  });

  it("a zero-value submission whose server period update affects 0 rows is NOT reported synced", async () => {
    await db.periods.add(makePeriod({ status: "Submitted", localStatus: "pending" }));
    mock.periodUpdate = { data: [], error: null }; // not acknowledged (e.g. RLS-filtered)
    const r = await syncPending();
    expect(r.synced).toBe(0);
    expect(r.failed).toBe(1);
    expect((await db.periods.get("p1"))?.localStatus).toBe("failed"); // shown truthfully as not synced
  });
});

describe("Task 2 - future-dated period is skipped by sync (never auto-submitted)", () => {
  it("a future-dated Submitted period is skipped, left pending/local", async () => {
    await db.periods.add(makePeriod({ year: 2999, month: 1, week: 1, weekKey: "2999-01-W1", naturalKey: "cong1|2999-01-W1|AM", status: "Submitted", localStatus: "pending" }));
    const r = await syncPending();
    expect(r.skipped).toBe(1);
    expect(r.synced).toBe(0);
    expect((await db.periods.get("p1"))?.localStatus).toBe("pending"); // preserved, not submitted to server
  });
});

describe("Manual sync - congregation isolation", () => {
  it("syncPending(now, congregationId) only processes that congregation's pending work", async () => {
    await db.periods.add(makePeriod({ localId: "pA", naturalKey: "congA|2020-01-W1|AM", congregationId: "congA", status: "Submitted", localStatus: "pending" }));
    await db.periods.add(makePeriod({ localId: "pB", naturalKey: "congB|2020-01-W1|AM", congregationId: "congB", status: "Submitted", localStatus: "pending" }));
    const r = await syncPending(new Date(), "congA");
    expect(r.synced).toBe(1); // only congA attempted/acknowledged
    expect((await db.periods.get("pA"))?.localStatus).toBe("synced");
    expect((await db.periods.get("pB"))?.localStatus).toBe("pending"); // other congregation untouched
  });
});
