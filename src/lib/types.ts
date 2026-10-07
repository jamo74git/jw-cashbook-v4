// ═══════════════════════════════════════════════════════════════════════════════
// OAC MANAGEMENT SYSTEM — SHARED TYPES
// ═══════════════════════════════════════════════════════════════════════════════

// ─── Roles & Hierarchy ──────────────────────────────────────────────────────

export const ROLES = [
  "HO",
  "Apostle",
  "Overseer",
  "Elder",
  "Chairperson",
  "Treasurer",
  "Auditor",
  "Secretary",
] as const;

export type Role = (typeof ROLES)[number];

export const HIERARCHY_LEVELS = [
  "Conference",
  "Apostolate",
  "District",
  "Apostleship",
  "Overseership",
  "Eldership",
  "Congregation",
] as const;

export type HierarchyLevel = (typeof HIERARCHY_LEVELS)[number];

// ─── Status Flows ───────────────────────────────────────────────────────────

// Real cashbook_period.status enum (generated from project cwdyixafvylzgtpsfmwr).
export const SERVICE_STATUSES = [
  "Draft",
  "Submitted",
  "AuditApproved",
  "SubmittedToOverseer",
  "Rejected",
  "SubmittedToHO",
  "HOReviewed",
] as const;

export type ServiceStatus = (typeof SERVICE_STATUSES)[number];

export const SERVICE_TYPES = ["AM", "PM"] as const;
export type ServiceType = (typeof SERVICE_TYPES)[number];
// NOTE: there is no fictional `income_type` column on the real schema — payment_type
// (EFT | DirectDebit | Cash) is the real field. The old INCOME_TYPES enum was deleted
// as part of the drift realignment (A8).

export const LINE_SECTIONS = ["Members", "Officers", "Burial", "Expenses"] as const;
export type LineSection = (typeof LINE_SECTIONS)[number];

// Real cashbook proof-status enum (generated from project cwdyixafvylzgtpsfmwr).
export const PROOF_STATUSES = ["Pending", "Deposited", "NA"] as const;
export type ProofStatus = (typeof PROOF_STATUSES)[number];

export const AUDIT_ACTION_TYPES = [
  "CAPTURE",
  "SUBMIT",
  "AUDIT_APPROVE",
  "AUDIT_REJECT",
  "OVERSEER_APPROVE",
  "OVERSEER_REJECT",
  "HO_REVIEW",
  "SELF_REVIEW_EXCEPTION",
  "BULK_IMPORT",
  "CENSUS_UPDATE",
  "MONTH_SUBMIT",
  "MONTH_SUBMIT_TO_HO",
  "CORRECTION",
  "UNLOCK",
] as const;

export type AuditActionType = (typeof AUDIT_ACTION_TYPES)[number];

// ─── Census Staleness ───────────────────────────────────────────────────────

export const STALENESS_FLAGS = ["GREEN", "ORANGE", "RED"] as const;
export type StalenessFlag = (typeof STALENESS_FLAGS)[number];

// ─── DB Entity Interfaces ───────────────────────────────────────────────────

export interface HierarchyNode {
  id: string;
  level_type: HierarchyLevel;
  name: string;
  code: string;
  parent_id: string | null;
}

export interface Congregation {
  id: string;
  hierarchy_id: string;
  name: string;
  code: string;
  eldership_id: string | null;
  overseership_id: string | null;
  apostleship_id: string | null;
  district_id: string | null;
}

export interface Officer {
  id: string;
  congregation_id: string;
  officer_code: string;
  first_name: string;
  last_name: string;
  rank: string;
  is_active: boolean;
}

export interface UserHierarchyAccess {
  id: string;
  user_id: string;
  role: Role;
  hierarchy_id: string;
  congregation_id: string | null;
  scope_level: HierarchyLevel;
  status: "active" | "inactive";
  start_date: string;
  end_date: string | null;
}

export interface HODistrictAssignment {
  id: string;
  user_id: string;
  district_id: string;
  assigned_at: string;
  assigned_by: string | null;
}

// Mirrors the real `cashbook_period` table (generated from cwdyixafvylzgtpsfmwr).
export interface CashbookPeriod {
  id: string;
  congregation_id: string;
  year: number;
  month: number;
  week: number;
  week_key: string | null;
  service: string;
  status: ServiceStatus;
  submitted_at: string | null;
  submitted_by: string | null;
  requestor_comment: string | null;
  elder_approval_comment: string | null;
  audit_comment: string | null;
  expenses_total: number | null;
  created_at: string | null;
}

// Mirrors the real `cashbook_line_item` table (generated from cwdyixafvylzgtpsfmwr).
export interface CashbookLineItem {
  id: string;
  period_id: string;
  section: LineSection;
  is_officer: boolean;
  officer_id: string | null;
  item_type: string;
  payment_type: string | null;
  amount: number;
  item_count: number | null;
  manual_reference: string | null;
  receipt_number: string | null;
  transaction_date: string;
  proof_status: ProofStatus | null;
  proof_reference: string | null;
  approved: boolean | null;
}

// DELETED (A8 drift realignment): the fictional `Banking` interface declared
// `service_id` / `proof_image_url`, neither of which exist. There is no `banking`
// table; proof lives on `cashbook_attachment.file_url`.

export interface PriestCensus {
  id: string;
  congregation_id: string;
  priest_id: string;
  year: number;
  month: number;
  eligible_to_tithe: number;
  children: number;
  youth: number;
  adults: number;
  seniors: number;
  total_members: number;
  underdeacon_count: number;
  captured_by: string | null;
  captured_at: string | null;
  updated_at: string | null;
  locked: boolean;
}

export interface AuditLogEntry {
  id: string;
  user_id: string;
  action_type: AuditActionType;
  entity_type: string;
  entity_id: string;
  assumed_role: Role | null;
  comment: string | null;
  metadata: Record<string, unknown> | null;
  created_at: string;
}

// ─── Permission Codes (from permission_matrix_v3.txt) ───────────────────────

export const PERMISSION_CODES = {
  VIEW: "V",
  CREATE: "C",
  EDIT: "E",
  APPROVE: "A",
  SUBMIT: "S",
  EXPORT: "X",
  MANAGE: "M",
  OVERRIDE: "O",
  REPLY: "R",
  NO_ACCESS: "-",
  TOTALS_ONLY: "T",   // Secretary special
} as const;

export type PermissionCode = (typeof PERMISSION_CODES)[keyof typeof PERMISSION_CODES];

// ─── View Interfaces (for reporting) ────────────────────────────────────────
//
// DELETED (A8 drift realignment): the fictional reporting views `VCashbookService`
// (declared `service_id` / `service_type` / `service_date`) and `VCashbookMonth`.
// Neither `v_cashbook_service` nor `v_cashbook_month` exists — the real reporting
// view is `v_congregation_month_status`. Reporting references the real
// `CashbookPeriod` grain instead.

export interface VCensusHealth {
  congregation_id: string;
  congregation_name: string;
  priest_id: string;
  officer_code: string;
  priest_name: string;
  year: number;
  month: number;
  total_members: number;
  eligible_to_tithe: number;
  updated_at: string;
  locked: boolean;
  staleness_flag: StalenessFlag;
}
