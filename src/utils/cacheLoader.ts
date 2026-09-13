// ─────────────────────────────────────────────────────────────────────────────
// REFERENCE CACHE LOADER — populates the offline lookup stores.
// Runs only during an active ONLINE session. Fetches officers, congregations, and
// hierarchy levels from Supabase (RLS scopes rows to the user) and mirrors them into
// the Dexie Local_Store so offline pickers are ready (Req 3.3, 11, 13.1, 13.2).
// ─────────────────────────────────────────────────────────────────────────────

import { createClient } from "@/lib/supabase/client";
import {
  db,
  type CongregationLookup,
  type HierarchyLookup,
  type OfficerLookup,
} from "@/db/schema";

function isOnline(): boolean {
  return typeof navigator === "undefined" ? true : navigator.onLine;
}

export interface RefreshResult {
  ok: boolean;
  officers: number;
  congregations: number;
  hierarchyLevels: number;
  error?: string;
}

/**
 * Fetch reference data from Supabase and replace the local lookup stores.
 * No-op (ok:false) when offline. Each store is cleared then repopulated so removed
 * rows do not linger. Records the refresh timestamp in syncMeta.
 */
export async function refreshReferenceCache(): Promise<RefreshResult> {
  const empty: RefreshResult = { ok: false, officers: 0, congregations: 0, hierarchyLevels: 0 };
  if (!isOnline()) return { ...empty, error: "offline" };

  const supabase = createClient();

  const [officersRes, congsRes, hierRes] = await Promise.all([
    supabase.from("officers").select("id, congregation_id, officer_code, first_name, last_name, rank, is_active"),
    supabase.from("congregations").select("id, name, code, overseership_id, eldership_id, apostleship_id, district_id"),
    supabase.from("hierarchy_levels").select("id, name, code, level_type, parent_id"),
  ]);

  const firstError = officersRes.error ?? congsRes.error ?? hierRes.error;
  if (firstError) {
    return { ...empty, error: firstError.message };
  }

  const officers = (officersRes.data ?? []) as OfficerLookup[];
  const congregations = (congsRes.data ?? []) as CongregationLookup[];
  const hierarchyLevels = (hierRes.data ?? []) as HierarchyLookup[];

  // Replace each store atomically so offline reads see a consistent snapshot.
  await db.transaction("rw", db.officers, db.congregations, db.hierarchyLevels, db.syncMeta, async () => {
    await db.officers.clear();
    await db.officers.bulkPut(officers);
    await db.congregations.clear();
    await db.congregations.bulkPut(congregations);
    await db.hierarchyLevels.clear();
    await db.hierarchyLevels.bulkPut(hierarchyLevels);

    const meta = await db.syncMeta.get("global");
    await db.syncMeta.put({
      key: "global",
      lastSyncAt: meta?.lastSyncAt ?? null,
      lastReferenceRefreshAt: new Date().toISOString(),
      schemaVersion: 1,
    });
  });

  return {
    ok: true,
    officers: officers.length,
    congregations: congregations.length,
    hierarchyLevels: hierarchyLevels.length,
  };
}

/**
 * Fire-and-forget auto refresh for use during an active online session (login,
 * reconnect, app bootstrap). Never throws — failures are swallowed so they don't
 * block the UI; the last good cache remains usable offline.
 */
export function autoRefreshReferenceCache(): void {
  if (!isOnline()) return;
  void refreshReferenceCache().catch(() => {
    /* keep the existing cache on failure */
  });
}
