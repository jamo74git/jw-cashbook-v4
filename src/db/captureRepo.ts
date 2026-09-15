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

  const ts = now();
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
  await db.periods.update(periodLocalId, { updatedAt: now() });
}

export async function setPeriodStatus(periodLocalId: string, status: PeriodStatus): Promise<void> {
  await db.periods.update(periodLocalId, { status, updatedAt: now(), localStatus: "pending" });
}

/** Submit a period for audit (soft-lock). Governance gating is enforced by the UI. */
export async function submitPeriod(
  periodLocalId: string,
  comments?: { requestorComment?: string; elderApprovalComment?: string }
): Promise<void> {
  await db.periods.update(periodLocalId, {
    status: "Submitted",
    submittedAt: now(),
    requestorComment: comments?.requestorComment ?? null,
    elderApprovalComment: comments?.elderApprovalComment ?? null,
    updatedAt: now(),
    localStatus: "pending",
  });
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
  await db.lineItems.update(localId, changes);
  const item = await db.lineItems.get(localId);
  if (item) await touchPeriod(item.periodLocalId);
}

/** Switch income type; Cash clears count + any proof (cash-proof invariant). */
export async function setIncomeType(localId: string, type: ItemType): Promise<void> {
  const changes: Partial<LocalLineItem> =
    type === "Cash"
      ? { item_type: type, payment_type: type, item_count: null, proof_status: null, proofBlob: null, proofFileName: null }
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

// ─── Proof + cash lifecycle ──────────────────────────────────────────────────
export async function attachProof(
  localId: string,
  proof: { blob: Blob; fileName: string; date?: string | null; bankRef?: string | null }
): Promise<void> {
  await updateLineItem(localId, {
    proofBlob: proof.blob,
    proofFileName: proof.fileName,
    proofDate: proof.date ?? null,
    proofBankRef: proof.bankRef ?? null,
  });
}

/**
 * Bulk cash banking (matches f6145ff1): mark ALL pending cash items (cash income +
 * all burial) as CashBanked and attach one deposit slip (held on the period; the sync
 * engine uploads it once and creates an attachment per banked item).
 */
export async function markCashBanked(
  periodLocalId: string,
  deposit: { blob: Blob; fileName: string; date?: string | null; bankRef?: string | null }
): Promise<void> {
  const items = await getLineItems(periodLocalId);
  const cashItems = items.filter(
    (i) =>
      (["Cash", "CashPending"].includes(i.item_type) && ["Members", "Officers"].includes(i.section)) ||
      i.item_type === "Burial"
  );
  await db.transaction("rw", db.periods, db.lineItems, async () => {
    await db.periods.update(periodLocalId, {
      depositBlob: deposit.blob,
      depositFileName: deposit.fileName,
      depositDate: deposit.date ?? TODAY(),
      depositBankRef: deposit.bankRef ?? null,
      updatedAt: now(),
    });
    for (const ci of cashItems) {
      await db.lineItems.update(ci.localId, { item_type: "CashBanked", payment_type: "CashBanked" });
    }
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
