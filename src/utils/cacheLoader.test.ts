// cacheLoader: each reference query is isolated. A failing query (e.g. an unprovisioned
// column on congregation_settings) must not stop the other stores being cached, and
// must not wipe an existing good cache.
import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, vi } from "vitest";

type Res = { data: unknown; error: { message: string } | null };

const mock = vi.hoisted(() => ({
  results: {} as Record<string, { data: unknown; error: { message: string } | null }>,
  selects: [] as { table: string; columns: string }[],
}));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    from: (table: string) => {
      const b = {
        select(columns: string) {
          mock.selects.push({ table, columns });
          return b;
        },
        eq() {
          return b;
        },
        in() {
          return b;
        },
        then(resolve: (v: Res) => void) {
          resolve(mock.results[table] ?? { data: [], error: null });
        },
      };
      return b;
    },
  }),
}));

import { refreshReferenceCache } from "@/utils/cacheLoader";
import { db } from "@/db/schema";

const OFFICER = {
  id: "o1",
  congregation_id: "c1",
  officer_code: "P-001",
  first_name: "A",
  last_name: "B",
  rank: "Priest",
  is_active: true,
};

beforeEach(async () => {
  vi.stubGlobal("navigator", { onLine: true });
  mock.selects = [];
  mock.results = {
    officers: { data: [OFFICER], error: null },
    congregations: { data: [{ id: "c1", name: "Bosmont", code: "BOS" }], error: null },
    hierarchy_levels: { data: [], error: null },
    congregation_settings: { data: [{ congregation_id: "c1", proof_mandatory: true }], error: null },
  };
  await db.officers.clear();
  await db.congregations.clear();
  await db.congregationSettings.clear();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("refreshReferenceCache", () => {
  it("does not request congregation_settings columns that are absent on the backend", async () => {
    await refreshReferenceCache();
    const s = mock.selects.find((x) => x.table === "congregation_settings");
    expect(s?.columns).toBe("congregation_id, proof_mandatory");
    expect(s?.columns).not.toMatch(/hall_capacity|allow_treasurer|last_census_verified_at/);
  });

  it("caches every store when all queries succeed", async () => {
    const r = await refreshReferenceCache();
    expect(r.ok).toBe(true);
    expect(await db.officers.count()).toBe(1);
    expect(await db.congregations.count()).toBe(1);
    expect(await db.congregationSettings.count()).toBe(1);
  });

  it("still caches officers when the settings query fails", async () => {
    mock.results.congregation_settings = { data: null, error: { message: "column does not exist" } };
    const r = await refreshReferenceCache();
    expect(r.ok).toBe(false);
    expect(r.error).toContain("congregation_settings");
    expect(r.officers).toBe(1);
    expect(await db.officers.get("o1")).toBeTruthy();
    expect(await db.congregations.count()).toBe(1);
    expect(console.warn).toHaveBeenCalled();
  });

  it("does not wipe an existing cache when its own query fails", async () => {
    await db.officers.put({ ...OFFICER, id: "old", officer_code: "P-OLD" });
    await db.congregationSettings.put({ congregation_id: "c1", proof_mandatory: true });
    mock.results.officers = { data: null, error: { message: "boom" } };
    mock.results.congregation_settings = { data: null, error: { message: "boom" } };
    await refreshReferenceCache();
    expect(await db.officers.get("old")).toBeTruthy();
    expect(await db.congregationSettings.get("c1")).toBeTruthy();
    // the successful congregations store was still refreshed
    expect(await db.congregations.count()).toBe(1);
  });
});
