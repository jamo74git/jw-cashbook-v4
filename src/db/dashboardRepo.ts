// ─────────────────────────────────────────────────────────────────────────────
// DASHBOARD REPO (Phase A) — read-only KPI + period-list query helpers for the
// Treasurer/Chair dashboard. Reads via the Dexie Local_Store singleton only; it
// never writes. captureRepo and syncEngine are frozen, so these new reads live here.
// ─────────────────────────────────────────────────────────────────────────────

import { db, type LocalPeriod, type LocalLineItem } from "@/db/schema";
import { incomeTotal, bankedTotal, type CaptureItem } from "@/lib/captureTotals";
import { getCurrentOacWeek, getOacWeeks } from "@/lib/oacWeeks";

// ─── Treasurer/Chair settings (flags default to false when absent) ────────────
export interface DashboardSettings {
  hall_capacity: number | null;
  allow_treasurer_census: boolean;
  allow_treasurer_new_members: boolean;
  allow_treasurer_baptisms: boolean;
}

export async function getDashboardSettings(congregationId: string): Promise<DashboardSettings> {
  const s = await db.congregationSettings.get(congregationId);
  return {
    hall_capacity: s?.hall_capacity ?? null,
    allow_treasurer_census: s?.allow_treasurer_census ?? false,
    allow_treasurer_new_members: s?.allow_treasurer_new_members ?? false,
    allow_treasurer_baptisms: s?.allow_treasurer_baptisms ?? false,
  };
}

// ─── Internal helpers ─────────────────────────────────────────────────────────
async function periodsFor(congregationId: string): Promise<LocalPeriod[]> {
  return db.periods.where("congregationId").equals(congregationId).toArray();
}

/** Compare periods by [year, month, week] descending (most recent first). */
function byWeekDesc(a: LocalPeriod, b: LocalPeriod): number {
  if (a.year !== b.year) return b.year - a.year;
  if (a.month !== b.month) return b.month - a.month;
  return b.week - a.week;
}

/** True if the period precedes the current OAC week ([year,month,week] tuple compare). */
function isBeforeCurrentWeek(p: LocalPeriod): boolean {
  const cur = getCurrentOacWeek();
  const curWeekNum = parseInt(cur.weekKey.split("-W")[1] ?? "0", 10);
  if (p.year !== cur.year) return p.year < cur.year;
  if (p.month !== cur.month) return p.month < cur.month;
  return p.week < curWeekNum;
}

function toCaptureItems(items: LocalLineItem[]): CaptureItem[] {
  return items.map((i) => ({
    section: i.section,
    item_type: i.item_type,
    amount: i.amount,
    proof_status: i.proof_status,
    item_count: i.item_count,
  }));
}

async function lineItemsForPeriod(periodLocalId: string): Promise<LocalLineItem[]> {
  return db.lineItems.where("periodLocalId").equals(periodLocalId).toArray();
}

// ─── KPI 1: Outstanding weeks (not synced, before the current week) ───────────
export async function countOutstandingWeeks(congregationId: string): Promise<number> {
  const periods = await periodsFor(congregationId);
  return periods.filter((p) => p.localStatus !== "synced" && isBeforeCurrentWeek(p)).length;
}

// ─── KPI 2: This month captured vs banked ─────────────────────────────────────
export interface CapturedVsBanked {
  captured: number;
  banked: number;
}

export async function getThisMonthCapturedVsBanked(congregationId: string): Promise<CapturedVsBanked> {
  const cur = getCurrentOacWeek();
  const periods = (await periodsFor(congregationId)).filter(
    (p) => p.year === cur.year && p.month === cur.month
  );
  const allItems: LocalLineItem[] = [];
  for (const p of periods) {
    allItems.push(...(await lineItemsForPeriod(p.localId)));
  }
  const items = toCaptureItems(allItems);
  return { captured: incomeTotal(items), banked: bankedTotal(items) };
}

// ─── KPI 3: Officer faithfulness (active officers with 0 in the last 4 periods) ──
export async function countOfficerFaithfulness(congregationId: string): Promise<number> {
  const recent = (await periodsFor(congregationId)).sort(byWeekDesc).slice(0, 4);
  const referenced = new Set<string>();
  for (const p of recent) {
    const items = await lineItemsForPeriod(p.localId);
    for (const i of items) {
      if (i.officer_id) referenced.add(i.officer_id);
    }
  }
  const officers = await db.officers
    .where("congregation_id")
    .equals(congregationId)
    .and((o) => o.is_active)
    .toArray();
  return officers.filter((o) => !referenced.has(o.id)).length;
}

// ─── KPI 4: Interim officers in use this month ────────────────────────────────
export async function countInterimInUse(congregationId: string): Promise<number> {
  const cur = getCurrentOacWeek();
  const periods = (await periodsFor(congregationId)).filter(
    (p) => p.year === cur.year && p.month === cur.month
  );
  const interimIds = new Set(
    (
      await db.officers
        .where("congregation_id")
        .equals(congregationId)
        .and((o) => o.is_interim === true)
        .toArray()
    ).map((o) => o.id)
  );
  if (interimIds.size === 0) return 0;
  const used = new Set<string>();
  for (const p of periods) {
    const items = await lineItemsForPeriod(p.localId);
    for (const i of items) {
      if (i.officer_id && interimIds.has(i.officer_id)) used.add(i.officer_id);
    }
  }
  return used.size;
}

// ─── Last 8 periods (enriched for the dashboard list) ─────────────────────────
export interface RecentPeriodRow {
  localId: string;
  weekKey: string;
  weekEnding: string; // human label (OAC week date) or weekKey fallback
  status: LocalPeriod["status"];
  localStatus: LocalPeriod["localStatus"];
  service: "AM" | "PM";
  total: number;
  banked: number;
  hasInterim: boolean;
}

export async function listRecentPeriods(
  congregationId: string,
  limit = 8
): Promise<RecentPeriodRow[]> {
  const periods = (await periodsFor(congregationId)).sort(byWeekDesc).slice(0, limit);

  const rows: RecentPeriodRow[] = [];
  for (const p of periods) {
    const lineItems = await lineItemsForPeriod(p.localId);
    const items = toCaptureItems(lineItems);
    const interimIds = new Set(
      (
        await db.officers
          .where("congregation_id")
          .equals(p.congregationId)
          .and((o) => o.is_interim === true)
          .toArray()
      ).map((o) => o.id)
    );
    const hasInterim = lineItems.some((i) => i.officer_id != null && interimIds.has(i.officer_id));

    const week = getOacWeeks(p.year, p.month).find((w) => w.weekKey === p.weekKey);
    rows.push({
      localId: p.localId,
      weekKey: p.weekKey,
      weekEnding: week?.label ?? p.weekKey,
      status: p.status,
      localStatus: p.localStatus,
      service: p.service,
      total: incomeTotal(items),
      banked: bankedTotal(items),
      hasInterim,
    });
  }
  return rows;
}
