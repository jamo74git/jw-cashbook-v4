// Task 3: proof-version binding. Proves the uploaded object KEY, the uploaded BYTES, and the
// attachment METADATA (transaction date + bank reference) all belong to the SAME proof version
// (read together in one fresh transaction at bind time) - for both individual line-item proofs
// and the shared deposit slip. The "acknowledgement cannot clear a NEWER local proof" interleave
// is covered in syncEngine.retention.test.ts (R01 individual + Area1 shared slip).
//
// LIMITATION: this harness uses fake-indexeddb + a mocked Supabase. It verifies CLIENT-SIDE
// version coherence only; it does NOT exercise effective Supabase RLS / Storage behaviour.
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, vi } from "vitest";

const rec = vi.hoisted(() => ({
  uploads: [] as { path: string; bytes: string }[],
  attachInserts: [] as Record<string, unknown>[],
}));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    rpc: async () => ({ data: { id: "srv-p1", status: "Draft" }, error: null }),
    storage: {
      from: () => ({
        upload: async (path: string, blob: Blob) => {
          rec.uploads.push({ path, bytes: await blob.text() });
          return { data: { path }, error: null };
        },
        download: async () => ({ data: null, error: null }),
      }),
    },
    from: (table: string) => {
      let op: string | null = null;
      const b = {
        upsert() { op = "upsert"; return b; },
        insert(v: Record<string, unknown>) {
          op = "insert";
          if (table === "cashbook_attachment") rec.attachInserts.push(v);
          return b;
        },
        update() { op = op ?? "update"; return b; },
        select() { return b; },
        eq() { return b; },
        limit() { return b; },
        single() { return b; },
        then(resolve: (v: unknown) => void) {
          if (table === "cashbook_line_item") {
            return resolve(op === "upsert" ? { data: { id: "srv-li-1" }, error: null } : { data: [{ id: "srv-li-1" }], error: null });
          }
          if (table === "cashbook_attachment") {
            return resolve(op === "insert" ? { data: [{ id: "att-1" }], error: null } : { data: [], error: null });
          }
          if (table === "cashbook_period") return resolve({ data: [{ id: "srv-p1" }], error: null });
          return resolve({ data: null, error: null });
        },
      };
      return b;
    },
  }),
}));

import { db, type LocalPeriod, type LocalLineItem } from "@/db/schema";
import { syncPending } from "@/utils/syncEngine";

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
    localId: "li1", periodLocalId: "p1", serverId: null, section: "Members",
    is_officer: false, item_type: "EFT", payment_type: "EFT", officer_id: "A",
    amount: 10, item_count: null, receipt_number: null, manual_reference: null,
    transaction_date: "2026-11-05", proof_status: null, proof_reference: null,
    proofBlob: null, proofFileName: null, proofBankRef: null, proofDate: null,
    localStatus: "pending", proofObjectKey: null, proofHash: null, proofSize: null,
    ...over,
  };
}

beforeEach(async () => {
  vi.stubGlobal("navigator", { onLine: true });
  await db.periods.clear();
  await db.lineItems.clear();
  await db.syncMeta.clear();
  rec.uploads = [];
  rec.attachInserts = [];
});

describe("Task 3: individual proof version binding", () => {
  it("uploads the current key + bytes and writes attachment date/bankRef from the SAME version", async () => {
    await db.periods.add(makePeriod());
    await db.lineItems.add(makeItem({
      proofBlob: new Blob(["NEWbytes"], { type: "image/jpeg" }),
      proofFileName: "p.jpg",
      proofObjectKey: "li1-keyNEW-proof.jpg",
      proofHash: "hashNEW",
      proofSize: 8,
      proofDate: "2026-11-01",
      proofBankRef: "REF-NEW",
    }));
    await syncPending();
    expect(rec.uploads).toHaveLength(1);
    expect(rec.uploads[0].path).toContain("li1-keyNEW-proof.jpg");
    expect(rec.uploads[0].bytes).toBe("NEWbytes");
    expect(rec.attachInserts).toHaveLength(1);
    expect(rec.attachInserts[0].file_url).toContain("li1-keyNEW-proof.jpg");
    expect(rec.attachInserts[0].transaction_date).toBe("2026-11-01");
    expect(rec.attachInserts[0].bank_reference).toBe("REF-NEW");
  });
});

describe("Task 3: shared deposit slip version binding", () => {
  it("uploads the current slip key + bytes and writes attachment date/bankRef from the SAME version", async () => {
    await db.periods.add(makePeriod({
      depositBlob: new Blob(["SLIP"], { type: "image/jpeg" }),
      depositFileName: "d.jpg",
      depositObjectKey: "p1-depNEW-deposit-slip.jpg",
      depositHash: "depHashNEW",
      depositSize: 4,
      depositDate: "2026-11-02",
      depositBankRef: "DEP-REF",
    }));
    await db.lineItems.add(makeItem({
      localId: "li1", item_type: "CashBanked", payment_type: "CashBanked",
      serverId: "srv-li-1", localStatus: "synced", proofBlob: null, officer_id: null,
    }));
    await syncPending();
    expect(rec.uploads).toHaveLength(1);
    expect(rec.uploads[0].path).toContain("p1-depNEW-deposit-slip.jpg");
    expect(rec.uploads[0].bytes).toBe("SLIP");
    expect(rec.attachInserts).toHaveLength(1);
    expect(rec.attachInserts[0].transaction_date).toBe("2026-11-02");
    expect(rec.attachInserts[0].bank_reference).toBe("DEP-REF");
  });
});

describe("Task 11: proof transaction-date fallback", () => {
  it("uses the item transaction_date for the attachment when proofDate is not set (new attachment)", async () => {
    await db.periods.add(makePeriod());
    await db.lineItems.add(makeItem({
      proofBlob: new Blob(["bytes"], { type: "image/jpeg" }),
      proofFileName: "p.jpg",
      proofObjectKey: "li1-k-proof.jpg",
      proofHash: "h", proofSize: 5,
      proofDate: null, // no explicit proof date captured
      transaction_date: "2026-11-05",
      proofBankRef: null,
    }));
    await syncPending();
    expect(rec.attachInserts).toHaveLength(1);
    // Bound from the same fresh read: falls back to the item transaction_date.
    expect(rec.attachInserts[0].transaction_date).toBe("2026-11-05");
  });
});
