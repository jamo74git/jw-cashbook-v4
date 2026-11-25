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

/** Log a failed reference query without UI noise. Message only; no payloads or secrets. */
function warnQueryFailed(table: string, message: string): void {
  console.warn(`[cacheLoader] ${table} refresh failed; keeping existing cache: ${message}`);
}

/**
 * Fetch reference data from Supabase and replace the local lookup stores.
 * Each query is handled separately: a store is replaced only when its own query
 * succeeded, so one failing query never discards the others or wipes a good cache.
 */
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

  // allSettled so a thrown/rejected query is also isolated from the rest.
  const settled = await Promise.allSettled([
    supabase
      .from("officers")
      .select("id, congregation_id, officer_code, first_name, last_name, rank, is_active")
      .eq("is_active", true)
      .in("rank", ["Priest", "Underdeacon"]),
    supabase
      .from("congregations")
      .select("id, name, code, overseership_id, eldership_id, apostleship_id, district_id"),
    supabase.from("hierarchy_levels").select("id, name, code, level_type, parent_id"),
    // Only columns that exist on the backend (census/hall flags are not provisioned there).
    supabase.from("congregation_settings").select("congregation_id, proof_mandatory, expense_approval_threshold"),
  ]);
  const tables = ["officers", "congregations", "hierarchy_levels", "congregation_settings"] as const;

  const errors: string[] = [];
  const rows: (unknown[] | null)[] = settled.map((s, idx) => {
    if (s.status === "rejected") {
      const msg = s.reason instanceof Error ? s.reason.message : String(s.reason);
      warnQueryFailed(tables[idx], msg);
      errors.push(`${tables[idx]}: ${msg}`);
      return null;
    }
    if (s.value.error) {
      warnQueryFailed(tables[idx], s.value.error.message);
      errors.push(`${tables[idx]}: ${s.value.error.message}`);
      return null;
    }
    return (s.value.data ?? []) as unknown[];
  });

  const officers = rows[0] as OfficerLookup[] | null;
  const congregations = rows[1] as CongregationLookup[] | null;
  const hierarchyLevels = rows[2] as HierarchyLookup[] | null;
  const congregationSettings = rows[3] as CongregationSettings[] | null;

  if (officers || congregations || hierarchyLevels || congregationSettings) {
    await db.transaction(
      "rw",
      db.officers,
      db.congregations,
      db.hierarchyLevels,
      db.congregationSettings,
      db.syncMeta,
      async () => {
        if (officers) {
          await db.officers.clear();
          await db.officers.bulkPut(officers);
        }
        if (congregations) {
          await db.congregations.clear();
          await db.congregations.bulkPut(congregations);
        }
        if (hierarchyLevels) {
          await db.hierarchyLevels.clear();
          await db.hierarchyLevels.bulkPut(hierarchyLevels);
        }
        if (congregationSettings) {
          await db.congregationSettings.clear();
          await db.congregationSettings.bulkPut(congregationSettings);
        }

        const meta = await db.syncMeta.get("global");
        await db.syncMeta.put({
          key: "global",
          lastSyncAt: meta?.lastSyncAt ?? null,
          lastReferenceRefreshAt: new Date().toISOString(),
          schemaVersion: 2,
        });
      }
    );
  }

  return {
    ok: errors.length === 0,
    officers: officers?.length ?? 0,
    congregations: congregations?.length ?? 0,
    hierarchyLevels: hierarchyLevels?.length ?? 0,
    congregationSettings: congregationSettings?.length ?? 0,
    ...(errors.length ? { error: errors.join("; ") } : {}),
  };
}

/** Fire-and-forget auto refresh for an active online session. Never throws. */
export function autoRefreshReferenceCache(): void {
  if (!isOnline()) return;
  void refreshReferenceCache().catch(() => {
    /* keep the existing cache on failure */
  });
}
