// ─────────────────────────────────────────────────────────────────────────────
// HO ADMIN WRITE CLIENT. The old Next.js app used privileged `/api/admin/*` routes
// (service-role, HO-gated). In the Vite app those are consolidated into the
// `admin-write` Supabase Edge Function (steering Req 4). This wraps the invoke so
// screens never see the service-role key. Reads stay as direct RLS-gated client
// queries; only mutations that must bypass RLS go through here.
//
// NOTE: `admin-write` must be deployed with these action handlers for writes to work
// at runtime. Congregation CRUD is a direct client write (RLS-gated) and does NOT use
// this helper — matching the original.
// ─────────────────────────────────────────────────────────────────────────────

import { createClient } from "@/lib/supabase/client";

export interface AdminResult<T = unknown> { ok: boolean; data?: T; error?: string; }
export interface AdminUserRow {
  user_id: string; email: string; role: string; scope_level: string;
  congregation_id: string | null; hierarchy_id: string | null; status?: string;
}

async function invoke<T = unknown>(action: string, payload: Record<string, unknown>): Promise<AdminResult<T>> {
  const supabase = createClient();
  const { data, error } = await supabase.functions.invoke("admin-write", { body: { action, ...payload } });
  if (error) return { ok: false, error: error.message };
  const d = data as { error?: string } | null;
  if (d && typeof d === "object" && "error" in d && d.error) return { ok: false, error: String(d.error) };
  return { ok: true, data: data as T };
}

export const adminApi = {
  listUsers: () => invoke<{ users: AdminUserRow[] }>("list_users", {}),
  createUser: (p: Record<string, unknown>) => invoke("create_user", p),
  updateUser: (p: Record<string, unknown>) => invoke("update_user", p),
  createOfficer: (p: Record<string, unknown>) => invoke("create_officer", p),
  updateOfficer: (p: Record<string, unknown>) => invoke("update_officer", p),
  createHierarchy: (p: Record<string, unknown>) => invoke("create_hierarchy", p),
  updateHierarchy: (p: Record<string, unknown>) => invoke("update_hierarchy", p),
};
