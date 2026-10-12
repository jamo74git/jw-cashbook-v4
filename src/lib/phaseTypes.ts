// ─────────────────────────────────────────────────────────────────────────────
// PHASE B–D FOUNDATION TYPES (Census / Growth / New Members).
// Additive, schema-only in Phase A — no UI, no write path yet. These enums and
// interfaces mirror the Supabase stub tables created in migration 009 and the Dexie
// stub stores (schema.ts v3). Encrypted member fields hold ciphertext only (produced
// later by a dedicated field-encryption helper); crypto.ts is frozen in Phase A.
// ─────────────────────────────────────────────────────────────────────────────

// ─── Attendance types (visitors are EXCLUDED from the attendance % calculation) ──
export const ATTENDANCE_TYPES = [
  "normal",
  "combined_eldership",
  "combined_youth",
  "combined_seniors",
  "festival",
] as const;
export type AttendanceType = (typeof ATTENDANCE_TYPES)[number];

// ─── Census buckets (age/standing classification) ────────────────────────────
export const CENSUS_BUCKETS = [
  "child_0_15",
  "unconfirmed_youth",
  "confirmed_youth",
  "adult",
  "senior",
] as const;
export type CensusBucket = (typeof CENSUS_BUCKETS)[number];

// ─── New member register entry type: AT / CT / CB ────────────────────────────
export const NEW_MEMBER_TYPES = ["AT", "CT", "CB"] as const;
export type NewMemberType = (typeof NEW_MEMBER_TYPES)[number];

// ─── Entity interfaces (mirror the Supabase stub tables) ──────────────────────

export interface CensusCongregation {
  id: string;
  congregation_id: string;
  year: number;
  month: number;
  total_members: number | null;
  // ── Phase B: additive breakdown fields (mirror schema.ts LocalCensusCongregation) ──
  families?: number | null;
  contact_points?: number | null;
  total_souls?: number | null;
  adults?: number | null;
  children_0_15?: number | null;
  unconfirmed_youth?: number | null;
  confirmed_youth?: number | null;
  seniors?: number | null;
  mem_breakdown?: Record<string, unknown> | null;
  source?: "upload" | "manual" | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface CensusPriestship {
  id: string;
  congregation_id: string;
  priest_id: string | null;
  member_count: number | null;
  // ── Phase B: additive split metrics (mirror schema.ts LocalCensusPriestship) ──
  families?: number | null;
  contact_points?: number | null;
  souls?: number | null;
  // Staleness anchor for the 3mo (90d) / 6mo (180d) verification flags.
  last_verified_at: string | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface AttendanceMonthly {
  id: string;
  congregation_id: string;
  year: number;
  month: number;
  attendance_type: AttendanceType;
  attendance_count: number | null;
  // Visitors are tracked but EXCLUDED from the attendance % calculation.
  visitors: number;
  // Captured sign-offs, free-form jsonb (role -> signature metadata).
  signatures: Record<string, unknown> | null;
  created_at: string | null;
  updated_at: string | null;
}

export interface NewMemberRegister {
  id: string;
  congregation_id: string;
  type: NewMemberType;
  // Ciphertext only — no plaintext PII is ever stored.
  first_name_enc: string | null;
  last_name_enc: string | null;
  census_bucket: CensusBucket;
  // Storage paths into the private 'member-docs' bucket.
  photo_path: string | null;
  consent_path: string | null;
  created_at: string | null;
  updated_at: string | null;
}

// ─── Treasurer/Chair settings columns added additively to congregation_settings ──
export interface CongregationSettingsExtra {
  hall_capacity: number | null;
  allow_treasurer_census: boolean;
  allow_treasurer_new_members: boolean;
  allow_treasurer_baptisms: boolean;
  last_census_verified_at: string | null;
  created_at: string | null;
  updated_at: string | null;
}
