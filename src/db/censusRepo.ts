// ─────────────────────────────────────────────────────────────────────────────
// CENSUS REPO (Phase B) — Dexie-local read/write data layer for the Census
// Foundation. Reads/writes the Dexie Local_Store singleton directly, mirroring
// dashboardRepo.ts style. It NEVER imports the frozen captureRepo/syncEngine.
//
// Scope boundary (Decision D1): census writes are Dexie-local in Phase B. The
// Supabase census tables + migration 010 exist for schema parity only; there is
// no census → Supabase sync path (syncEngine is frozen) and none is added here.
// Depends on a prior online session having populated db.congregations / db.officers
// / db.congregationSettings (via cacheLoader).
//
// All balancing + inactivity rules live in the pure, unit-tested
// src/lib/censusBalancing.ts module (Decision D2); this repo delegates to it.
// ─────────────────────────────────────────────────────────────────────────────

import {
  db,
  type CongregationSettings,
  type OfficerLookup,
  type LocalCensusCongregation,
  type LocalCensusPriestship,
} from "@/db/schema";
import {
  checkSoulsBalance,
  checkPriestshipSplit,
  inactivityStatus,
  type SoulsBreakdown,
  type BalanceResult,
  type PriestshipMetrics,
  type PriestshipSplitResult,
  type InactivityStatus,
} from "@/lib/censusBalancing";

// ─── Month-key helpers (Decision D5: store year+month ints; API uses YYYY-MM) ──
/** Current OAC/calendar month as "YYYY-MM". */
export function monthKey(now: Date = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`;
}

/** Parse a "YYYY-MM" key into { year, month } integers. */
export function parseMonthKey(m: string): { year: number; month: number } {
  const [y, mo] = m.split("-");
  return { year: parseInt(y, 10), month: parseInt(mo, 10) };
}

// ─── Numeric coercion for parsed CSV/Excel cells (strings/blanks → number|null) ─
function toNum(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string") {
    const n = Number(v.trim());
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

function nowIso(): string {
  return new Date().toISOString();
}

// ─── Settings ─────────────────────────────────────────────────────────────────
/** Raw congregation_settings row (flags + last_census_verified_at), or null. */
export async function getCensusSettings(
  congregationId: string
): Promise<CongregationSettings | undefined> {
  return db.congregationSettings.get(congregationId);
}

/**
 * Read-merge-put the congregation_settings row, bumping last_census_verified_at.
 * Preserves every existing field (never clobbers proof_mandatory / flags).
 */
async function bumpLastCensusVerifiedAt(congregationId: string): Promise<void> {
  const existing = await db.congregationSettings.get(congregationId);
  const ts = nowIso();
  const merged: CongregationSettings = {
    ...(existing ?? { congregation_id: congregationId, proof_mandatory: false }),
    congregation_id: congregationId,
    last_census_verified_at: ts,
    updated_at: ts,
  };
  await db.congregationSettings.put(merged);
}

// ─── Priestships (an officer with rank === "Priest"; mirrors captureRepo.listPriests) ─
export async function listPriestships(congregationId: string): Promise<OfficerLookup[]> {
  return db.officers
    .where("congregation_id")
    .equals(congregationId)
    .and((o) => o.is_active && o.rank === "Priest")
    .toArray();
}

// ─── Overseership upload ──────────────────────────────────────────────────────
export interface OverseershipUploadRow {
  congregation_name: string;
  families?: unknown;
  contact_points?: unknown;
  total_souls?: unknown;
  adults?: unknown;
  children_0_15?: unknown;
  unconfirmed_youth?: unknown;
  confirmed_youth?: unknown;
  seniors?: unknown;
  mem_breakdown?: unknown;
  [key: string]: unknown;
}

export interface UploadRejection {
  row: OverseershipUploadRow;
  reason: "unknown_congregation" | "unbalanced";
  balance?: BalanceResult;
}

export interface SaveUploadResult {
  ok: boolean;
  savedCount: number;
  rejections: UploadRejection[];
}

function rowBreakdown(r: OverseershipUploadRow): SoulsBreakdown {
  return {
    adults: toNum(r.adults),
    children_0_15: toNum(r.children_0_15),
    unconfirmed_youth: toNum(r.unconfirmed_youth),
    confirmed_youth: toNum(r.confirmed_youth),
    seniors: toNum(r.seniors),
  };
}

function parseMemBreakdown(v: unknown): Record<string, unknown> | null {
  if (v == null || v === "") return null;
  if (typeof v === "object") return v as Record<string, unknown>;
  if (typeof v === "string") {
    try {
      const parsed = JSON.parse(v);
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** Resolve a congregation by case-insensitive name OR code match. */
async function resolveCongregationId(name: string): Promise<string | null> {
  const needle = name.trim().toLowerCase();
  if (!needle) return null;
  const all = await db.congregations.toArray();
  const match = all.find(
    (c) => c.name.trim().toLowerCase() === needle || c.code.trim().toLowerCase() === needle
  );
  return match?.id ?? null;
}

/**
 * Validate + persist an overseership upload for `month` ("YYYY-MM").
 * The WHOLE batch is rejected (nothing written) if ANY row is unbalanced
 * (total_souls ≠ breakdown sum) or references an unknown congregation; the
 * offending rows + diffs are returned. On success, upserts one census_congregation
 * row per congregation (source:"upload") and bumps last_census_verified_at.
 */
export async function saveOverseershipUpload(
  month: string,
  rows: OverseershipUploadRow[]
): Promise<SaveUploadResult> {
  const { year, month: mo } = parseMonthKey(month);
  const rejections: UploadRejection[] = [];

  // Pre-resolve + validate every row before writing anything (all-or-nothing).
  const resolved: Array<{ congregationId: string; row: OverseershipUploadRow; breakdown: SoulsBreakdown }> = [];
  for (const row of rows) {
    const congregationId = await resolveCongregationId(String(row.congregation_name ?? ""));
    if (!congregationId) {
      rejections.push({ row, reason: "unknown_congregation" });
      continue;
    }
    const breakdown = rowBreakdown(row);
    const balance = checkSoulsBalance(toNum(row.total_souls), breakdown);
    if (!balance.balanced) {
      rejections.push({ row, reason: "unbalanced", balance });
      continue;
    }
    resolved.push({ congregationId, row, breakdown });
  }

  if (rejections.length > 0) {
    return { ok: false, savedCount: 0, rejections };
  }

  const touched = new Set<string>();
  for (const { congregationId, row, breakdown } of resolved) {
    const existing = await db.censusCongregation
      .where("congregation_id")
      .equals(congregationId)
      .and((c) => c.year === year && c.month === mo)
      .first();
    const ts = nowIso();
    const totalSouls = toNum(row.total_souls);
    const record: LocalCensusCongregation = {
      id: existing?.id ?? crypto.randomUUID(),
      congregation_id: congregationId,
      year,
      month: mo,
      total_members: totalSouls,
      families: toNum(row.families),
      contact_points: toNum(row.contact_points),
      total_souls: totalSouls,
      adults: breakdown.adults,
      children_0_15: breakdown.children_0_15,
      unconfirmed_youth: breakdown.unconfirmed_youth,
      confirmed_youth: breakdown.confirmed_youth,
      seniors: breakdown.seniors,
      mem_breakdown: parseMemBreakdown(row.mem_breakdown),
      source: "upload",
      created_at: existing?.created_at ?? ts,
      updated_at: ts,
    };
    await db.censusCongregation.put(record);
    touched.add(congregationId);
  }

  for (const congregationId of touched) {
    await bumpLastCensusVerifiedAt(congregationId);
  }

  return { ok: true, savedCount: resolved.length, rejections: [] };
}

// ─── Congregation census reads/writes ─────────────────────────────────────────
/** All census_congregation rows for the given "YYYY-MM". */
export async function getCongregationCensus(month: string): Promise<LocalCensusCongregation[]> {
  const { year, month: mo } = parseMonthKey(month);
  return db.censusCongregation
    .where("year")
    .equals(year)
    .and((c) => c.month === mo)
    .toArray();
}

export interface CongregationTotalsInput {
  families: number;
  contact_points: number;
  total_souls: number;
  adults: number;
  children_0_15: number;
  unconfirmed_youth: number;
  confirmed_youth: number;
  seniors: number;
  mem_breakdown?: Record<string, unknown> | null;
}

export interface SaveTotalsResult {
  ok: boolean;
  balance: BalanceResult;
}

/**
 * Manual chair edit of a single congregation's totals for `month`. Re-runs the
 * souls balance and BLOCKS (nothing written) on mismatch, returning the diff.
 * On success upserts the row (source:"manual") and bumps last_census_verified_at.
 */
export async function saveCongregationTotals(
  congregationId: string,
  month: string,
  totals: CongregationTotalsInput
): Promise<SaveTotalsResult> {
  const breakdown: SoulsBreakdown = {
    adults: toNum(totals.adults),
    children_0_15: toNum(totals.children_0_15),
    unconfirmed_youth: toNum(totals.unconfirmed_youth),
    confirmed_youth: toNum(totals.confirmed_youth),
    seniors: toNum(totals.seniors),
  };
  const balance = checkSoulsBalance(toNum(totals.total_souls), breakdown);
  if (!balance.balanced) {
    return { ok: false, balance };
  }

  const { year, month: mo } = parseMonthKey(month);
  const existing = await db.censusCongregation
    .where("congregation_id")
    .equals(congregationId)
    .and((c) => c.year === year && c.month === mo)
    .first();
  const ts = nowIso();
  const totalSouls = toNum(totals.total_souls);
  const record: LocalCensusCongregation = {
    id: existing?.id ?? crypto.randomUUID(),
    congregation_id: congregationId,
    year,
    month: mo,
    total_members: totalSouls,
    families: toNum(totals.families),
    contact_points: toNum(totals.contact_points),
    total_souls: totalSouls,
    adults: breakdown.adults,
    children_0_15: breakdown.children_0_15,
    unconfirmed_youth: breakdown.unconfirmed_youth,
    confirmed_youth: breakdown.confirmed_youth,
    seniors: breakdown.seniors,
    mem_breakdown: totals.mem_breakdown ?? existing?.mem_breakdown ?? null,
    source: "manual",
    created_at: existing?.created_at ?? ts,
    updated_at: ts,
  };
  await db.censusCongregation.put(record);
  await bumpLastCensusVerifiedAt(congregationId);
  return { ok: true, balance };
}

// ─── Priestship split ─────────────────────────────────────────────────────────
/** All census_priestship rows for a congregation. */
export async function getPriestshipCensus(congregationId: string): Promise<LocalCensusPriestship[]> {
  return db.censusPriestship.where("congregation_id").equals(congregationId).toArray();
}

export interface PriestshipSplitInput extends PriestshipMetrics {
  priest_id: string | null;
}

export interface SplitResult {
  ok: boolean;
  balance: PriestshipSplitResult;
}

/**
 * Split the congregation's families/contact_points/souls across its priestships
 * for `month`. Validates the sums against the congregation totals (from the
 * census_congregation row) and BLOCKS (nothing written) on any mismatch,
 * returning the per-metric diffs. On success writes one census_priestship row per
 * split (last_verified_at = now) and bumps last_census_verified_at.
 */
export async function splitToPriestships(
  congregationId: string,
  month: string,
  splits: PriestshipSplitInput[]
): Promise<SplitResult> {
  const { year, month: mo } = parseMonthKey(month);
  const congRow = await db.censusCongregation
    .where("congregation_id")
    .equals(congregationId)
    .and((c) => c.year === year && c.month === mo)
    .first();

  const totals: PriestshipMetrics = {
    families: toNum(congRow?.families),
    contact_points: toNum(congRow?.contact_points),
    souls: toNum(congRow?.total_souls),
  };
  const rows: PriestshipMetrics[] = splits.map((s) => ({
    families: toNum(s.families),
    contact_points: toNum(s.contact_points),
    souls: toNum(s.souls),
  }));
  const balance = checkPriestshipSplit(rows, totals);
  if (!balance.allBalanced) {
    return { ok: false, balance };
  }

  const ts = nowIso();
  for (const s of splits) {
    const existing = await db.censusPriestship
      .where("congregation_id")
      .equals(congregationId)
      .and((p) => p.priest_id === s.priest_id)
      .first();
    const record: LocalCensusPriestship = {
      id: existing?.id ?? crypto.randomUUID(),
      congregation_id: congregationId,
      priest_id: s.priest_id,
      member_count: toNum(s.souls),
      families: toNum(s.families),
      contact_points: toNum(s.contact_points),
      souls: toNum(s.souls),
      last_verified_at: ts,
      created_at: existing?.created_at ?? ts,
      updated_at: ts,
    };
    await db.censusPriestship.put(record);
  }
  await bumpLastCensusVerifiedAt(congregationId);
  return { ok: true, balance };
}

// ─── Inactivity / staleness ────────────────────────────────────────────────────
/** Staleness flag for a last_verified_at timestamp (delegates to censusBalancing). */
export function getInactivityStatus(last_verified_at: string | null): InactivityStatus {
  return inactivityStatus(last_verified_at).status;
}

/** All census_priestship rows whose staleness flag is red (overdue / never verified). */
export async function getOverdueList(): Promise<LocalCensusPriestship[]> {
  const all = await db.censusPriestship.toArray();
  return all.filter((p) => getInactivityStatus(p.last_verified_at) === "red");
}
