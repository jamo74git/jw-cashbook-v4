// ─────────────────────────────────────────────────────────────────────────────
// LOCAL_STORE — Dexie.js (IndexedDB), version 2.
// v2 realigns the offline mirror to the REAL Supabase schema:
//   periods            <- cashbook_period (via get_or_create_period RPC at sync)
//   lineItems          <- cashbook_line_item
//   (proof Blob fields) <- cashbook_attachment (created at sync from the Blob)
//   congregationSettings <- congregation_settings (proof_mandatory)
// The obsolete v1 `captureQueue` (cashbook_service shape) is dropped. There is no
// production offline data yet, so the v2 upgrade clears legacy local rows.
// ─────────────────────────────────────────────────────────────────────────────

import Dexie, { type Table } from "dexie";
import type { Role, HierarchyLevel, LineSection } from "@/lib/types";

export type LocalSyncStatus = "pending" | "syncing" | "synced" | "conflict" | "failed";

// Real cashbook_period.status vocabulary (from f6145ff1) — NOTE this differs from the
// ServiceStatus enum in @/lib/types (Draft/PendingAudit/...); the app must write these
// real values. Discrepancy recorded for a later steering reconciliation.
export type PeriodStatus = "Draft" | "Rejected" | "Submitted" | "AuditApproved";

export type ItemType =
  | "EFT"
  | "DirectDebit"
  | "Cash"
  | "CashPending"
  | "CashBanked"
  | "Burial"
  | "Expense";

// ─── Cached_Credential (offline PIN auth) ────────────────────────────────────
export interface CachedCredential {
  userId: string;
  pinHash: string;
  salt: string;
  kdfIterations: number;
  hmac: string;
  role: Role;
  accessStartDate: string;
  accessEndDate: string | null;
  activatedAt: string;
  failedAttempts: number;
  lockedUntil: string | null;
}

// ─── Reference lookups (populated online by cacheLoader) ─────────────────────
export interface CongregationLookup {
  id: string;
  name: string;
  code: string;
  overseership_id: string | null;
  eldership_id: string | null;
  apostleship_id: string | null;
  district_id: string | null;
}

export interface HierarchyLookup {
  id: string;
  name: string;
  code: string;
  level_type: HierarchyLevel;
  parent_id: string | null;
}

export interface OfficerLookup {
  id: string;
  congregation_id: string;
  officer_code: string;
  first_name: string;
  last_name: string | null;
  rank: string; // "Priest" | "Underdeacon" | ...
  is_active: boolean;
  initials?: string | null;
  // Interim officer request flow (pending HO approval). Usable in capture immediately.
  is_interim?: boolean;
  status?: string | null; // e.g. "pending_ho_approval"
}

export interface CongregationSettings {
  congregation_id: string; // pk
  proof_mandatory: boolean;
}

// ─── Local period (mirrors cashbook_period) ──────────────────────────────────
// A provisional period is created offline keyed by naturalKey; the sync engine
// reconciles it to a server cashbook_period.id via get_or_create_period.
export interface LocalPeriod {
  localId: string; // client UUID (pk)
  naturalKey: string; // `${congregationId}|${weekKey}|${service}` (unique)
  serverId: string | null; // cashbook_period.id once reconciled
  congregationId: string;
  year: number;
  month: number;
  week: number;
  weekKey: string; // YYYY-MM-Wn
  service: "AM" | "PM";
  status: PeriodStatus; // Draft/Rejected editable; Submitted locks
  submittedAt: string | null;
  capturedByUserId: string;
  // R500 governance comments (Req 1.15), stored on submit.
  requestorComment: string | null;
  elderApprovalComment: string | null;
  // Bulk cash deposit slip (offline): one slip applied to all cash items on sync.
  depositBlob: Blob | null;
  depositFileName: string | null;
  depositDate: string | null;
  depositBankRef: string | null;
  localStatus: LocalSyncStatus;
  createdAt: string;
  updatedAt: string;
  syncAttempts: number;
  lastError: string | null;
}

// ─── Local line item (mirrors cashbook_line_item + offline proof) ────────────
export interface LocalLineItem {
  localId: string; // pk
  periodLocalId: string; // FK -> LocalPeriod.localId
  serverId: string | null; // cashbook_line_item.id once synced
  section: LineSection;
  is_officer: boolean;
  item_type: ItemType;
  payment_type: string | null;
  officer_id: string | null;
  amount: number;
  item_count: number | null;
  receipt_number: string | null; // Burial
  manual_reference: string | null; // Expense description
  transaction_date: string | null;
  proof_status: string | null; // "uploaded" once synced
  proof_reference: string | null; // EFT/DD bank ref
  // Offline proof: held locally as a Blob; uploaded to cashbook-proofs + a
  // cashbook_attachment row created at sync time.
  proofBlob: Blob | null;
  proofFileName: string | null;
  proofBankRef: string | null;
  proofDate: string | null;
  localStatus: LocalSyncStatus;
}

// ─── Sync bookkeeping ─────────────────────────────────────────────────────────
export interface SyncMeta {
  key: string; // pk, e.g. 'global'
  lastSyncAt: string | null;
  lastReferenceRefreshAt: string | null;
  schemaVersion: number;
}

// ─── Database ────────────────────────────────────────────────────────────────
export class OacCashbookLocalDB extends Dexie {
  credentials!: Table<CachedCredential, string>;
  congregations!: Table<CongregationLookup, string>;
  hierarchyLevels!: Table<HierarchyLookup, string>;
  officers!: Table<OfficerLookup, string>;
  congregationSettings!: Table<CongregationSettings, string>;
  periods!: Table<LocalPeriod, string>;
  lineItems!: Table<LocalLineItem, string>;
  syncMeta!: Table<SyncMeta, string>;

  constructor() {
    super("oac_cashbook_local");

    // v1 — legacy dev shape (cashbook_service), retained only for the upgrade path.
    this.version(1).stores({
      credentials: "userId",
      congregations: "id, district_id, overseership_id",
      hierarchyLevels: "id, parent_id, level_type",
      officers: "id, congregation_id",
      captureQueue: "localId, localStatus, congregationId, createdAt, serverId",
      lineItems: "localId, serviceLocalId",
      syncMeta: "key",
    });

    // v2 — realign to the real cashbook_period / cashbook_line_item model.
    this.version(2)
      .stores({
        captureQueue: null, // drop obsolete dev store
        congregationSettings: "congregation_id",
        officers: "id, congregation_id, rank",
        periods: "localId, &naturalKey, serverId, localStatus, congregationId, weekKey",
        lineItems: "localId, periodLocalId, section, serverId, localStatus",
      })
      .upgrade(async (tx) => {
        // No production offline data exists; clear obsolete v1 line items.
        await tx.table("lineItems").clear();
      });
  }
}

// Singleton Local_Store instance.
export const db = new OacCashbookLocalDB();
