// Task 8 (Mark Banked eligibility guard) + Task 12 (edit) exercised against the REAL capture
// repository on fake-indexeddb. No Supabase. Proves: no-eligible-cash is a no-op, burial cash
// is eligible, double-banking is prevented, and an edit via updateLineItem marks a previously
// synced row pending while preserving its capture date and proof fields.
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/db/schema";
import {
  getOrCreateLocalPeriod,
  addLineItem,
  markCashBanked,
  eligibleCashItems,
  updateLineItem,
  getLineItems,
  attachProof,
} from "@/db/captureRepo";

const DEP = () => ({ blob: new Blob(["slip"], { type: "image/jpeg" }), fileName: "d.jpg", date: "2026-10-09", bankRef: "DEP1" });

async function newPeriod() {
  return getOrCreateLocalPeriod({
    congregationId: "c1", weekKey: "2020-01-W1", service: "AM",
    year: 2020, month: 1, week: 1, userId: "u1",
  });
}

beforeEach(async () => {
  await db.periods.clear();
  await db.lineItems.clear();
  await db.syncMeta.clear();
});

describe("Task 8 - Mark Banked eligibility", () => {
  it("banks eligible cash + burial, returns the count, sets the deposit, excludes EFT/DD", async () => {
    const p = await newPeriod();
    await addLineItem(p.localId, "Members", { officer_id: "A", type: "Cash", amount: 100 });
    await addLineItem(p.localId, "Burial", { amount: 50, receipt_number: "R1" });
    await addLineItem(p.localId, "Members", { officer_id: "A", type: "EFT", amount: 200, transaction_date: "2020-01-01" });

    const n = await markCashBanked(p.localId, DEP());
    expect(n).toBe(2);
    const items = await getLineItems(p.localId);
    expect(items.filter((i) => i.item_type === "CashBanked")).toHaveLength(2);
    expect(items.find((i) => i.item_type === "EFT")).toBeTruthy(); // EFT untouched
    const fresh = await db.periods.get(p.localId);
    expect(fresh?.depositBlob).toBeTruthy();
  });

  it("is a no-op when there is no eligible pending cash (returns 0, writes no deposit)", async () => {
    const p = await newPeriod();
    await addLineItem(p.localId, "Members", { officer_id: "A", type: "EFT", amount: 200, transaction_date: "2020-01-01" });
    const n = await markCashBanked(p.localId, DEP());
    expect(n).toBe(0);
    const fresh = await db.periods.get(p.localId);
    expect(fresh?.depositBlob).toBeFalsy(); // no deposit proof created
    expect(fresh?.depositObjectKey ?? null).toBeNull();
  });

  it("prevents double-banking: a second Mark Banked finds nothing eligible and leaves the deposit unchanged", async () => {
    const p = await newPeriod();
    await addLineItem(p.localId, "Members", { officer_id: "A", type: "Cash", amount: 100 });
    const first = await markCashBanked(p.localId, DEP());
    expect(first).toBe(1);
    const afterFirst = await db.periods.get(p.localId);
    const key1 = afterFirst?.depositObjectKey;

    const second = await markCashBanked(p.localId, { blob: new Blob(["slip2"], { type: "image/jpeg" }), fileName: "d2.jpg" });
    expect(second).toBe(0); // already banked => not eligible
    const afterSecond = await db.periods.get(p.localId);
    expect(afterSecond?.depositObjectKey).toBe(key1); // deposit not replaced
  });

  it("eligibleCashItems classifies cash/burial as eligible, EFT/DD/CashBanked as not", async () => {
    const p = await newPeriod();
    await addLineItem(p.localId, "Members", { officer_id: "A", type: "Cash", amount: 10 });
    await addLineItem(p.localId, "Officers", { officer_id: "B", type: "DirectDebit", amount: 20, transaction_date: "2020-01-01" });
    await addLineItem(p.localId, "Burial", { amount: 5, receipt_number: "R1" });
    const items = await getLineItems(p.localId);
    const eligible = eligibleCashItems(items);
    expect(eligible).toHaveLength(2); // cash + burial, not the DD
  });
});

describe("Task 12 - edit marks a synced row pending and preserves capture date + proof", () => {
  it("cash amount edit: amount changes, transaction_date + proof preserved, localStatus -> pending", async () => {
    const p = await newPeriod();
    const localId = await addLineItem(p.localId, "Members", { officer_id: "A", type: "Cash", amount: 100 });
    // simulate an earlier successful sync of this exact version
    await db.lineItems.update(localId, {
      serverId: "srv-1", localStatus: "synced",
      proofBlob: null, proof_status: "Deposited", proofObjectKey: "k1", transaction_date: "2026-10-03",
    });

    await updateLineItem(localId, { amount: 123 });
    const item = await db.lineItems.get(localId);
    expect(item?.amount).toBe(123);
    expect(item?.transaction_date).toBe("2026-10-03"); // capture date preserved
    expect(item?.proofObjectKey).toBe("k1"); // proof identity untouched
    expect(item?.localStatus).toBe("pending"); // re-queued, not falsely acknowledged
    expect(item?.serverId).toBe("srv-1"); // server id retained
  });
});

describe("Task 1 - future transaction-date guard (repo backstop)", () => {
  it("rejects a future EFT transaction date in addLineItem", async () => {
    const p = await newPeriod();
    await expect(
      addLineItem(p.localId, "Members", { officer_id: "A", type: "EFT", amount: 100, transaction_date: "2999-01-01" })
    ).rejects.toThrow(/future/i);
  });

  it("allows a past EFT transaction date in addLineItem", async () => {
    const p = await newPeriod();
    const id = await addLineItem(p.localId, "Members", { officer_id: "A", type: "EFT", amount: 100, transaction_date: "2000-01-01" });
    expect(id).toBeTruthy();
  });

  it("rejects a future transaction date when editing an EFT entry via updateLineItem", async () => {
    const p = await newPeriod();
    const id = await addLineItem(p.localId, "Members", { officer_id: "A", type: "EFT", amount: 100, transaction_date: "2000-01-01" });
    await expect(updateLineItem(id, { transaction_date: "2999-01-01" })).rejects.toThrow(/future/i);
  });
});

describe("Task 2 - editing after proof uploaded preserves historical proof metadata", () => {
  it("changing transaction_date on a synced, proofed EFT entry preserves proof identity/date and re-queues the row", async () => {
    const p = await newPeriod();
    const id = await addLineItem(p.localId, "Members", { officer_id: "A", type: "EFT", amount: 100, transaction_date: "2020-01-01" });
    // simulate a synced entry whose proof was already uploaded/acknowledged
    await db.lineItems.update(id, {
      serverId: "srv-1", localStatus: "synced",
      proof_status: "Deposited", proofBlob: null,
      proofObjectKey: "k1", proofHash: "h1", proofDate: "2020-01-01",
    });
    // correct ONLY the transaction date (date changed AFTER proof uploaded)
    await updateLineItem(id, { transaction_date: "2020-02-02" });
    const item = await db.lineItems.get(id);
    expect(item?.transaction_date).toBe("2020-02-02"); // transaction date corrected
    expect(item?.proofDate).toBe("2020-01-01");         // historical proof metadata preserved
    expect(item?.proofObjectKey).toBe("k1");            // proof identity untouched
    expect(item?.proofHash).toBe("h1");
    expect(item?.localStatus).toBe("pending");          // row re-queued, not falsely synced
  });
});

describe("Task 4 - proof replacement produces a fresh version bound to corrected values", () => {
  it("replace = updateLineItem(amount/date) + attachProof(new) -> new proof key, bytes pending, row pending", async () => {
    const p = await newPeriod();
    const id = await addLineItem(p.localId, "Members", { officer_id: "A", type: "EFT", amount: 100, transaction_date: "2020-01-01" });
    // a previously synced, proofed entry
    await db.lineItems.update(id, { serverId: "srv-1", localStatus: "synced", proof_status: "Deposited", proofBlob: null, proofObjectKey: "k1", proofHash: "h1" });
    // atomic replace commits the corrected values together with fresh proof bytes
    await updateLineItem(id, { amount: 250, transaction_date: "2020-02-02" });
    await attachProof(id, { blob: new Blob(["NEWPROOF"], { type: "image/jpeg" }), fileName: "n.jpg", date: "2020-02-02", bankRef: null });
    const item = await db.lineItems.get(id);
    expect(item?.amount).toBe(250);
    expect(item?.transaction_date).toBe("2020-02-02");
    expect(item?.proofObjectKey).not.toBe("k1"); // fresh proof version
    expect(item?.proofBlob).toBeTruthy();         // new bytes await sync
    expect(item?.localStatus).toBe("pending");    // re-queued, not falsely complete
  });
});

describe("Task 2 - future service create guard (repo)", () => {
  it("blocks creating a new future-dated period, allows a past one", async () => {
    await expect(
      getOrCreateLocalPeriod({ congregationId: "c1", weekKey: "2999-01-W1", service: "AM", year: 2999, month: 1, week: 1, userId: "u1" })
    ).rejects.toThrow(/future/i);
    const past = await getOrCreateLocalPeriod({ congregationId: "c1", weekKey: "2020-02-W1", service: "AM", year: 2020, month: 2, week: 1, userId: "u1" });
    expect(past).toBeTruthy();
  });
});
