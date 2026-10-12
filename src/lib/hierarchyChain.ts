// ─────────────────────────────────────────────────────────────────────────────
// HIERARCHY BREADCRUMB RESOLVER (MVP hardening v5, Decision 7)
// Resolve the canonical hierarchy chain for the header, cache-first and fail-safe:
//   Conference(=COA) > Apostolate > District > Apostleship > Overseership >
//   Eldership(virtual) > Congregation
// Reads ONLY the cached Dexie stores (congregations + hierarchyLevels). A congregation
// denormalizes district_id, apostleship_id, overseership_id, eldership_id; Apostolate
// and Conference/COA are reached by walking hierarchyLevels.parent_id up from the
// District. Eldership is a virtual grouping — included only when the congregation has
// an eldership_id. Never throws; returns [] when nothing resolves so the header can
// fall back to name + role + scope.
// ─────────────────────────────────────────────────────────────────────────────

import { db } from "@/db/schema";
import { HIERARCHY_LEVELS, type HierarchyLevel } from "@/lib/types";

export interface ChainSegment {
  level: HierarchyLevel;
  name: string;
}

export async function resolveHierarchyChain(input: {
  congregationId: string | null;
  hierarchyId: string | null;
  scopeLevel: HierarchyLevel;
  congregationName?: string | null;
}): Promise<ChainSegment[]> {
  const names = new Map<HierarchyLevel, string>();

  try {
    if (input.congregationId) {
      const cong = await db.congregations.get(input.congregationId);
      names.set("Congregation", input.congregationName ?? cong?.name ?? input.congregationId);

      // Denormalized ids on the congregation (Eldership is virtual — skip when null).
      const denorm: Array<string | null | undefined> = [
        cong?.eldership_id,
        cong?.apostleship_id,
        cong?.overseership_id,
        cong?.district_id,
      ];
      for (const id of denorm) {
        if (!id) continue;
        const node = await db.hierarchyLevels.get(id);
        if (node) names.set(node.level_type, node.name);
      }

      // Parent-walk up from the District to reach Apostolate then Conference/COA.
      let cursorId = cong?.district_id ?? null;
      // If the District node is cached, start the walk from its parent.
      const districtNode = cursorId ? await db.hierarchyLevels.get(cursorId) : undefined;
      cursorId = districtNode?.parent_id ?? null;
      await walkUp(cursorId, names);
    } else if (input.hierarchyId) {
      // Non-congregation scope (HO/Overseer/Apostle): walk up from the scope node.
      await walkUp(input.hierarchyId, names);
    }
  } catch {
    // Cache not populated / read error — fall back to whatever resolved (possibly []).
  }

  // Emit in canonical order, including only levels that resolved.
  const segments: ChainSegment[] = [];
  for (const level of HIERARCHY_LEVELS) {
    const name = names.get(level);
    if (name) segments.push({ level, name });
  }
  return segments;
}

// Walk hierarchyLevels upward via parent_id, recording each node under its level_type.
// Guards against cycles with a visited set.
async function walkUp(startId: string | null, names: Map<HierarchyLevel, string>): Promise<void> {
  const visited = new Set<string>();
  let id: string | null = startId;
  while (id && !visited.has(id)) {
    visited.add(id);
    const node = await db.hierarchyLevels.get(id);
    if (!node) break;
    names.set(node.level_type, node.name);
    id = node.parent_id;
  }
}
