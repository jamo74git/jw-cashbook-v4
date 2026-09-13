// ─────────────────────────────────────────────────────────────────────────────
// CLIENT-SIDE ROUTE GUARD (replaces Next.js middleware.ts)
// First-pass gate for the SPA. All decisions route through the permission matrix
// in @/lib/permissions.ts — no inline role string comparisons. Supabase RLS remains
// the authoritative server-side control (Req 2.6, 2.7, 10.1, 10.6).
// ─────────────────────────────────────────────────────────────────────────────

import { getUserAccess, hasPermission, getDashboardRoute } from "@/lib/permissions";
import { getSession } from "@/services/authService";
import type { Role, UserHierarchyAccess } from "@/lib/types";

/**
 * Resolve the current user's access record.
 * Online: delegates to getUserAccess() (Supabase).
 * Offline: derives a provisional access record from the active Offline_Session
 * (Cached_Credential). Fail-closed: no session offline -> null (redirect to login).
 */
export async function resolveAccess(): Promise<UserHierarchyAccess | null> {
  if (typeof navigator !== "undefined" && !navigator.onLine) {
    const session = getSession();
    if (!session) return null;
    return {
      id: "offline-session",
      user_id: session.userId,
      role: session.role,
      hierarchy_id: "",
      congregation_id: null,
      scope_level: "Congregation",
      status: "active",
      start_date: session.accessStartDate,
      end_date: session.accessEndDate,
    };
  }
  return getUserAccess();
}

/**
 * A role may enter /capture if the permission matrix grants it capture creation
 * (non "-"). This resolves to Elder (O), Chairperson (C), Treasurer (C) — matching
 * the legacy middleware /capture allow-list, but derived from the matrix (Req 2.7).
 */
export function canEnterCapture(role: Role): boolean {
  return hasPermission(role, "capture.create");
}

/**
 * A role may enter /admin only if it holds an admin management (M) permission,
 * which is HO-only in the matrix (Req 2.6).
 */
export function canEnterAdmin(role: Role): boolean {
  return hasPermission(role, "admin.manage_users");
}

/**
 * Where to send a user who lacks access to the route they requested.
 */
export function redirectTargetFor(role: Role): string {
  return getDashboardRoute(role);
}
