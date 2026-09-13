// ─────────────────────────────────────────────────────────────────────────────
// CAPTURE REPO — local-first data layer over the Dexie Local_Store.
// The offline Capture_App writes here with zero network latency; the Sync_Engine
// later reconciles to Supabase. All writes are local (Req 3.1–3.5).
// ─────────────────────────────────────────────────────────────────────────────

import { db, type QueuedRecord, type QueuedLineItem, type OfficerLookup } from "@/db/schema";
import type { Role, ServiceStatus, LineSection, IncomeType, ServiceType } from "@/lib/types";

function uuid(): string {
  return globalThis.crypto.randomUUID();
}

function now(): string {
  return new Date().toISOString();
}

// ─── Local service (a captureQueue row of entityType 'cashbook_service') ─────
export interface NewServiceInput {
  congregationId: string;
  capturedByUserId: string;
  capturedRole: Role;
  year: number;
  month: number;
  week: number;
  service_type: ServiceType;
  service_date: string;
}

export async function createLocalService(input: NewServiceInput): Promise<string> {
  const localId = uuid();
  const ts = now();
  const record: QueuedRecord = {
    localId,
    entityType: "cashbook_service",
    payload: {
      congregation_id: input.congregationId,
      year: input.year,
      month: input.month,
      week: input.week,
      service_type: input.service_type,
      service_date: input.service_date,
      captured_by: input.capturedByUserId,
    },
    congregationId: input.congregationId,
    capturedByUserId: input.capturedByUserId,
    capturedRole: input.capturedRole,
    localStatus: "pending",
    serviceStatus: "Draft",
    createdAt: ts,
    updatedAt: ts,
    syncAttempts: 0,
    lastError: null,
    serverId: null,
  };
  await db.captureQueue.add(record);
  return localId;
}

export async function getService(localId: string): Promise<QueuedRecord | undefined> {
  return db.captureQueue.get(localId);
}

export async function listServices(congregationId?: string): Promise<QueuedRecord[]> {
  const rows = congregationId
    ? await db.captureQueue.where("congregationId").equals(congregationId).toArray()
    : await db.captureQueue.toArray();
  return rows
    .filter((r) => r.entityType === "cashbook_service")
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

/** Advance a local service's domain status (validated by the Sync_Engine on sync). */
export async function setServiceStatus(localId: string, status: ServiceStatus): Promise<void> {
  await db.captureQueue.update(localId, { serviceStatus: status, updatedAt: now() });
}

// ─── Line items ──────────────────────────────────────────────────────────────
export async function addLineItem(
  serviceLocalId: string,
  section: LineSection
): Promise<string> {
  const localId = uuid();
  const item: QueuedLineItem = {
    localId,
    serviceLocalId,
    section,
    officer_id: null,
    officer_code: null,
    income_type: section === "Expenses" ? "Cash" : "EFT",
    amount: 0,
    item_count: null,
    manual_reference: null,
    expense_date: null,
    expense_description: null,
    proof_status: null,
    proofBlob: null,
    proofFileName: null,
    proof_image_url: null,
  };
  await db.lineItems.add(item);
  await touchService(serviceLocalId);
  return localId;
}

export async function updateLineItem(
  localId: string,
  changes: Partial<QueuedLineItem>
): Promise<void> {
  await db.lineItems.update(localId, changes);
  const item = await db.lineItems.get(localId);
  if (item) await touchService(item.serviceLocalId);
}

/** Set the income type, clearing count/proof when switched to Cash. */
export async function setIncomeType(localId: string, type: IncomeType): Promise<void> {
  const changes: Partial<QueuedLineItem> =
    type === "Cash"
      ? { income_type: type, item_count: null, proof_status: null, proofBlob: null, proofFileName: null, proof_image_url: null }
      : { income_type: type };
  await updateLineItem(localId, changes);
}

/** Attach a proof image locally (Blob). Uploaded to Storage by the Sync_Engine. */
export async function setLocalProof(localId: string, file: Blob, fileName: string): Promise<void> {
  await updateLineItem(localId, {
    proofBlob: file,
    proofFileName: fileName,
    proof_status: "Pending",
    proof_image_url: null,
  });
}

export async function deleteLineItem(localId: string): Promise<void> {
  const item = await db.lineItems.get(localId);
  await db.lineItems.delete(localId);
  if (item) await touchService(item.serviceLocalId);
}

export async function getLineItems(serviceLocalId: string): Promise<QueuedLineItem[]> {
  return db.lineItems.where("serviceLocalId").equals(serviceLocalId).toArray();
}

async function touchService(serviceLocalId: string): Promise<void> {
  await db.captureQueue.update(serviceLocalId, { updatedAt: now() });
}

// ─── Officers (offline picker) ─────────────────────────────────────────────
export async function listOfficers(congregationId: string): Promise<OfficerLookup[]> {
  return db.officers
    .where("congregation_id")
    .equals(congregationId)
    .and((o) => o.is_active)
    .toArray();
}

// ─── Override audit (Elder/Chairperson 'O' action offline) ───────────────────
// Queued as an auditable record and flushed to audit_log by the Sync_Engine (Req 10.5).
export async function queueOverrideAudit(params: {
  serviceLocalId: string;
  congregationId: string;
  userId: string;
  role: Role;
  assumedRole: Role;
  comment: string;
}): Promise<void> {
  const ts = now();
  await db.captureQueue.add({
    localId: uuid(),
    entityType: "override_audit",
    payload: {
      action_type: "SELF_REVIEW_EXCEPTION",
      entity_type: "cashbook_service",
      entity_local_id: params.serviceLocalId,
      assumed_role: params.assumedRole,
      comment: params.comment,
    },
    congregationId: params.congregationId,
    capturedByUserId: params.userId,
    capturedRole: params.role,
    localStatus: "pending",
    serviceStatus: "Draft",
    createdAt: ts,
    updatedAt: ts,
    syncAttempts: 0,
    lastError: null,
    serverId: null,
  });
}
