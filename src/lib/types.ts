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

export const SERVICE_STATUSES = [
  "Draft",
  "PendingAudit",
  "AuditApproved",
  "AuditRejected",
  "SubmittedToOverseer",
  "OverseerApproved",
  "OverseerRejected",
  "SubmittedToHO",
  "HOReviewed",
] as const;

export type ServiceStatus = (typeof SERVICE_STATUSES)[number];

export const SERVICE_TYPES = ["AM", "PM"] as const;
export type ServiceType = (typeof SERVICE_TYPES)[number];

export const INCOME_TYPES = ["Cash", "EFT", "DirectDebit"] as const;
export type IncomeType = (typeof INCOME_TYPES)[number];

export const LINE_SECTIONS = ["Members", "Officers", "Burial", "Expenses"] as const;
export type LineSection = (typeof LINE_SECTIONS)[number];

export const PROOF_STATUSES = ["Pending", "Uploaded", "Deposited"] as const;
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

export interface CashbookService {
  id: string;
  congregation_id: string;
  year: number;
  month: number;
  week: number;
  service_type: ServiceType;
  service_date: string;
  status: ServiceStatus;
  captured_by: string | null;
  submitted_at: string | null;
  locked_at: string | null;
  requestor_comment: string | null;
  elder_approval_comment: string | null;
  expenses_total: number;
}

export interface CashbookLineItem {
  id: string;
  service_id: string;
  section: LineSection;
  officer_id: string | null;
  officer_code: string | null;
  income_type: IncomeType | null;
  amount: number;
  item_count: number | null;
  manual_reference: string | null;
  proof_status: ProofStatus | null;
  proof_image_url: string | null;
  expense_date: string | null;
  expense_description: string | null;
}

export interface Banking {
  id: string;
  service_id: string;
  payment_date: string;
  payment_type: string;
  amount: number;
  proof_status: ProofStatus;
  proof_image_url: string | null;
}

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

export interface VCashbookService {
  service_id: string;
  congregation_id: string;
  congregation_name: string;
  congregation_code: string;
  year: number;
  month: number;
  week: number;
  service_type: ServiceType;
  service_date: string;
  status: ServiceStatus;
  total_income: number;
  total_expenses: number;
  banked: number;
  members_total: number;
  officers_total: number;
  burial_total: number;
}

export interface VCashbookMonth {
  congregation_id: string;
  congregation_name: string;
  congregation_code: string;
  year: number;
  month: number;
  service_count: number;
  approved_count: number;
  all_approved: boolean;
  month_income: number;
  month_expenses: number;
  month_members: number;
  month_officers: number;
}

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
