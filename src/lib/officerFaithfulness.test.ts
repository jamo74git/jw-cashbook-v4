import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("@/lib/supabase/client", () => ({ createClient: () => ({}) }));

import { hasPermission, getPermission, OFFICER_FAITHFULNESS_VIEW } from "@/lib/permissions";
import { canViewOfficerFaithfulness } from "@/lib/routeGuard";
import { listOfficersWithoutRecentTithe, countOfficerFaithfulness } from "@/db/dashboardRepo";
import { db } from "@/db/schema";
import type { Role } from "@/lib/types";

describe("officer faithfulness permission", () => {
  it("is granted to Chairperson and Elder only", () => {
    const roles: Role[] = ["HO", "Apostle", "Overseer", "Elder", "Chairperson", "Auditor", "Treasurer", "Secretary"];
    const allowed = roles.filter((r) => hasPermission(r, OFFICER_FAITHFULNESS_VIEW));
    expect(allowed.sort()).toEqual(["Chairperson", "Elder"]);
    expect(getPermission("Treasurer", OFFICER_FAITHFULNESS_VIEW)).toBe("-");
  });
  it("route guard mirrors the matrix", () => {
    expect(canViewOfficerFaithfulness("Chairperson")).toBe(true);
    expect(canViewOfficerFaithfulness("Elder")).toBe(true);
    expect(canViewOfficerFaithfulness("Treasurer")).toBe(false);
    expect(canViewOfficerFaithfulness("Secretary")).toBe(false);
  });
});

describe("listOfficersWithoutRecentTithe", () => {
  const CONG = "cong-1";
  const officer = (id: string, code: string, extra: Record<string, unknown> = {}) => ({
    id,
    congregation_id: CONG,
    officer_code: code,
    first_name: code,
    last_name: "X",
    rank: "Priest",
    is_active: true,
    ...extra,
  });

  beforeEach(async () => {
    await db.officers.clear();
    await db.periods.clear();
    await db.lineItems.clear();
  });

  it("lists active officers with no line in the last 4 periods; count matches", async () => {
    await db.officers.bulkPut([
      officer("a", "P-001"),
      officer("b", "P-002"),
      officer("c", "P-003", { is_interim: true }),
      officer("d", "P-004", { is_active: false }),
    ]);
    const mkPeriod = (n: number) => ({
      localId: `p${n}`,
      congregationId: CONG,
      year: 2026,
      month: 10,
      week: n,
    });
    await db.periods.bulkPut([1, 2, 3, 4, 5].map(mkPeriod) as never);
    // officer a tithed in week 5 (recent); officer b only in week 1 (outside the last 4)
    await db.lineItems.bulkPut([
      { localId: "l1", periodLocalId: "p5", officer_id: "a" },
      { localId: "l2", periodLocalId: "p1", officer_id: "b" },
    ] as never);

    const list = await listOfficersWithoutRecentTithe(CONG);
    expect(list.map((o) => o.officer_code)).toEqual(["P-002", "P-003"]);
    expect(list.find((o) => o.id === "c")?.is_interim).toBe(true);
    expect(await countOfficerFaithfulness(CONG)).toBe(2);
  });
});
