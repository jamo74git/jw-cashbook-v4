// ─────────────────────────────────────────────────────────────────────────────
// REFERENCE CACHE LOADER (v2) — hydrates offline lookups during an online session.
// Populates officers (active, Priest/Underdeacon), congregations, hierarchy levels,
// and congregation_settings (proof_mandatory) so offline capture pickers and the
// proof-mandatory rule are ready (Req 1.4, 1.8, 2.5).
// ─────────────────────────────────────────────────────────────────────────────

import { createClient } from "@/lib/supabase/client";
import {
  db,
  type CongregationLookup,
  type HierarchyLookup,
  type OfficerLookup,
  type CongregationSettings,
} from "@/db/schema";

function isOnline(): boolean {
  return typeof navigator === "undefined" ? true : navigator.onLine;
}

export interface RefreshResult {
  ok: boolean;
  officers: number;
  congregations: number;
  hierarchyLevels: number;
  congregationSettings: number;
  error?: string;
}

/** Fetch reference data from Supabase and replace the local lookup stores. */
export async function refreshReferenceCache(): Promise<RefreshResult> {
  const empty: RefreshResult = {
    ok: false,
    officers: 0,
    congregations: 0,
    hierarchyLevels: 0,
    congregationSettings: 0,
  };
  if (!isOnline()) return { ...empty, error: "offline" };

  const supabase = createClient();

  const [officersRes, congsRes, hierRes, settingsRes] = await Promise.all([
    supabase
      .from("officers")
      .select("id, congregation_id, officer_code, first_name, last_name, rank, is_active")
      .eq("is_active", true)
      .in("rank", ["Priest", "Underdeacon"]),
    supabase
      .from("congregations")
      .select("id, name, code, overseership_id, eldership_id, apostleship_id, district_id"),
    supabase.from("hierarchy_levels").select("id, name, code, level_type, parent_id"),
    supabase.from("congregation_settings").select("congregation_id, proof_mandatory"),
  ]);

  const firstError = officersRes.error ?? congsRes.error ?? hierRes.error ?? settingsRes.error;
  if (firstError) return { ...empty, error: firstError.message };

  const officers = (officersRes.data ?? []) as OfficerLookup[];
  const congregations = (congsRes.data ?? []) as CongregationLookup[];
  const hierarchyLevels = (hierRes.data ?? []) as HierarchyLookup[];
  const congregationSettings = (settingsRes.data ?? []) as CongregationSettings[];

  await db.transaction(
    "rw",
    db.officers,
    db.congregations,
    db.hierarchyLevels,
    db.congregationSettings,
    db.syncMeta,
    async () => {
      await db.officers.clear();
      await db.officers.bulkPut(officers);
      await db.congregations.clear();
      await db.congregations.bulkPut(congregations);
      await db.hierarchyLevels.clear();
      await db.hierarchyLevels.bulkPut(hierarchyLevels);
      await db.congregationSettings.clear();
      await db.congregationSettings.bulkPut(congregationSettings);

      const meta = await db.syncMeta.get("global");
      await db.syncMeta.put({
        key: "global",
        lastSyncAt: meta?.lastSyncAt ?? null,
        lastReferenceRefreshAt: new Date().toISOString(),
        schemaVersion: 2,
        // Preserve the offline "relevant user" pointer set by authService; the
        // reference-cache refresh must never clobber it (read-merge-write).
        lastActiveUserId: meta?.lastActiveUserId ?? null,
      });
    }
  );

  return {
    ok: true,
    officers: officers.length,
    congregations: congregations.length,
    hierarchyLevels: hierarchyLevels.length,
    congregationSettings: congregationSettings.length,
  };
}

/** Fire-and-forget auto refresh for an active online session. Never throws. */
export function autoRefreshReferenceCache(): void {
  if (!isOnline()) return;
  void refreshReferenceCache().catch(() => {
    /* keep the existing cache on failure */
  });
}
