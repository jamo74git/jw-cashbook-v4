// ─────────────────────────────────────────────────────────────────────────────
// SYNC_ENGINE (v2) — offline → online reconciliation for the cashbook_period model.
// For each pending local period: resolve the server period via get_or_create_period,
// detect downstream conflicts, upsert line items to cashbook_line_item, upload proof
// Blobs to cashbook-proofs and create cashbook_attachment rows (incl. the bulk cash
// deposit slip), and apply the submit transition. Retries failures with backoff.
// ─────────────────────────────────────────────────────────────────────────────

import { createClient } from "@/lib/supabase/client";
import { db, type LocalPeriod, type LocalLineItem, type PeriodStatus } from "@/db/schema";

const BASE_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 5 * 60_000;
const PROOF_BUCKET = "cashbook-proofs";

export interface SyncReport {
  attempted: number;
  synced: number;
  conflicts: number;
  failed: number;
  skipped: number;
}

export function backoffDelayMs(attempts: number): number {
  return Math.min(BASE_BACKOFF_MS * 2 ** attempts, MAX_BACKOFF_MS);
}

export function isDueForRetry(period: LocalPeriod, now: Date = new Date()): boolean {
  if (period.localStatus !== "failed") return true;
  return now.getTime() - new Date(period.updatedAt).getTime() >= backoffDelayMs(period.syncAttempts);
}

function isOnline(): boolean {
  return typeof navigator === "undefined" ? true : navigator.onLine;
}

// Conflict rank over the real cashbook_period vocabulary.
const STATUS_RANK: Record<PeriodStatus, number> = {
  Draft: 0,
  Rejected: 0,
  Submitted: 1,
  AuditApproved: 2,
};
function isServerDownstream(server: PeriodStatus, local: PeriodStatus): boolean {
  return (STATUS_RANK[server] ?? 0) > (STATUS_RANK[local] ?? 0);
}

type SB = ReturnType<typeof createClient>;

export async function syncPending(now: Date = new Date()): Promise<SyncReport> {
  const report: SyncReport = { attempted: 0, synced: 0, conflicts: 0, failed: 0, skipped: 0 };
  if (!isOnline()) return report;

  const supabase = createClient();
  const pending = (await db.periods.toArray())
    .filter((p) => p.localStatus === "pending" || p.localStatus === "failed")
    .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));

  for (const period of pending) {
    if (!isDueForRetry(period, now)) {
      report.skipped++;
      continue;
    }
    report.attempted++;
    await db.periods.update(period.localId, { localStatus: "syncing" });
    try {
      const outcome = await reconcilePeriod(supabase, period);
      if (outcome === "conflict") report.conflicts++;
      else report.synced++;
    } catch (err) {
      await recordFailure(period, err instanceof Error ? err.message : "Unknown error");
      report.failed++;
    }
  }

  const meta = await db.syncMeta.get("global");
  await db.syncMeta.put({
    key: "global",
    lastSyncAt: now.toISOString(),
    lastReferenceRefreshAt: meta?.lastReferenceRefreshAt ?? null,
    schemaVersion: 2,
  });
  return report;
}

type Outcome = "synced" | "conflict";

async function reconcilePeriod(supabase: SB, period: LocalPeriod): Promise<Outcome> {
  // 1) Resolve the server period (cannot run offline; this is the sync path).
  const { data: serverPeriod, error: rpcErr } = await supabase.rpc("get_or_create_period", {
    p_congregation_id: period.congregationId,
    p_week_key: period.weekKey,
    p_service: period.service,
    p_user_id: period.capturedByUserId,
  });
  if (rpcErr || !serverPeriod) throw new Error(rpcErr?.message ?? "get_or_create_period failed");

  const serverId = (serverPeriod as { id: string }).id;
  const serverStatus = (serverPeriod as { status?: PeriodStatus }).status ?? "Draft";
  await db.periods.update(period.localId, { serverId });

  // 2) Conflict: server has advanced beyond the local capture — do not overwrite.
  if (isServerDownstream(serverStatus, period.status)) {
    await persistConflictAudit(supabase, period, serverId, serverStatus);
    await db.periods.update(period.localId, { localStatus: "conflict" });
    return "conflict";
  }

  // 3) Upsert line items + their proofs.
  const items = await db.lineItems.where("periodLocalId").equals(period.localId).toArray();
  for (const item of items) {
    await syncLineItem(supabase, serverId, period, item);
  }

  // 4) Bulk cash deposit slip: one upload, an attachment per banked item.
  if (period.depositBlob) {
    await syncDepositSlip(supabase, serverId, period, items);
  }

  // 5) Apply the submit transition (Draft/Rejected -> Submitted) to cashbook_period.
  if (period.status === "Submitted") {
    const { error } = await supabase
      .from("cashbook_period")
      .update({
        status: "Submitted",
        submitted_at: period.submittedAt ?? new Date().toISOString(),
        requestor_comment: period.requestorComment,
        elder_approval_comment: period.elderApprovalComment,
      })
      .eq("id", serverId);
    if (error) throw new Error(error.message);
  }

  await db.periods.update(period.localId, {
    localStatus: "synced",
    updatedAt: new Date().toISOString(),
  });
  return "synced";
}

async function syncLineItem(
  supabase: SB,
  periodServerId: string,
  period: LocalPeriod,
  item: LocalLineItem
): Promise<void> {
  // Upsert the line item (obtain its server id for attachments).
  const row = {
    ...(item.serverId ? { id: item.serverId } : {}),
    period_id: periodServerId,
    section: item.section,
    is_officer: item.is_officer,
    item_type: item.item_type,
    payment_type: item.payment_type,
    officer_id: item.officer_id,
    amount: item.amount,
    item_count: item.item_count,
    receipt_number: item.receipt_number,
    manual_reference: item.manual_reference,
    transaction_date: item.transaction_date,
    proof_status: item.proof_status,
    proof_reference: item.proof_reference,
  };
  const { data: saved, error } = await supabase
    .from("cashbook_line_item")
    .upsert(row)
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  const lineServerId = (saved?.id as string) ?? item.serverId ?? "";
  await db.lineItems.update(item.localId, { serverId: lineServerId });

  // Upload an individual proof Blob (EFT/DD/Burial/Expense) if present.
  if (item.proofBlob && lineServerId) {
    const url = await uploadProof(supabase, period, item.proofBlob, item.proofFileName ?? "proof.jpg");
    await supabase.from("cashbook_attachment").insert({
      line_item_id: lineServerId,
      file_url: url,
      transaction_date: item.proofDate ?? item.transaction_date,
      bank_reference: item.proofBankRef,
      congregation_id: period.congregationId,
      uploaded_by: period.capturedByUserId,
    });
    await supabase.from("cashbook_line_item").update({ proof_status: "Deposited" }).eq("id", lineServerId);
    await db.lineItems.update(item.localId, { proof_status: "Deposited", proofBlob: null });
  }
}

async function syncDepositSlip(
  supabase: SB,
  periodServerId: string,
  period: LocalPeriod,
  items: LocalLineItem[]
): Promise<void> {
  if (!period.depositBlob) return;
  const url = await uploadProof(
    supabase,
    period,
    period.depositBlob,
    period.depositFileName ?? "deposit-slip.jpg",
    "deposit-slip"
  );
  const banked = items.filter((i) => i.item_type === "CashBanked");
  for (const bi of banked) {
    // Ensure the item exists server-side (it was upserted above -> has serverId).
    const current = await db.lineItems.get(bi.localId);
    const lineServerId = current?.serverId;
    if (!lineServerId) continue;
    await supabase.from("cashbook_attachment").insert({
      line_item_id: lineServerId,
      file_url: url,
      transaction_date: period.depositDate,
      bank_reference: period.depositBankRef,
      congregation_id: period.congregationId,
      uploaded_by: period.capturedByUserId,
    });
    await supabase.from("cashbook_line_item").update({ proof_status: "Deposited" }).eq("id", lineServerId);
    await db.lineItems.update(bi.localId, { proof_status: "Deposited" });
  }
  await db.periods.update(period.localId, { depositBlob: null });
  void periodServerId;
}

async function uploadProof(
  supabase: SB,
  period: LocalPeriod,
  blob: Blob,
  fileName: string,
  suffix = "proof"
): Promise<string> {
  const ts = new Date().toISOString().replace(/[:T-]/g, "").slice(0, 14);
  const ext = fileName.split(".").pop() ?? "jpg";
  const path = `${period.congregationId}/${period.year}/${String(period.month).padStart(2, "0")}/${period.service}_${period.weekKey}/${period.capturedByUserId}/${ts}-${suffix}.${ext}`;
  const { error } = await supabase.storage.from(PROOF_BUCKET).upload(path, blob);
  if (error) throw new Error(`Proof upload failed: ${error.message}`);
  return supabase.storage.from(PROOF_BUCKET).getPublicUrl(path).data.publicUrl;
}

async function persistConflictAudit(
  supabase: SB,
  period: LocalPeriod,
  serverId: string,
  serverStatus: PeriodStatus
): Promise<void> {
  await supabase.from("audit_log").insert({
    user_id: period.capturedByUserId,
    action_type: "CORRECTION",
    entity_type: "cashbook_period",
    entity_id: serverId,
    comment: `Sync conflict: local status ${period.status} is stale; server at ${serverStatus}.`,
    metadata: { conflict: true, localId: period.localId, serverStatus },
  });
}

async function recordFailure(period: LocalPeriod, message: string): Promise<void> {
  await db.periods.update(period.localId, {
    localStatus: "failed",
    syncAttempts: period.syncAttempts + 1,
    lastError: message,
    updatedAt: new Date().toISOString(),
  });
}
