// ─────────────────────────────────────────────────────────────────────────────
// LOCAL_STORE — Dexie.js (IndexedDB) schema for the offline-first Capture_App.
// Database: oac_cashbook_local, version 1.
// Record types reuse the canonical enums from @/lib/types (Role, ServiceStatus,
// HierarchyLevel, LineSection, IncomeType) rather than redefining string literals.
// Stores/indexes match design.md "Dexie Schema Declaration".
// ─────────────────────────────────────────────────────────────────────────────

import Dexie, { type Table } from "dexie";
import type {
  Role,
  ServiceStatus,
  HierarchyLevel,
  LineSection,
  IncomeType,
  ProofStatus,
} from "@/lib/types";

// ─── Cached_Credential (Req 4, 5, 15) ───────────────────────────────────────
// Offline PIN authentication material. The raw PIN is NEVER stored; only the
// PBKDF2-derived hash, its salt/iterations, and a PIN-keyed HMAC integrity tag.
export interface CachedCredential {
  userId: string; // primary key
  pinHash: string; // base64 PBKDF2-derived bits (SHA-256)
  salt: string; // base64, per-user (crypto.getRandomValues)
  kdfIterations: number; // work factor, recorded for forward compatibility
  hmac: string; // base64 HMAC over integrity-protected fields
  role: Role; // cached role metadata
  accessStartDate: string; // Access_Window start (ISO)
  accessEndDate: string | null; // Access_Window end (ISO)
  activatedAt: string; // ISO timestamp of activation
  failedAttempts: number; // consecutive offline unlock failures
  lockedUntil: string | null; // set when lockout triggers (ISO)
}

// ─── Reference lookup caches (offline capture pickers, Req 11) ───────────────
// Read-only mirrors of Supabase tables, populated online and read offline.
export interface CongregationLookup {
  id: string; // primary key
  name: string;
  code: string;
  overseership_id: string | null;
  eldership_id: string | null;
  apostleship_id: string | null;
  district_id: string | null;
}

export interface HierarchyLookup {
  id: string; // primary key
  name: string;
  code: string;
  level_type: HierarchyLevel;
  parent_id: string | null;
}

// Officer lookup — offline picker for Members/Officers tithing capture. Mirrored from
// the Supabase `officers` table (design's Dexie schema omitted this; required for
// offline capture of officer/member tithing).
export interface OfficerLookup {
  id: string; // primary key
  congregation_id: string; // indexed
  officer_code: string;
  first_name: string;
  last_name: string;
  rank: string;
  is_active: boolean;
}

// ─── Offline transaction queue (Req 3, 14) ───────────────────────────────────
export type LocalSyncStatus = "pending" | "syncing" | "synced" | "conflict" | "failed";

export interface QueuedRecord {
  localId: string; // primary key (client-generated UUID)
  entityType: string; // 'cashbook_service' | 'banking' | 'census' | 'override_audit' ...
  payload: Record<string, unknown>; // the record body to persist
  congregationId: string; // scoping (indexed)
  capturedByUserId: string; // identity at capture time (Req 3.5)
  capturedRole: Role; // role at capture time (Req 3.5)
  localStatus: LocalSyncStatus; // indexed
  serviceStatus: ServiceStatus; // domain status for status-flow validation
  createdAt: string; // ordering key (indexed)
  updatedAt: string;
  syncAttempts: number; // retry/backoff bookkeeping
  lastError: string | null;
  serverId: string | null; // set after successful sync (indexed)
}

// Child line items keyed to a queued service via serviceLocalId.
export interface QueuedLineItem {
  localId: string; // primary key (client UUID)
  serviceLocalId: string; // FK -> QueuedRecord.localId (indexed)
  section: LineSection;
  officer_id: string | null;
  officer_code: string | null;
  income_type: IncomeType | null;
  amount: number;
  item_count: number | null;
  manual_reference: string | null;
  expense_date: string | null;
  expense_description: string | null;
  // Offline proof handling: the image is stored locally as a Blob and uploaded to
  // Supabase Storage by the Sync_Engine on reconnect. proof_image_url is set only
  // once the server upload succeeds.
  proof_status: ProofStatus | null;
  proofBlob: Blob | null;
  proofFileName: string | null;
  proof_image_url: string | null;
}

// ─── Sync bookkeeping ─────────────────────────────────────────────────────────
export interface SyncMeta {
  key: string; // primary key, e.g. 'global'
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
  captureQueue!: Table<QueuedRecord, string>;
  lineItems!: Table<QueuedLineItem, string>;
  syncMeta!: Table<SyncMeta, string>;

  constructor() {
    super("oac_cashbook_local");
    this.version(1).stores({
      credentials: "userId",
      congregations: "id, district_id, overseership_id",
      hierarchyLevels: "id, parent_id, level_type",
      officers: "id, congregation_id",
      captureQueue: "localId, localStatus, congregationId, createdAt, serverId",
      lineItems: "localId, serviceLocalId",
      syncMeta: "key",
    });
  }
}

// Singleton Local_Store instance.
export const db = new OacCashbookLocalDB();
