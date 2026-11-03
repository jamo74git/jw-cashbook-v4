// Regression coverage for the per-officer grouped capture view (Members + Officers).
// Guards: association by officer_id, per-group subtotals, 3-way Cash/DD/EFT COUNTS + amounts,
// unrecognised-type ("other") bucket, reconciliation to the group total, unassigned bucket,
// and stable ordering. Counts are captured entries, NOT distinct people.
import { describe, it, expect } from "vitest";
import { groupItemsByOfficer, type GroupableItem } from "@/lib/captureGrouping";

const it1 = (p: Partial<GroupableItem>): GroupableItem => ({
  officer_id: null,
  item_type: "Cash",
  amount: 0,
  ...p,
});

describe("groupItemsByOfficer", () => {
  it("groups Member entries by their priest (officer_id) across two priestships", () => {
    const items = [
      it1({ officer_id: "A", item_type: "Cash", amount: 100 }),
      it1({ officer_id: "A", item_type: "EFT", amount: 50 }),
      it1({ officer_id: "B", item_type: "DirectDebit", amount: 200 }),
    ];
    const groups = groupItemsByOfficer(items, [{ id: "A" }, { id: "B" }]);
    expect(groups.map((g) => g.officerId)).toEqual(["A", "B"]);
    expect(groups[0].items).toHaveLength(2);
    expect(groups[1].items).toHaveLength(1);
  });

  it("computes the 3-way Cash / DD / EFT counts + amounts and the subtotal", () => {
    const items = [
      it1({ officer_id: "A", item_type: "Cash", amount: 100 }),
      it1({ officer_id: "A", item_type: "CashBanked", amount: 10 }),
      it1({ officer_id: "A", item_type: "DirectDebit", amount: 750 }),
      it1({ officer_id: "A", item_type: "EFT", amount: 800 }),
    ];
    const [g] = groupItemsByOfficer(items, [{ id: "A" }]);
    expect(g.count).toBe(4); // entries, not distinct people
    expect(g.cashCount).toBe(2);
    expect(g.cashTotal).toBe(110); // Cash + CashBanked (cash retained after banking)
    expect(g.ddCount).toBe(1);
    expect(g.ddTotal).toBe(750);
    expect(g.eftCount).toBe(1);
    expect(g.eftTotal).toBe(800);
    expect(g.subtotal).toBe(1660);
  });

  it("surfaces an unrecognised payment type in the 'other' bucket and still reconciles", () => {
    const items = [
      it1({ officer_id: "A", item_type: "Cash", amount: 100 }),
      it1({ officer_id: "A", item_type: "EFT", amount: 50 }),
      it1({ officer_id: "A", item_type: "MysteryType", amount: 7 }),
    ];
    const [g] = groupItemsByOfficer(items, [{ id: "A" }]);
    expect(g.otherCount).toBe(1);
    expect(g.otherTotal).toBe(7);
    // reconciliation invariants
    expect(g.cashCount + g.ddCount + g.eftCount + g.otherCount).toBe(g.count);
    expect(g.cashTotal + g.ddTotal + g.eftTotal + g.otherTotal).toBeCloseTo(g.subtotal, 5);
  });

  it("places entries with no officer association in an 'Unassigned' bucket, ordered last", () => {
    const items = [
      it1({ officer_id: null, item_type: "Cash", amount: 5 }),
      it1({ officer_id: "A", item_type: "Cash", amount: 100 }),
    ];
    const groups = groupItemsByOfficer(items, [{ id: "A" }]);
    expect(groups.map((g) => g.officerId)).toEqual(["A", null]);
    expect(groups[groups.length - 1].officerId).toBeNull();
  });

  it("follows the supplied officer order, then any extra ids, then unassigned", () => {
    const items = [
      it1({ officer_id: "X", item_type: "Cash", amount: 1 }),
      it1({ officer_id: "B", item_type: "Cash", amount: 2 }),
      it1({ officer_id: "A", item_type: "Cash", amount: 3 }),
      it1({ officer_id: null, item_type: "Cash", amount: 4 }),
    ];
    const groups = groupItemsByOfficer(items, [{ id: "A" }, { id: "B" }]);
    expect(groups.map((g) => g.officerId)).toEqual(["A", "B", "X", null]);
  });

  it("omits officers that have no captured entries", () => {
    const items = [it1({ officer_id: "A", item_type: "Cash", amount: 1 })];
    const groups = groupItemsByOfficer(items, [{ id: "A" }, { id: "B" }]);
    expect(groups.map((g) => g.officerId)).toEqual(["A"]);
  });
});
