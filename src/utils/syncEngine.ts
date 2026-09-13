// ─────────────────────────────────────────────────────────────────────────────
// SYNC_ENGINE — offline transaction queue reconciliation (Req 14, 10.5)
// Reads pending Local_Store records ordered by createdAt, validates status
// transitions against the Service_Status_Flow, detects conflicts when the server
// has advanced, uploads proof blobs, flushes override-audit records, and retries
// failures with exponential backoff. RLS enforces row scope on every write.
// ─────────────────────────────────────────────────────────────────────────────

import { createClient } from "@/lib/supabase/client";
import { db, type QueuedRecord, type QueuedLineItem } from "@/db/schema";
import { isValidTransition, isDownstreamOf } from "@/utils/statusFlow";
import type { ServiceStatus } from "@/lib/types";

const BASE_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 5 * 60_000;

export interface SyncReport {
  attempted: number;
  synced: number;
  conflicts: number;
  failed: number;
  skipped: number;
}

/** Exponential backoff for a given attempt count. */
export function backoffDelayMs(attempts: number): number {
  return Math.min(BASE_BACKOFF_MS * 2 ** attempts, MAX_BACKOFF_MS);
}

/** Whether a failed record is due for another attempt given its last update time. */
export function isDueForRetry(record: QueuedRecord, now: Date = new Date()): boolean {
  if (record.localStatus !== "failed") return true;
  const last = new Date(record.updatedAt).getTime();
  return now.getTime() - last >= backoffDelayMs(record.syncAttempts);
}

function isOnline(): boolean {
  return typeof navigator === "undefined" ? true : navigator.onLine;
}

/**
 * Reconcile all pending/failed records. Ordered by createdAt so captures apply in
 * the sequence they were made (Req 14.1).
 */
export async function syncPending(now: Date = new Date()): Promise<SyncReport> {
  const report: SyncReport = { attempted: 0, synced: 0, conflicts: 0, failed: 0, skipped: 0 };
  if (!isOnline()) return report;

  const supabase = createClient();

  const pending = (await db.captureQueue.toArray())
    .filter((r) => r.localStatus === "pending" || r.localStatus === "failed")
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));

  for (const record of pending) {
    // Respect exponential backoff for previously-failed records (Req 14.3).
    if (!isDueForRetry(record, now)) {
      report.skipped++;
      continue;
    }
    report.attempted++;
    await db.captureQueue.update(record.localId, { localStatus: "syncing" });

    try {
      if (record.entityType === "override_audit") {
        await flushOverrideAudit(supabase, record);
        await markSynced(record.localId);
        report.synced++;
        continue;
      }

      // cashbook_service reconciliation.
      const outcome = await reconcileService(supabase, record);
      if (outcome === "conflict") {
        await db.captureQueue.update(record.localId, { localStatus: "conflict" });
        report.conflicts++;
      } else if (outcome === "synced") {
        report.synced++;
      } else {
        await recordFailure(record, "Rejected transition");
        report.failed++;
      }
    } catch (err) {
      await recordFailure(record, err instanceof Error ? err.message : "Unknown error");
      report.failed++;
    }
  }

  await db.syncMeta.put({
    key: "global",
    lastSyncAt: now.toISOString(),
    lastReferenceRefreshAt: (await db.syncMeta.get("global"))?.lastReferenceRefreshAt ?? null,
    schemaVersion: 1,
  });
  return report;
}

type ReconcileOutcome = "synced" | "conflict" | "rejected";

async function reconcileService(
  supabase: ReturnType<typeof createClient>,
  record: QueuedRecord
): Promise<ReconcileOutcome> {
  // If already synced once, fetch server status to detect conflicts / illegal moves.
  let serverStatus: ServiceStatus | null = null;
  if (record.serverId) {
    const { data } = await supabase
      .from("cashbook_service")
      .select("status")
      .eq("id", record.serverId)
      .maybeSingle();
    serverStatus = (data?.status as ServiceStatus | undefined) ?? null;
  }

  // Conflict: server has advanced strictly beyond the locally captured status (Req 14.6).
  if (serverStatus && isDownstreamOf(serverStatus, record.serviceStatus)) {
    await persistConflictAudit(supabase, record, serverStatus);
    return "conflict";
  }

  // Enforce a valid transition (Req 14.4, 14.5, 14.7).
  if (!isValidTransition(serverStatus, record.serviceStatus, record.capturedRole)) {
    return "rejected";
  }

  // Upsert the service.
  const serviceRow = {
    ...record.payload,
    status: record.serviceStatus,
    ...(record.serverId ? { id: record.serverId } : {}),
  };
  const { data: upserted, error } = await supabase
    .from("cashbook_service")
    .upsert(serviceRow)
    .select("id")
    .single();
  if (error) throw new Error(error.message);

  const serverId = (upserted?.id as string) ?? record.serverId;

  // Sync child line items (upload proofs first).
  const items = await db.lineItems.where("serviceLocalId").equals(record.localId).toArray();
  for (const item of items) {
    await syncLineItem(supabase, serverId, item);
  }

  await markSynced(record.localId, serverId);
  return "synced";
}

async function syncLineItem(
  supabase: ReturnType<typeof createClient>,
  serviceServerId: string,
  item: QueuedLineItem
): Promise<void> {
  let proofUrl = item.proof_image_url;

  // Upload a locally-stored proof blob if present and not yet uploaded.
  if (item.proofBlob && !proofUrl) {
    const path = `proofs/${serviceServerId}/${item.localId}_${Date.now()}_${item.proofFileName ?? "proof"}`;
    const { error: upErr } = await supabase.storage.from("proof-images").upload(path, item.proofBlob);
    if (upErr) throw new Error(`Proof upload failed: ${upErr.message}`);
    proofUrl = supabase.storage.from("proof-images").getPublicUrl(path).data.publicUrl;
    await db.lineItems.update(item.localId, {
      proof_image_url: proofUrl,
      proof_status: "Uploaded",
      proofBlob: null,
    });
  }

  const { error } = await supabase.from("cashbook_line_item").upsert({
    service_id: serviceServerId,
    section: item.section,
    officer_id: item.officer_id,
    officer_code: item.officer_code,
    income_type: item.income_type,
    amount: item.amount,
    item_count: item.item_count,
    manual_reference: item.manual_reference,
    expense_date: item.expense_date,
    expense_description: item.expense_description,
    proof_status: item.proof_status,
    proof_image_url: proofUrl,
  });
  if (error) throw new Error(error.message);
}

async function flushOverrideAudit(
  supabase: ReturnType<typeof createClient>,
  record: QueuedRecord
): Promise<void> {
  const { error } = await supabase.from("audit_log").insert({
    user_id: record.capturedByUserId,
    action_type: "SELF_REVIEW_EXCEPTION",
    entity_type: (record.payload.entity_type as string) ?? "cashbook_service",
    entity_id: record.serverId ?? null,
    assumed_role: (record.payload.assumed_role as string) ?? null,
    comment: (record.payload.comment as string) ?? null,
    metadata: { flushed_at: new Date().toISOString(), offline_capture: true },
  });
  if (error) throw new Error(error.message);
}

async function persistConflictAudit(
  supabase: ReturnType<typeof createClient>,
  record: QueuedRecord,
  serverStatus: ServiceStatus
): Promise<void> {
  // Preserve an auditable record of the conflict; never overwrite server state (Req 14.6).
  await supabase.from("audit_log").insert({
    user_id: record.capturedByUserId,
    action_type: "CORRECTION",
    entity_type: "cashbook_service",
    entity_id: record.serverId,
    comment: `Sync conflict: local status ${record.serviceStatus} is stale; server at ${serverStatus}.`,
    metadata: { conflict: true, localId: record.localId, serverStatus },
  });
}

async function markSynced(localId: string, serverId?: string): Promise<void> {
  await db.captureQueue.update(localId, {
    localStatus: "synced",
    updatedAt: new Date().toISOString(),
    ...(serverId ? { serverId } : {}),
  });
}

async function recordFailure(record: QueuedRecord, message: string): Promise<void> {
  await db.captureQueue.update(record.localId, {
    localStatus: "failed",
    syncAttempts: record.syncAttempts + 1,
    lastError: message,
    updatedAt: new Date().toISOString(),
  });
}

/** Enqueue helper (mirrors design's Sync_Engine.enqueue). */
export async function enqueue(record: QueuedRecord): Promise<void> {
  await db.captureQueue.add(record);
}
