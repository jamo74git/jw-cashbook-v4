// ─────────────────────────────────────────────────────────────────────────────
// IDENTITY RESOLVER (offline-pin-multiuser Req 4, 5, 6)
// Single source of truth for the current user's DISPLAY identity (initials, role,
// email, congregation, scope). Online-aware and fail-closed:
//   - offline: sourced from the active Offline_Session + the cached offline profile,
//     NEVER from supabase.auth.getUser() (which fails offline);
//   - online: behaves as today (Supabase-sourced), with congregation name/scope read
//     from the cached congregations store (Supabase fallback) so there is no regression.
// All role usage flows through the existing types; no raw role-string branching beyond
// the existing HO special-case handled by the header.
// ─────────────────────────────────────────────────────────────────────────────

import { createClient } from "@/lib/supabase/client";
import { getUserAccess } from "@/lib/permissions";
import { getSession } from "@/services/authService";
import { db } from "@/db/schema";
import type { Role, HierarchyLevel } from "@/lib/types";

export interface CurrentIdentity {
  userId: string;
  email: string;
  role: Role;
  displayName: string;
  initials: string;
  congregationId: string | null;
  congregationName: string | null;
  congregationNumber: string | null; // CongregationLookup.code, e.g. "123" for "(No: 123)"
  overseershipName: string | null; // immediate parent Overseership name for the concise header
  scopeLevel: HierarchyLevel;
  hierarchyId: string | null;
  scopeCount: number;
  isOnline: boolean;
}

/**
 * Resolve the concise-header extras from the cached stores (works offline): the
 * congregation NUMBER (CongregationLookup.code) and the immediate parent Overseership
 * name. Never throws; returns nulls when the reference cache is not populated.
 */
async function resolveCongregationExtras(
  congregationId: string | null
): Promise<{ congregationNumber: string | null; overseershipName: string | null }> {
  if (!congregationId) return { congregationNumber: null, overseershipName: null };
  try {
    const cong = await db.congregations.get(congregationId);
    const congregationNumber = cong?.code ?? null;
    let overseershipName: string | null = null;
    if (cong?.overseership_id) {
      const node = await db.hierarchyLevels.get(cong.overseership_id);
      overseershipName = node?.name ?? null;
    }
    return { congregationNumber, overseershipName };
  } catch {
    return { congregationNumber: null, overseershipName: null };
  }
}

function isOnline(): boolean {
  return typeof navigator === "undefined" ? true : navigator.onLine;
}

// Display rule mirrors AppHeader / the offline profile: email prefix with the first
// char capitalized; initials = first two chars of that, uppercased.
function deriveDisplayName(email: string): string {
  const name = email.split("@")[0] || "User";
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function deriveInitials(displayName: string): string {
  return displayName.slice(0, 2).toUpperCase();
}

/**
 * Scope count mirrors AppHeader's logic but reads the cached congregations store so it
 * works offline. Never returns 0 when a congregation is known for the user (R6.1/6.3).
 * NOTE: `eldership_id` is not a Dexie index on the congregations store, so this uses a
 * `.filter()` table scan (the congregations table is small) rather than `.where()`.
 */
export async function computeScopeCount(a: {
  scopeLevel: HierarchyLevel;
  hierarchyId: string | null;
  congregationId: string | null;
}): Promise<number> {
  if (a.scopeLevel === "Eldership" && a.hierarchyId) {
    return db.congregations.filter((c) => c.eldership_id === a.hierarchyId).count();
  }
  if (a.congregationId) return 1; // never 0 when a congregation is known (R6.1, R6.3)
  return 0;
}

// Resolve a congregation display name online-first for the online path: prefer the
// cached congregations store, then fall back to a Supabase lookup.
async function resolveCongregationNameOnline(congregationId: string | null): Promise<string | null> {
  if (!congregationId) return null;
  const cached = await db.congregations.get(congregationId);
  if (cached?.name) return cached.name;
  try {
    const supabase = createClient();
    const { data } = await supabase
      .from("congregations")
      .select("name")
      .eq("id", congregationId)
      .maybeSingle();
    if (data?.name) return data.name;
  } catch {
    // Non-fatal; header renders role + scope without a name rather than erroring.
  }
  return null;
}

/**
 * Resolve the current user's display identity.
 * Offline with no active session -> null (fail-closed, R4.3); the header renders nothing
 * and the route guard redirects to login.
 */
export async function getCurrentIdentity(): Promise<CurrentIdentity | null> {
  if (!isOnline()) {
    // ── Offline: session is authoritative for role/window; profile for display ──
    const session = getSession();
    if (!session) return null; // fail-closed (R4.1, R4.3)

    const profile = await db.offlineUsers.get(session.userId);
    const congregationId = profile?.congregationId ?? null;
    const hierarchyId = profile?.hierarchyId ?? null;
    const scopeLevel: HierarchyLevel = profile?.scopeLevel ?? "Congregation";
    const scopeCount = await computeScopeCount({ scopeLevel, hierarchyId, congregationId });

    // Profile may be absent in the edge case where a credential exists without a
    // persisted profile; fall back to a minimal (non-blank) identity from the session.
    const displayName = profile?.displayName ?? "User";
    const initials = profile?.initials ?? deriveInitials(displayName);
    const extras = await resolveCongregationExtras(congregationId);

    return {
      userId: session.userId,
      email: profile?.email ?? "",
      role: session.role, // post-unlock session role is authoritative
      displayName,
      initials,
      congregationId,
      congregationName: profile?.congregationName ?? null,
      congregationNumber: extras.congregationNumber,
      overseershipName: extras.overseershipName,
      scopeLevel,
      hierarchyId,
      scopeCount,
      isOnline: false,
    };
  }

  // ── Online: unchanged Supabase-sourced semantics (R4.4) ──
  const access = await getUserAccess();
  if (!access) return null;

  const supabase = createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const email = user?.email ?? "";
  const displayName = deriveDisplayName(email);
  const congregationId = access.congregation_id ?? null;
  const hierarchyId = access.hierarchy_id ?? null;
  const scopeLevel = access.scope_level;

  const [congregationName, scopeCount, extras] = await Promise.all([
    resolveCongregationNameOnline(congregationId),
    computeScopeCount({ scopeLevel, hierarchyId, congregationId }),
    resolveCongregationExtras(congregationId),
  ]);

  return {
    userId: access.user_id,
    email,
    role: access.role,
    displayName,
    initials: deriveInitials(displayName),
    congregationId,
    congregationName,
    congregationNumber: extras.congregationNumber,
    overseershipName: extras.overseershipName,
    scopeLevel,
    hierarchyId,
    scopeCount,
    isOnline: true,
  };
}
