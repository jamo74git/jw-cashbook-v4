// ═══════════════════════════════════════════════════════════════════════════════
// OAC MANAGEMENT SYSTEM — PERMISSION GATE
// Based on permission_matrix_v3.txt. No hardcoded role checks in pages/components.
// ═══════════════════════════════════════════════════════════════════════════════

import { createClient } from "@/lib/supabase/client";
import type { Role, UserHierarchyAccess, AuditActionType } from "@/lib/types";

// ─── Permission Matrix (derived from permission_matrix_v3.txt) ──────────────

type PermCode = "V" | "C" | "E" | "A" | "S" | "X" | "M" | "O" | "R" | "-" | "T";

/**
 * Module permission map.
 * Key: "module.function"
 * Value: Record<Role, PermCode>
 */
const PERMISSIONS: Record<string, Record<Role, PermCode>> = {
  // ── Dashboard ───────────────────────────────────────────────────────────
  "dashboard.home": { HO: "V", Apostle: "V", Overseer: "V", Elder: "V", Chairperson: "V", Auditor: "-", Treasurer: "-", Secretary: "-" },
  "dashboard.kpi": { HO: "V", Apostle: "V", Overseer: "V", Elder: "V", Chairperson: "V", Auditor: "V", Treasurer: "-", Secretary: "-" },

  // ── Member Tithing Capture ──────────────────────────────────────────────
  "capture.view": { HO: "V", Apostle: "V", Overseer: "V", Elder: "V", Chairperson: "V", Auditor: "V", Treasurer: "V", Secretary: "T" },
  "capture.create": { HO: "-", Apostle: "-", Overseer: "-", Elder: "O", Chairperson: "C", Auditor: "-", Treasurer: "C", Secretary: "-" },
  "capture.edit": { HO: "-", Apostle: "-", Overseer: "-", Elder: "O", Chairperson: "E", Auditor: "-", Treasurer: "E", Secretary: "-" },
  "capture.submit": { HO: "-", Apostle: "-", Overseer: "-", Elder: "O", Chairperson: "S", Auditor: "-", Treasurer: "S", Secretary: "-" },

  // ── Officer Tithing ─────────────────────────────────────────────────────
  "officer_capture.view": { HO: "V", Apostle: "V", Overseer: "V", Elder: "V", Chairperson: "V", Auditor: "V", Treasurer: "V", Secretary: "V" },
  "officer_capture.create": { HO: "-", Apostle: "-", Overseer: "-", Elder: "O", Chairperson: "C", Auditor: "-", Treasurer: "C", Secretary: "-" },
  "officer_capture.edit": { HO: "-", Apostle: "-", Overseer: "-", Elder: "O", Chairperson: "E", Auditor: "-", Treasurer: "E", Secretary: "-" },

  // ── Banking & Proof ─────────────────────────────────────────────────────
  "banking.view": { HO: "V", Apostle: "V", Overseer: "V", Elder: "V", Chairperson: "V", Auditor: "V", Treasurer: "V", Secretary: "T" },
  "banking.create": { HO: "-", Apostle: "-", Overseer: "-", Elder: "O", Chairperson: "C", Auditor: "-", Treasurer: "C", Secretary: "-" },
  "banking.proof_view": { HO: "V", Apostle: "V", Overseer: "V", Elder: "V", Chairperson: "V", Auditor: "V", Treasurer: "V", Secretary: "-" },
  "banking.upload_proof": { HO: "-", Apostle: "-", Overseer: "-", Elder: "O", Chairperson: "C", Auditor: "-", Treasurer: "C", Secretary: "-" },

  // ── Expenses ────────────────────────────────────────────────────────────
  "expenses.view": { HO: "V", Apostle: "V", Overseer: "V", Elder: "V", Chairperson: "V", Auditor: "V", Treasurer: "V", Secretary: "V" },
  "expenses.create": { HO: "-", Apostle: "-", Overseer: "-", Elder: "O", Chairperson: "C", Auditor: "-", Treasurer: "C", Secretary: "-" },
  "expenses.approve_over_500": { HO: "-", Apostle: "-", Overseer: "-", Elder: "A", Chairperson: "-", Auditor: "-", Treasurer: "-", Secretary: "-" },

  // ── Audit ───────────────────────────────────────────────────────────────
  "audit.view_queue": { HO: "V", Apostle: "V", Overseer: "V", Elder: "V", Chairperson: "V", Auditor: "V", Treasurer: "-", Secretary: "-" },
  "audit.approve": { HO: "-", Apostle: "-", Overseer: "-", Elder: "O", Chairperson: "O", Auditor: "A", Treasurer: "-", Secretary: "-" },
  "audit.reject": { HO: "-", Apostle: "-", Overseer: "-", Elder: "O", Chairperson: "O", Auditor: "A", Treasurer: "-", Secretary: "-" },

  // ── Monthly Close ───────────────────────────────────────────────────────
  "month.view": { HO: "V", Apostle: "V", Overseer: "V", Elder: "V", Chairperson: "V", Auditor: "V", Treasurer: "V", Secretary: "V" },
  "month.submit_to_overseer": { HO: "-", Apostle: "-", Overseer: "-", Elder: "S", Chairperson: "-", Auditor: "-", Treasurer: "-", Secretary: "-" },
  "month.overseer_approve": { HO: "-", Apostle: "-", Overseer: "A", Elder: "-", Chairperson: "-", Auditor: "-", Treasurer: "-", Secretary: "-" },
  "month.overseer_reject": { HO: "-", Apostle: "-", Overseer: "A", Elder: "-", Chairperson: "-", Auditor: "-", Treasurer: "-", Secretary: "-" },
  "month.submit_to_ho": { HO: "-", Apostle: "-", Overseer: "S", Elder: "-", Chairperson: "-", Auditor: "-", Treasurer: "-", Secretary: "-" },

  // ── Corrections ─────────────────────────────────────────────────────────
  "corrections.raise": { HO: "A", Apostle: "-", Overseer: "-", Elder: "-", Chairperson: "-", Auditor: "-", Treasurer: "-", Secretary: "-" },
  "corrections.unlock_month": { HO: "A", Apostle: "-", Overseer: "-", Elder: "-", Chairperson: "-", Auditor: "-", Treasurer: "-", Secretary: "-" },
  "corrections.correct": { HO: "-", Apostle: "-", Overseer: "-", Elder: "O", Chairperson: "E", Auditor: "-", Treasurer: "E", Secretary: "-" },

  // ── Census ──────────────────────────────────────────────────────────────
  "census.view": { HO: "V", Apostle: "V", Overseer: "V", Elder: "V", Chairperson: "V", Auditor: "-", Treasurer: "V", Secretary: "T" },
  "census.capture": { HO: "-", Apostle: "-", Overseer: "-", Elder: "C", Chairperson: "-", Auditor: "-", Treasurer: "C", Secretary: "-" },
  "census.edit": { HO: "-", Apostle: "-", Overseer: "-", Elder: "E", Chairperson: "-", Auditor: "-", Treasurer: "E", Secretary: "-" },
  "census.view_90_flag": { HO: "-", Apostle: "V", Overseer: "V", Elder: "V", Chairperson: "-", Auditor: "-", Treasurer: "V", Secretary: "-" },
  "census.view_180_flag": { HO: "-", Apostle: "V", Overseer: "-", Elder: "-", Chairperson: "V", Auditor: "-", Treasurer: "-", Secretary: "-" },

  // ── Admin ───────────────────────────────────────────────────────────────
  "admin.manage_users": { HO: "M", Apostle: "-", Overseer: "-", Elder: "-", Chairperson: "-", Auditor: "-", Treasurer: "-", Secretary: "-" },
  "admin.manage_congregations": { HO: "M", Apostle: "-", Overseer: "-", Elder: "-", Chairperson: "-", Auditor: "-", Treasurer: "-", Secretary: "-" },
  "admin.manage_officers": { HO: "M", Apostle: "-", Overseer: "-", Elder: "-", Chairperson: "-", Auditor: "-", Treasurer: "-", Secretary: "-" },
  "admin.bulk_import": { HO: "M", Apostle: "-", Overseer: "-", Elder: "-", Chairperson: "-", Auditor: "-", Treasurer: "-", Secretary: "-" },
  "admin.audit_logs": { HO: "M", Apostle: "-", Overseer: "-", Elder: "-", Chairperson: "-", Auditor: "-", Treasurer: "-", Secretary: "-" },

  // ── Reports ─────────────────────────────────────────────────────────────
  "reports.export_pdf": { HO: "X", Apostle: "X", Overseer: "X", Elder: "X", Chairperson: "X", Auditor: "-", Treasurer: "-", Secretary: "X" },
  "reports.export_excel": { HO: "X", Apostle: "X", Overseer: "X", Elder: "X", Chairperson: "-", Auditor: "-", Treasurer: "-", Secretary: "-" },
  "reports.export_csv": { HO: "X", Apostle: "X", Overseer: "X", Elder: "X", Chairperson: "-", Auditor: "-", Treasurer: "-", Secretary: "-" },

  // ── Messaging ───────────────────────────────────────────────────────────
  "messaging.ho_view": { HO: "V", Apostle: "V", Overseer: "V", Elder: "V", Chairperson: "V", Auditor: "V", Treasurer: "V", Secretary: "-" },
  "messaging.ho_send": { HO: "C", Apostle: "-", Overseer: "-", Elder: "R", Chairperson: "R", Auditor: "R", Treasurer: "R", Secretary: "-" },
  "messaging.internal": { HO: "-", Apostle: "-", Overseer: "-", Elder: "C", Chairperson: "C", Auditor: "C", Treasurer: "C", Secretary: "-" },
};

// ─── Core Permission Check Functions ────────────────────────────────────────

/**
 * Get the current user's hierarchy access from Supabase.
 * Returns the primary (first active) access record.
 */
export async function getUserAccess(): Promise<UserHierarchyAccess | null> {
  const supabase = createClient();

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) return null;

const { data } = await supabase
  .from("user_hierarchy_access")
  .select("*")
  .eq("user_id", user.id)
  .eq("status", "active")
  .limit(1)
  .maybeSingle(); // no order

  return data ?? null;
}

/**
 * Check if a role has a specific permission for a module function.
 * Returns the permission code or "-" (no access).
 */
export function getPermission(role: Role, moduleFunction: string): PermCode {
  const modulePerm = PERMISSIONS[moduleFunction];
  if (!modulePerm) return "-";
  return modulePerm[role] ?? "-";
}

/**
 * Check if the user's role can perform a specific action.
 * Allowed codes: V, C, E, A, S, X, M, O, R (anything except "-")
 */
export function hasPermission(role: Role, moduleFunction: string): boolean {
  const code = getPermission(role, moduleFunction);
  return code !== "-";
}

/**
 * Check if this is a "Totals Only" permission (Secretary rule).
 * When true, the UI must hide line item details and proof images.
 */
export function isTotalsOnly(role: Role, moduleFunction: string): boolean {
  return getPermission(role, moduleFunction) === "T";
}

/**
 * Check if the action requires Override logging (Chairperson/Elder using "O").
 * Returns true if the permission code is "O".
 */
export function isOverrideAction(role: Role, moduleFunction: string): boolean {
  return getPermission(role, moduleFunction) === "O";
}

/**
 * Get the dashboard route for a given role.
 */
export function getDashboardRoute(role: Role): string {
  switch (role) {
    case "HO":
      return "/admin";
    case "Apostle":
    case "Overseer":
      return "/review";
    case "Elder":
      return "/dashboard";
    case "Chairperson":
    case "Treasurer":
      return "/capture";
    case "Auditor":
      return "/audit";
    case "Secretary":
      return "/reports";
    default:
      return "/dashboard";
  }
}

// ─── Chairperson Override (SELF_REVIEW_EXCEPTION) ───────────────────────────

/**
 * Log a Chairperson override action to the audit_log table.
 * Must be called whenever a Chair uses "O" permission to assume another role.
 */
export async function logSelfReviewException(params: {
  userId: string;
  entityType: string;
  entityId: string;
  assumedRole: Role;
  comment?: string;
}): Promise<void> {
  const supabase = createClient();

  await supabase.from("audit_log").insert({
    user_id: params.userId,
    action_type: "SELF_REVIEW_EXCEPTION" as AuditActionType,
    entity_type: params.entityType,
    entity_id: params.entityId,
    assumed_role: params.assumedRole,
    comment: params.comment ?? `Chairperson assumed ${params.assumedRole} role`,
    metadata: {
      override_timestamp: new Date().toISOString(),
      assumed_role: params.assumedRole,
    },
  });
}

/**
 * Generic audit log helper for any auditable action.
 */
export async function logAuditAction(params: {
  userId: string;
  actionType: AuditActionType;
  entityType: string;
  entityId: string;
  assumedRole?: Role;
  comment?: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const supabase = createClient();

  await supabase.from("audit_log").insert({
    user_id: params.userId,
    action_type: params.actionType,
    entity_type: params.entityType,
    entity_id: params.entityId,
    assumed_role: params.assumedRole ?? null,
    comment: params.comment ?? null,
    metadata: params.metadata ?? null,
  });
}

// ─── HO District Segregation ────────────────────────────────────────────────

/**
 * Get the district IDs assigned to an HO user.
 * All HO queries must be filtered by these districts.
 */
export async function getHODistrictIds(userId: string): Promise<string[]> {
  const supabase = createClient();

  const { data } = await supabase
    .from("ho_district_assignments")
    .select("district_id")
    .eq("user_id", userId);

  return (data ?? []).map((d) => d.district_id);
}

// ─── Secretary Guard ────────────────────────────────────────────────────────

/**
 * Check if the current context is "Secretary viewing totals only".
 * Use this to conditionally hide line items, proof images, and details.
 */
export function isSecretaryRestricted(role: Role, moduleFunction: string): boolean {
  return role === "Secretary" && isTotalsOnly(role, moduleFunction);
}

// ─── Scope Validation ───────────────────────────────────────────────────────

/**
 * Check if a user has access to a specific congregation based on their scope.
 * For HO users, also checks ho_district_assignments.
 */
export async function canAccessCongregation(
  access: UserHierarchyAccess,
  congregationId: string
): Promise<boolean> {
  // Direct congregation assignment
  if (access.congregation_id === congregationId) return true;

  // Higher-scope roles can see all below them (validated by RLS)
  if (access.scope_level !== "Congregation") return true;

  // HO must have district assignment (checked via RLS, but also here for UI gating)
  if (access.role === "HO") {
    const districts = await getHODistrictIds(access.user_id);
    if (districts.length === 0) return false;
    // RLS handles the actual filtering, this is for UI gating
    return true;
  }

  return false;
}
