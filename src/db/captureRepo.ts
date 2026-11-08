// ─────────────────────────────────────────────────────────────────────────────
// CAPTURE REPO (v2) — local-first data layer over the Dexie Local_Store.
// Mirrors the real cashbook_period / cashbook_line_item model. Offline writes go
// here with zero network latency; the Sync_Engine reconciles to Supabase.
// ─────────────────────────────────────────────────────────────────────────────

import {
  db,
  type LocalPeriod,
  type LocalLineItem,
  type OfficerLookup,
  type ItemType,
  type PeriodStatus,
} from "@/db/schema";
import type { Role, LineSection } from "@/lib/types";
import type { MonthStatus } from "@/lib/phaseTypes";
import { computeRequiredManifest } from "@/lib/completeCapture";
import { getOrCreateDeviceId } from "@/lib/deviceId";
import { getCurrentOacWeek, isFutureOacService } from "@/lib/oacWeeks";
import { isFutureDate } from "@/lib/captureTotals";

export type TabKey = "Members" | "Officers" | "Burial" | "Expenses" | "Banking";

function uuid(): string {
  return globalThis.crypto.randomUUID();
}
function now(): string {
  return new Date().toISOString();
}
function naturalKeyOf(congregationId: string, weekKey: string, service: "AM" | "PM"): string {
  return `${congregationId}|${weekKey}|${service}`;
}

// ─── Periods (provisional, keyed by natural key) ─────────────────────────────
export interface NewPeriodInput {
  congregationId: string;
  weekKey: string;
  service: "AM" | "PM";
  year: number;
  month: number;
  week: number;
  userId: string;
}

/** Resolve the local period for (congregation, week, service) or create a Draft. */
export async function getOrCreateLocalPeriod(input: NewPeriodInput): Promise<LocalPeriod> {
  const naturalKey = naturalKeyOf(input.congregationId, input.weekKey, input.service);
  const existing = await db.periods.where("naturalKey").equals(naturalKey).first();
  if (existing) return existing;
  // Task 2: block CREATING a new future-dated period (existing records are returned above, so an
  // existing future test period is preserved). Current + historical (catch-up) capture is allowed.
  if (isFutureOacService(input.year, input.month, input.week)) {
    throw new Error("Cannot capture a future service date. Select the current or a past week.");
  }

  const ts = now();
  const deviceId = await getOrCreateDeviceId();
  const period: LocalPeriod = {
    localId: uuid(),
    naturalKey,
    serverId: null,
    congregationId: input.congregationId,
    year: input.year,
    month: input.month,
    week: input.week,
    weekKey: input.weekKey,
    service: input.service,
    status: "Draft",
    submittedAt: null,
    capturedByUserId: input.userId,
    requestorComment: null,
    elderApprovalComment: null,
    depositBlob: null,
    depositFileName: null,
    depositDate: null,
    depositBankRef: null,
    localStatus: "pending",
    createdAt: ts,
    updatedAt: ts,
    syncAttempts: 0,
    lastError: null,
    // MVP hardening v5 additive defaults.
    r0ConfirmedBy: null,
    r0ConfirmedAt: null,
    r0DeviceId: null,
    actingAsRole: null,
    actingAsAuditedAt: null,
    captureDeviceId: deviceId,
    closedAt: null,
    monthStatus: "Open",
    monthSubmittedToOverseerAt: null,
    monthSubmittedBy: null,
  };
  await db.periods.add(period);
  return period;
}

export async function getPeriod(localId: string): Promise<LocalPeriod | undefined> {
  return db.periods.get(localId);
}

export async function listPeriods(congregationId?: string): Promise<LocalPeriod[]> {
  const rows = congregationId
    ? await db.periods.where("congregationId").equals(congregationId).toArray()
    : await db.periods.toArray();
  return rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

export function isPeriodEditable(period: Pick<LocalPeriod, "status">): boolean {
  return period.status === "Draft" || period.status === "Rejected";
}

async function touchPeriod(periodLocalId: string): Promise<void> {
  // Task 1: a local change re-queues a previously-synced period for the next sync pass so the
  // edit is reconciled (never silently stranded). Does not disturb conflict/failed/syncing.
  const p = await db.periods.get(periodLocalId);
  const requeue = p && p.localStatus === "synced" ? { localStatus: "pending" as const } : {};
  await db.periods.update(periodLocalId, { updatedAt: now(), ...requeue });
}

export async function setPeriodStatus(periodLocalId: string, status: PeriodStatus): Promise<void> {
  await db.periods.update(periodLocalId, { status, updatedAt: now(), localStatus: "pending" });
}

/**
 * Complete_Capture: submit a period for audit (soft-lock) AND freeze the revision +
 * its Required_Manifest (the proof LIST belonging to this exact revision). A
 * re-submission after a rejection freezes a NEW revision with a FRESH manifest.
 *
 * `Submitted` only locks local editing; it is NOT "Ready for Audit". Proofs recorded
 * as declared-outstanding in the frozen manifest may legitimately finish uploading
 * AFTER submission; approval opens only once evidence + balance verify for this revision.
 * Governance gating (who may sign off) is resolved by the UI via `resolveSignOff`.
 */
export async function submitPeriod(
  periodLocalId: string,
  comments?: {
    requestorComment?: string;
    elderApprovalComment?: string;
    // When a Chairperson submits on behalf of the Treasurer (Decision 5). The
    // ACTING_AS_TREASURER audit row is flushed by the Sync_Engine once this period
    // syncs (offline) / can be logged online by the caller.
    actingAsRole?: Role | null;
    // Complete_Capture sign-off: Treasurer by default; anyone else = recorded exception.
    signOff?: {
      role: Role; // role signed off AS (Treasurer)
      isException: boolean;
      reason?: string | null;
      completedByUserId: string;
    };
  }
): Promise<void> {
  // Task 2: never submit a future-dated service.
  const fp = await db.periods.get(periodLocalId);
  if (fp && isFutureOacService(fp.year, fp.month, fp.week)) {
    throw new Error("Cannot submit a future-dated service.");
  }
  const ts = now();
  const revision = (fp?.completeCaptureRevision ?? 0) + 1;
  const items = await getLineItems(periodLocalId);
  const manifest = computeRequiredManifest(items, {
    revision,
    frozenAt: ts,
    depositSlipKey: fp?.depositObjectKey ?? null,
  });
  await db.periods.update(periodLocalId, {
    status: "Submitted",
    submittedAt: ts,
    requestorComment: comments?.requestorComment ?? null,
    elderApprovalComment: comments?.elderApprovalComment ?? null,
    actingAsRole: comments?.actingAsRole ?? null,
    // Complete_Capture freeze.
    completeCaptureRevision: revision,
    completedAt: ts,
    completedByUserId: comments?.signOff?.completedByUserId ?? fp?.capturedByUserId ?? null,
    signOffRole: comments?.signOff?.role ?? null,
    signOffIsException: comments?.signOff?.isException ?? null,
    signOffReason: comments?.signOff?.reason ?? null,
    requiredManifest: manifest,
    updatedAt: ts,
    localStatus: "pending",
  });
}

// ─── R0 "No tithing this week" (MVP hardening v5, R0 RULE) ───────────────────
// Resolve/create the period, then take it straight Draft -> Submitted (for audit)
// with the full R0 audit trail. No line items are captured. The week still flows
// Submitted -> AuditApproved like any other, preserving the audit trail.
export async function confirmR0NoTithing(input: {
  congregationId: string;
  weekKey: string;
  service: "AM" | "PM";
  year: number;
  month: number;
  week: number;
  userId: string;
  actingAsRole: Role | null;
}): Promise<LocalPeriod> {
  const period = await getOrCreateLocalPeriod({
    congregationId: input.congregationId,
    weekKey: input.weekKey,
    service: input.service,
    year: input.year,
    month: input.month,
    week: input.week,
    userId: input.userId,
  });
  const ts = now();
  const deviceId = await getOrCreateDeviceId();
  const revision = (period.completeCaptureRevision ?? 0) + 1;
  // R0 has no line items: an empty, balanced manifest frozen against this revision.
  const manifest = computeRequiredManifest([], { revision, frozenAt: ts, depositSlipKey: null });
  await db.periods.update(period.localId, {
    status: "Submitted",
    submittedAt: ts,
    r0ConfirmedBy: input.userId,
    r0ConfirmedAt: ts,
    r0DeviceId: deviceId,
    actingAsRole: input.actingAsRole,
    // Complete_Capture freeze for the zero-value submission.
    completeCaptureRevision: revision,
    completedAt: ts,
    completedByUserId: input.userId,
    signOffRole: "Treasurer",
    signOffIsException: input.actingAsRole != null,
    signOffReason: input.actingAsRole != null ? "No-tithing confirmation (acting as Treasurer)" : null,
    requiredManifest: manifest,
    localStatus: "pending",
    updatedAt: ts,
  });
  return (await db.periods.get(period.localId)) ?? period;
}

// ─── New-Week guard support: weeks not yet Closed, before the current week ────
// Distinct from dashboardRepo.countOutstandingWeeks (a localStatus-based KPI): this
// is the capture guard's definition — any period not yet AuditApproved whose
// [year, month, week] precedes the current OAC week. Returned oldest-first.
export async function listOutstandingWeeks(
  congregationId: string,
  now: Date = new Date()
): Promise<LocalPeriod[]> {
  const cur = getCurrentOacWeek(now);
  const curWeekNum = parseInt(cur.weekKey.split("-W")[1] ?? "0", 10);
  const periods = await db.periods.where("congregationId").equals(congregationId).toArray();
  const precedesCurrent = (p: LocalPeriod): boolean => {
    if (p.year !== cur.year) return p.year < cur.year;
    if (p.month !== cur.month) return p.month < cur.month;
    return p.week < curWeekNum;
  };
  return periods
    .filter((p) => p.status !== "AuditApproved" && precedesCurrent(p))
    .sort((a, b) => {
      if (a.year !== b.year) return a.year - b.year;
      if (a.month !== b.month) return a.month - b.month;
      return a.week - b.week;
    });
}

// ─── Auditor approval: Draft/Submitted -> AuditApproved (UI "Closed") ─────────
export async function setClosed(periodLocalId: string): Promise<void> {
  await db.periods.update(periodLocalId, {
    status: "AuditApproved",
    closedAt: now(),
    updatedAt: now(),
    localStatus: "pending",
  });
}

// ─── Month status machine (Decision 2) ────────────────────────────────────────
// If EVERY period of (congregation, year, month) is AuditApproved, set monthStatus
// to "AllWeeksClosed" across all of them (unless already further along). Returns the
// resulting MonthStatus for that month (defaults to "Open" when no periods exist).
export async function recomputeMonthStatus(
  congregationId: string,
  year: number,
  month: number
): Promise<MonthStatus> {
  const periods = (await db.periods.where("congregationId").equals(congregationId).toArray()).filter(
    (p) => p.year === year && p.month === month
  );
  if (periods.length === 0) return "Open";

  // Preserve a month that has already advanced beyond AllWeeksClosed.
  const advanced = periods.find(
    (p) => p.monthStatus === "MonthSubmittedToOverseer" || p.monthStatus === "SubmittedToHO"
  );
  if (advanced) return advanced.monthStatus ?? "Open";

  const allClosed = periods.every((p) => p.status === "AuditApproved");
  const next: MonthStatus = allClosed ? "AllWeeksClosed" : "Open";
  const ts = now();
  for (const p of periods) {
    if ((p.monthStatus ?? "Open") !== next) {
      await db.periods.update(p.localId, { monthStatus: next, updatedAt: ts });
    }
  }
  return next;
}

// ─── Chair/Elder bulk MONTH submit to Overseer (Decision 2) ───────────────────
// Guard: only proceed when the month is AllWeeksClosed. Sets MonthSubmittedToOverseer
// across every period of (congregation, year, month). Overseer->HO (SubmittedToHO) is
// modeled only — no action here.
export async function bulkSubmitMonthToOverseer(input: {
  congregationId: string;
  year: number;
  month: number;
  userId: string;
}): Promise<MonthStatus> {
  const current = await recomputeMonthStatus(input.congregationId, input.year, input.month);
  if (current !== "AllWeeksClosed") return current;

  const periods = (
    await db.periods.where("congregationId").equals(input.congregationId).toArray()
  ).filter((p) => p.year === input.year && p.month === input.month);
  const ts = now();
  for (const p of periods) {
    await db.periods.update(p.localId, {
      monthStatus: "MonthSubmittedToOverseer",
      monthSubmittedToOverseerAt: ts,
      monthSubmittedBy: input.userId,
      updatedAt: ts,
      localStatus: "pending",
    });
  }
  return "MonthSubmittedToOverseer";
}

// ─── Line items ──────────────────────────────────────────────────────────────
export interface AddLineInput {
  officer_id?: string | null;
  type?: ItemType; // Members/Officers income type (EFT/DirectDebit/Cash)
  amount: number;
  receipt_number?: string | null; // Burial
  description?: string | null; // Expense
  transaction_date?: string | null;
  bank_reference?: string | null;
}

const TODAY = (): string => new Date().toISOString().slice(0, 10);

export async function addLineItem(
  periodLocalId: string,
  section: LineSection,
  input: AddLineInput
): Promise<string> {
  const localId = uuid();
  const is_officer = section === "Officers";
  let item_type: ItemType;
  let transaction_date: string | null;

  if (section === "Burial") {
    item_type = "Burial";
    transaction_date = TODAY(); // governance: forced today
  } else if (section === "Expenses") {
    item_type = "Expense";
    transaction_date = input.transaction_date ?? TODAY();
  } else {
    item_type = input.type ?? "Cash";
    transaction_date =
      item_type === "EFT" || item_type === "DirectDebit" ? input.transaction_date ?? null : TODAY();
  }

  // Task 1: EFT/DD transaction date may not be in the future (device-local date). Earlier dates
  // (incl. capturing an earlier week today) are allowed. Cash/deposit-slip dates are unaffected.
  if ((item_type === "EFT" || item_type === "DirectDebit") && isFutureDate(transaction_date)) {
    throw new Error("Transaction date cannot be in the future.");
  }

  const item: LocalLineItem = {
    localId,
    periodLocalId,
    serverId: null,
    section,
    is_officer,
    item_type,
    payment_type: item_type,
    officer_id: input.officer_id ?? null,
    amount: input.amount,
    item_count: null,
    receipt_number: section === "Burial" ? input.receipt_number ?? null : null,
    manual_reference: section === "Expenses" ? input.description ?? null : null,
    transaction_date,
    proof_status: null,
    proof_reference: input.bank_reference ?? null,
    proofBlob: null,
    proofFileName: null,
    proofBankRef: null,
    proofDate: null,
    localStatus: "pending",
  };
  await db.lineItems.add(item);
  await touchPeriod(periodLocalId);
  return localId;
}

export async function updateLineItem(localId: string, changes: Partial<LocalLineItem>): Promise<void> {
  // Task 1: reject a future EFT/DD transaction date at the data layer (backs up the UI check).
  if (changes.transaction_date !== undefined) {
    const existing = await db.lineItems.get(localId);
    const t = (changes.item_type ?? existing?.item_type) as string | undefined;
    if ((t === "EFT" || t === "DirectDebit") && isFutureDate(changes.transaction_date)) {
      throw new Error("Transaction date cannot be in the future.");
    }
  }
  // editing a line item marks it unacknowledged (pending) so a serverId alone can never be
  // mistaken for "the current version was synced". Callers may override explicitly.
  const next = "localStatus" in changes ? changes : { ...changes, localStatus: "pending" as const };
  await db.lineItems.update(localId, next);
  const item = await db.lineItems.get(localId);
  if (item) await touchPeriod(item.periodLocalId);
}

/** Switch income type; Cash clears count + any proof (cash-proof invariant). */
export async function setIncomeType(localId: string, type: ItemType): Promise<void> {
  const changes: Partial<LocalLineItem> =
    type === "Cash"
      ? { item_type: type, payment_type: type, item_count: null, proof_status: null, proofBlob: null, proofFileName: null, proofObjectKey: null, proofHash: null, proofSize: null }
      : { item_type: type, payment_type: type };
  await updateLineItem(localId, changes);
}

export async function deleteLineItem(localId: string): Promise<void> {
  const item = await db.lineItems.get(localId);
  await db.lineItems.delete(localId);
  if (item) await touchPeriod(item.periodLocalId);
}

export async function getLineItems(periodLocalId: string): Promise<LocalLineItem[]> {
  return db.lineItems.where("periodLocalId").equals(periodLocalId).toArray();
}

/** Multi-tab section filtering (matches f6145ff1 tabItems). */
export function tabItems(items: LocalLineItem[], tab: TabKey): LocalLineItem[] {
  switch (tab) {
    case "Members":
      return items.filter((i) => i.section === "Members" && !i.is_officer);
    case "Officers":
      return items.filter((i) => i.section === "Officers" && i.is_officer);
    case "Burial":
      return items.filter((i) => i.item_type === "Burial");
    case "Expenses":
      return items.filter((i) => i.item_type === "Expense");
    case "Banking":
      return items.filter((i) => ["EFT", "DirectDebit", "CashBanked"].includes(i.item_type));
    default:
      return [];
  }
}

// Tranche 4 r2 (R06): sha-256 hex of blob bytes, bound to a specific proof version.
async function sha256Hex(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const digest = await globalThis.crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ─── Proof + cash lifecycle ──────────────────────────────────────────────────
export async function attachProof(
  localId: string,
  proof: { blob: Blob; fileName: string; date?: string | null; bankRef?: string | null }
): Promise<void> {
  const proofHash = await sha256Hex(proof.blob);
  await updateLineItem(localId, {
    proofBlob: proof.blob,
    proofFileName: proof.fileName,
    proofDate: proof.date ?? null,
    proofBankRef: proof.bankRef ?? null,
    // Tranche 4 (item 4): NEW stable identity for THESE bytes (retries reuse it; replaced bytes get a fresh one).
    proofObjectKey: `${uuid()}-proof.${(proof.fileName.split(".").pop() ?? "jpg").toLowerCase()}`,
    // Tranche 4 r2 (R06): integrity expectation bound to these exact bytes.
    proofHash,
    proofSize: proof.blob.size,
  });
}

/**
 * Eligible pending cash for banking: Cash/CashPending in Members/Officers, plus all Burial
 * cash. Already-CashBanked items are excluded (prevents double-banking). Expenses do NOT
 * remove eligibility - they reduce the NET deposit amount, but the cash entries still exist
 * and must be banked; eligibility is by ENTRY EXISTENCE, never by a net==0 display.
 */
export function eligibleCashItems(items: LocalLineItem[]): LocalLineItem[] {
  return items.filter(
    (i) =>
      (["Cash", "CashPending"].includes(i.item_type) && ["Members", "Officers"].includes(i.section)) ||
      i.item_type === "Burial"
  );
}

/**
 * Bulk cash banking (matches f6145ff1): mark ALL eligible pending cash items (cash income +
 * all burial) as CashBanked and attach one deposit slip (held on the period; the sync engine
 * uploads it once and creates an attachment per banked item).
 *
 * Task 8: eligibility is re-checked INSIDE the same transaction as the update (protection
 * against the eligible set changing between check and write, incl. a stale screen). When there
 * is NO eligible pending cash it is a no-op: no deposit proof is created/replaced and NO
 * banking field is touched. Returns the number of items banked (0 => nothing eligible).
 */
export async function markCashBanked(
  periodLocalId: string,
  deposit: { blob: Blob; fileName: string; date?: string | null; bankRef?: string | null }
): Promise<number> {
  const depositHash = await sha256Hex(deposit.blob);
  const depositObjectKey = `${uuid()}-deposit-slip.${(deposit.fileName.split(".").pop() ?? "jpg").toLowerCase()}`;
  return db.transaction("rw", db.periods, db.lineItems, async () => {
    const items = await getLineItems(periodLocalId);
    const cashItems = eligibleCashItems(items);
    if (cashItems.length === 0) return 0; // Task 8: no eligible cash -> do not create/replace deposit
    await db.periods.update(periodLocalId, {
      depositBlob: deposit.blob,
      depositFileName: deposit.fileName,
      depositDate: deposit.date ?? TODAY(),
      depositBankRef: deposit.bankRef ?? null,
      // Tranche 4 (item 4): stable identity for the deposit-slip bytes.
      depositObjectKey,
      depositHash,
      depositSize: deposit.blob.size,
      updatedAt: now(),
    });
    for (const ci of cashItems) {
      await db.lineItems.update(ci.localId, { item_type: "CashBanked", payment_type: "CashBanked" });
    }
    return cashItems.length;
  });
}

// ─── Reference reads ───────────────────────────────────────────────────────
export async function listOfficers(congregationId: string): Promise<OfficerLookup[]> {
  return db.officers
    .where("congregation_id")
    .equals(congregationId)
    .and((o) => o.is_active)
    .toArray();
}

/** Priests only — used for the Members tab picker (per f6145ff1). */
export async function listPriests(congregationId: string): Promise<OfficerLookup[]> {
  const officers = await listOfficers(congregationId);
  return officers.filter((o) => o.rank === "Priest");
}

export async function getProofMandatory(congregationId: string): Promise<boolean> {
  const settings = await db.congregationSettings.get(congregationId);
  return settings?.proof_mandatory ?? false;
}

// ─── Override audit (Elder/Chairperson 'O' at submit, offline) ───────────────
// Queued as a pending period-level note flushed by the Sync_Engine; kept minimal
// here — the UI decides when to record it (Req 1.17).
export async function queueOverrideAudit(_params: {
  periodLocalId: string;
  userId: string;
  role: Role;
  assumedRole: Role;
}): Promise<void> {
  // Recorded via logSelfReviewException online; offline queueing handled in the UI
  // layer in a later task. Intentionally a no-op placeholder to keep the interface.
}
