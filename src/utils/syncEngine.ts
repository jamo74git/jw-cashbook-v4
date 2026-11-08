// SYNC_ENGINE (v2) - offline -> online reconciliation. Tranche 4 round-2 corrections:
//  R01/Area1 version binding: key + bytes + hash + size are read together from the CURRENT
//      row before upload (bindLineItemProof/bindDepositProof); a fresh key is never paired
//      with stale bytes, and the compare-and-clear only clears the exact delivered version.
//  R02/Area2 truthful sync: missing server IDs throw; a locked period with unacknowledged
//      capture (pending proof OR un-pushed line items) is NOT marked synced.
//  R03/Area3 affected-row acks: period submission, attachment insert, status update and the
//      acting-as audit insert each require the expected returned row before release.
//  R06 duplicate integrity: on "already exists" the existing object is downloaded + hashed
//      against the per-version expectation; mismatch/unverifiable retains bytes.
//  R09 blocked side effects: a locked parent with the Submitted-proof path disabled writes
//      NO server metadata; STATUS_RANK fails closed for later/unknown statuses.
import { createClient } from "@/lib/supabase/client";
import { db, type LocalPeriod, type LocalLineItem } from "@/db/schema";
import { isFutureOacService } from "@/lib/oacWeeks";
import { filterQueueForActor } from "@/utils/syncActor";
import { operationDedupeKey } from "@/lib/opLedger";

const BASE_BACKOFF_MS = 2_000;
const MAX_BACKOFF_MS = 5 * 60_000;
const PROOF_BUCKET = "cashbook-proofs";

// R09/item 5: post-submission proof finalisation stays OFF (no immutable submission
// protocol). Do not flip without an enforceable server protocol.
export const SUBMITTED_PROOF_FINALISATION_ENABLED = false;
export const BLOCKED_SUBMITTED_PROOF_MSG =
  "Proof held: the parent period is already submitted and post-submission proof finalisation is disabled pending the submission-snapshot protocol. Your local proof is retained and will be delivered once that integration is enabled.";
export const UNACKED_LOCKED_CAPTURE_MSG =
  "Local capture changes are unacknowledged on an already-submitted period; manual correction is required before sync.";

export interface SyncReport {
  attempted: number;
  synced: number;
  conflicts: number;
  failed: number;
  skipped: number;
  blocked: number;
  pending: number; // R02: current version still awaiting a confirmed ack (retryable)
}

async function sha256Hex(blob: Blob): Promise<string> {
  const buf = await blob.arrayBuffer();
  const digest = await globalThis.crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
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

// R09: full deployed vocabulary + fail-closed default for unknown/later statuses.
const STATUS_RANK: Record<string, number> = {
  Draft: 0, Rejected: 0, Submitted: 1, AuditApproved: 2,
  SubmittedToOverseer: 3, SubmittedToHO: 4, HOReviewed: 5,
};
function rankOf(status: string): number {
  return STATUS_RANK[status] ?? 99; // unknown -> locked/advanced (fail closed)
}
export function isServerDownstream(server: string, local: string): boolean {
  return rankOf(server) > rankOf(local);
}
function isEditableServerStatus(status: string): boolean {
  return status === "Draft" || status === "Rejected";
}

export const AUDIT_BLOCK_NOT_SYNCED =
  "Record not yet synced - connect or use same device as Treasurer capture.";

export function isAuditApprovable(
  period: Pick<LocalPeriod, "localStatus" | "captureDeviceId">,
  currentDeviceId: string
): boolean {
  return period.localStatus === "synced" || period.captureDeviceId === currentDeviceId;
}

type SB = ReturnType<typeof createClient>;

interface StorageErrorLike {
  message?: string;
  status?: number;
  statusCode?: string | number;
}

interface ReconcileCtx {
  blocked: boolean;
  pendingRemains: boolean; // R02: a current version is still unacked (retryable)
}

interface BoundProof {
  key: string;
  blob: Blob;
  hash: string | null;
  size: number | null;
  // Task 3: proof metadata bound to the SAME version as the bytes/key (read in the same
  // fresh transaction) so an attachment row can never mix a new object with a stale
  // transaction date / bank reference.
  date: string | null;
  bankRef: string | null;
}

export function buildProofPath(
  period: Pick<LocalPeriod, "congregationId" | "year" | "month" | "service" | "weekKey" | "capturedByUserId">,
  fileName: string
): string {
  const mm = String(period.month).padStart(2, "0");
  return `${period.congregationId}/${period.year}/${mm}/${period.service}_${period.weekKey}/${period.capturedByUserId}/${fileName}`;
}

// Area 1: bind key + bytes + hash + size to the SAME proof version by reading the CURRENT
// row once in a transaction (allocating a stable key if missing - safe for legacy rows).
// The returned snapshot is exactly what gets uploaded, so a fresh key is never combined
// with stale bytes. Returns null when no proof is present (removed meanwhile).
async function bindLineItemProof(localId: string): Promise<BoundProof | null> {
  return db.transaction("rw", db.lineItems, async () => {
    const fresh = await db.lineItems.get(localId);
    if (!fresh) throw new Error(`line item ${localId} missing during proof bind`);
    if (!fresh.proofBlob) return null;
    let key = fresh.proofObjectKey ?? null;
    if (!key) {
      const ext = (fresh.proofFileName?.split(".").pop() ?? "jpg").toLowerCase();
      key = `${localId}-${globalThis.crypto.randomUUID()}-proof.${ext}`;
      await db.lineItems.update(localId, { proofObjectKey: key });
    }
    return {
      key,
      blob: fresh.proofBlob,
      hash: fresh.proofHash ?? null,
      size: fresh.proofSize ?? null,
      date: fresh.proofDate ?? fresh.transaction_date ?? null,
      bankRef: fresh.proofBankRef ?? null,
    };
  });
}

async function bindDepositProof(periodLocalId: string): Promise<BoundProof | null> {
  return db.transaction("rw", db.periods, async () => {
    const fresh = await db.periods.get(periodLocalId);
    if (!fresh) throw new Error(`period ${periodLocalId} missing during deposit bind`);
    if (!fresh.depositBlob) return null;
    let key = fresh.depositObjectKey ?? null;
    if (!key) {
      const ext = (fresh.depositFileName?.split(".").pop() ?? "jpg").toLowerCase();
      key = `${periodLocalId}-${globalThis.crypto.randomUUID()}-deposit-slip.${ext}`;
      await db.periods.update(periodLocalId, { depositObjectKey: key });
    }
    return {
      key,
      blob: fresh.depositBlob,
      hash: fresh.depositHash ?? null,
      size: fresh.depositSize ?? null,
      date: fresh.depositDate ?? null,
      bankRef: fresh.depositBankRef ?? null,
    };
  });
}

// R06: idempotent upload with CONTENT verification. On "already exists" download the
// existing bytes and compare hash + size to the per-version expectation; any mismatch or
// unverifiable outcome throws so local bytes are retained.
async function uploadProofStable(
  supabase: SB,
  path: string,
  bound: BoundProof
): Promise<void> {
  const { error } = await supabase.storage.from(PROOF_BUCKET).upload(path, bound.blob);
  if (!error) return;
  const e = error as StorageErrorLike;
  const msg = (e.message ?? "").toLowerCase();
  const duplicate =
    msg.includes("already exists") || msg.includes("duplicate") || String(e.statusCode) === "409";
  if (!duplicate) throw new Error(`Proof upload failed: ${e.message}`);

  const { data: existing, error: dlErr } = await supabase.storage.from(PROOF_BUCKET).download(path);
  if (dlErr || !existing) {
    throw new Error("Proof reported as existing but could not be downloaded for verification");
  }
  if (bound.size != null && existing.size !== bound.size) {
    throw new Error("Existing proof object size differs from the expected version - retaining bytes");
  }
  if (bound.hash) {
    const existingHash = await sha256Hex(existing);
    if (existingHash !== bound.hash) {
      throw new Error("Existing proof object content differs from the expected version - retaining bytes");
    }
  } else {
    throw new Error("No integrity expectation available to verify an existing proof object - retaining bytes");
  }
  // Verified byte-identical: reconcile as already-uploaded; never overwrite.
}

// R03: an insert/update must return the EXPECTED single row before it is treated as acked.
function requireOneRow(data: { id?: string }[] | null, label: string): void {
  if (!data || data.length !== 1) throw new Error(`${label}: expected exactly one affected row`);
}

// Task 2: flush the mandatory ACTING_AS_TREASURER audit. Requires the inserted row before it
// is marked flushed; throws on any error/zero-row so the period stays retryable and is never
// falsely reported synced. DEPENDENCY (NOT idempotent): audit_log has no idempotency/dedupe
// key, so if an insert COMMITS server-side but its response is lost, a later retry inserts a
// DUPLICATE event. We do NOT claim idempotent retry; the durable fix is a unique key on
// (entity_id, action_type, user_id) for this event.
async function flushActingAsAudit(supabase: SB, period: LocalPeriod, serverId: string): Promise<void> {
  if (!period.actingAsRole || period.actingAsAuditedAt) return;
  const dedupeKey = operationDedupeKey("ACTING_AS_TREASURER", serverId, period.capturedByUserId);

  // Idempotent replay (lost-ack safety): a prior attempt may have COMMITTED this event
  // server-side before its acknowledgement was lost. A pre-insert lookup on the natural
  // key (entity + action + user) finds that committed row and we mark it flushed WITHOUT
  // re-inserting, so a retry can never create a duplicate ACTING_AS_TREASURER event.
  // The DURABLE guarantee is the authored server-side unique key on
  // (entity_id, action_type, user_id) — NOT YET APPLIED; verify with hosted testing.
  const { data: existing, error: selErr } = await supabase
    .from("audit_log")
    .select("id")
    .eq("entity_id", serverId)
    .eq("action_type", "ACTING_AS_TREASURER")
    .eq("user_id", period.capturedByUserId)
    .limit(1);
  if (selErr) throw new Error(`acting-as audit lookup failed: ${selErr.message}`);
  if (existing && (existing as { id?: string }[]).length > 0) {
    await db.periods.update(period.localId, { actingAsAuditedAt: new Date().toISOString() });
    return;
  }

  const auditedAt = new Date().toISOString();
  const { data: auditRows, error: auditErr } = await supabase.from("audit_log").insert({
    user_id: period.capturedByUserId,
    action_type: "ACTING_AS_TREASURER",
    entity_type: "cashbook_period",
    entity_id: serverId,
    assumed_role: period.actingAsRole,
    comment: "Chairperson acting as Treasurer (offline capture)",
    metadata: {
      acting_as_role: period.actingAsRole,
      actual_user_id: period.capturedByUserId,
      timestamp: auditedAt,
      // Stable dedupe key so the authored server unique index collapses replays.
      dedupe_key: dedupeKey,
    },
  }).select("id");
  if (auditErr) throw new Error(`acting-as audit insert failed: ${auditErr.message}`);
  requireOneRow(auditRows as { id?: string }[] | null, "acting-as audit");
  await db.periods.update(period.localId, { actingAsAuditedAt: auditedAt });
}

// Task 1: the fields a line-item upsert pushes to the server. Before marking a row "synced"
// we confirm the CURRENT local version still matches what we pushed; a concurrent edit leaves
// it pending so the parent period is never falsely reported synced.
const MUTABLE_LINE_FIELDS: (keyof LocalLineItem)[] = [
  "section", "is_officer", "item_type", "payment_type", "officer_id", "amount",
  "item_count", "receipt_number", "manual_reference", "transaction_date", "proof_reference",
];
function lineRowUnchanged(a: LocalLineItem, b: LocalLineItem): boolean {
  return MUTABLE_LINE_FIELDS.every((k) => a[k] === b[k]);
}
async function finalizeLineItem(snapshot: LocalLineItem, ctx: ReconcileCtx): Promise<void> {
  await db.transaction("rw", db.lineItems, async () => {
    const cur = await db.lineItems.get(snapshot.localId);
    if (!cur) return;
    const rowUnchanged = lineRowUnchanged(cur, snapshot);
    const proofSettled = !cur.proofBlob;
    if (rowUnchanged && proofSettled) {
      await db.lineItems.update(snapshot.localId, { localStatus: "synced" });
    } else {
      ctx.pendingRemains = true; // a newer local version awaits its own acknowledgement
    }
  });
}

export async function syncPending(
  now: Date = new Date(),
  congregationId?: string,
  opts?: {
    // Actor isolation (PRIORITY 1 gate): when provided, ONLY the periods captured by
    // this authenticated actor are dispatched. Required before AUTOMATIC/progressive
    // dispatch is enabled so a shared device never sends a second user's queued work
    // under the wrong JWT. When omitted, behaviour is unchanged (manual, congregation-scoped).
    actorUserId?: string;
  }
): Promise<SyncReport> {
  const report: SyncReport = {
    attempted: 0, synced: 0, conflicts: 0, failed: 0, skipped: 0, blocked: 0, pending: 0,
  };
  if (!isOnline()) return report;

  const supabase = createClient();
  const queued = (await db.periods.toArray()).filter(
    (p) => p.localStatus === "pending" || p.localStatus === "failed"
  );
  const pending = filterQueueForActor(queued, {
    congregationId,
    ...(opts && "actorUserId" in opts ? { actorUserId: opts.actorUserId } : {}),
  }).sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));

  for (const period of pending) {
    // Task 2: never auto-submit a future-dated service to the server (preserves existing future
    // test periods; new future periods are blocked at capture). Left pending/local, counted skipped.
    if (isFutureOacService(period.year, period.month, period.week, now)) {
      report.skipped++;
      continue;
    }
    if (!isDueForRetry(period, now)) {
      report.skipped++;
      continue;
    }
    report.attempted++;
    await db.periods.update(period.localId, { localStatus: "syncing" });
    try {
      const outcome = await reconcilePeriod(supabase, period);
      if (outcome === "conflict") report.conflicts++;
      else if (outcome === "blocked") report.blocked++;
      else if (outcome === "pending") report.pending++;
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

type Outcome = "synced" | "conflict" | "blocked" | "pending";

async function reconcilePeriod(supabase: SB, period: LocalPeriod): Promise<Outcome> {
  const { data: serverPeriod, error: rpcErr } = await supabase.rpc("get_or_create_period", {
    p_congregation_id: period.congregationId,
    p_week_key: period.weekKey,
    p_service: period.service,
    p_user_id: period.capturedByUserId,
  });
  if (rpcErr || !serverPeriod) throw new Error(rpcErr?.message ?? "get_or_create_period failed");

  const serverId = (serverPeriod as { id: string }).id;
  const serverStatus = (serverPeriod as { status?: string }).status ?? "Draft";
  await db.periods.update(period.localId, { serverId });

  // Conflict: server advanced beyond local (fail-closed for later/unknown statuses).
  if (isServerDownstream(serverStatus, period.status)) {
    await persistConflictAudit(supabase, period, serverId, serverStatus);
    await db.periods.update(period.localId, { localStatus: "conflict" });
    return "conflict";
  }

  const items = await db.lineItems.where("periodLocalId").equals(period.localId).toArray();
  const hasPendingProof = items.some((i) => !!i.proofBlob) || !!period.depositBlob;
  // Area 2 + Task 1: a serverId proves a row was pushed AT SOME POINT - it does NOT prove the
  // CURRENT local version was acknowledged. captureRepo.updateLineItem flips an edited row back
  // to localStatus "pending", so unacknowledged work = any item without a serverId OR any item
  // not in the "synced" state.
  const hasUnackedCapture = items.some((i) => !i.serverId || i.localStatus !== "synced");
  const locked = !isEditableServerStatus(serverStatus);

  // R09/Area2: a locked parent with the Submitted-proof path disabled must NOT write any
  // period/line metadata or rewrite locked capture. Equal status does not prove equal data, so
  // we only claim "synced" when there is genuinely nothing unacknowledged locally.
  if (locked && !SUBMITTED_PROOF_FINALISATION_ENABLED) {
    if (hasPendingProof) {
      await db.periods.update(period.localId, {
        localStatus: "failed", lastError: BLOCKED_SUBMITTED_PROOF_MSG, updatedAt: new Date().toISOString(),
      });
      return "blocked";
    }
    if (hasUnackedCapture) {
      await db.periods.update(period.localId, {
        localStatus: "conflict", lastError: UNACKED_LOCKED_CAPTURE_MSG, updatedAt: new Date().toISOString(),
      });
      return "conflict";
    }
    // Task 2: the acting-as audit is an INDEPENDENT, mandatory governance record (not period or
    // line metadata). If still unacknowledged we must not claim "synced" - flush it even though
    // the parent is locked. It throws on failure/zero-row, so the period stays retryable and is
    // never falsely synced. NOT idempotent - see the dependency note on flushActingAsAudit.
    await flushActingAsAudit(supabase, period, serverId);
    await db.periods.update(period.localId, { localStatus: "synced", updatedAt: new Date().toISOString() });
    return "synced";
  }

  const ctx: ReconcileCtx = { blocked: false, pendingRemains: false };
  for (const item of items) {
    await syncLineItem(supabase, serverId, serverStatus, period, item, ctx);
  }
  if (period.depositBlob) {
    await syncDepositSlip(supabase, serverId, serverStatus, period, items, ctx);
  }

  if (period.status === "Submitted") {
    // Area 3: require the expected period row before treating submission as acknowledged.
    const { data: perRows, error } = await supabase
      .from("cashbook_period")
      .update({
        status: "Submitted",
        submitted_at: period.submittedAt ?? new Date().toISOString(),
        requestor_comment: period.requestorComment,
        elder_approval_comment: period.elderApprovalComment,
      })
      .eq("id", serverId)
      .select("id");
    if (error) throw new Error(error.message);
    requireOneRow(perRows as { id?: string }[] | null, "period submission");

    // Area 3: the acting-as audit insert must be acknowledged by its returned row before
    // we mark it flushed. NOTE (reported dependency): if the insert commits server-side but
    // the response is lost before actingAsAuditedAt is set, a retry would insert a DUPLICATE
    // event - the current audit_log schema has no idempotency key to prevent that. We do NOT
    // claim idempotent retry here; the smallest fix is a unique/dedupe key on this event.
    await flushActingAsAudit(supabase, period, serverId);
  }

  if (ctx.blocked) {
    await db.periods.update(period.localId, {
      localStatus: "failed", lastError: BLOCKED_SUBMITTED_PROOF_MSG, updatedAt: new Date().toISOString(),
    });
    return "blocked";
  }

  // R02: final completion re-checks current required work inside a transaction.
  const remaining = await db.transaction("rw", db.periods, db.lineItems, async () => {
    const fresh = await db.lineItems.where("periodLocalId").equals(period.localId).toArray();
    const stillPending = fresh.some((i) => !!i.proofBlob);
    const p = await db.periods.get(period.localId);
    const depositPending = !!p?.depositBlob;
    if (stillPending || depositPending || ctx.pendingRemains) {
      await db.periods.update(period.localId, {
        localStatus: "pending",
        lastError: "A newer proof version is awaiting a confirmed acknowledgement.",
        updatedAt: new Date().toISOString(),
      });
      return true;
    }
    await db.periods.update(period.localId, { localStatus: "synced", updatedAt: new Date().toISOString() });
    return false;
  });
  return remaining ? "pending" : "synced";
}

async function syncLineItem(
  supabase: SB,
  periodServerId: string,
  serverStatus: string,
  period: LocalPeriod,
  item: LocalLineItem,
  ctx: ReconcileCtx
): Promise<void> {
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
    .from("cashbook_line_item").upsert(row).select("id").single();
  if (error) throw new Error(error.message);
  const lineServerId = (saved?.id as string) ?? item.serverId ?? "";
  if (!lineServerId) throw new Error(`line item ${item.localId} did not return a server id`); // R02
  await db.lineItems.update(item.localId, { serverId: lineServerId });

  if (!item.proofBlob) {
    // Row acked with no proof to deliver: mark synced iff the current version still matches.
    await finalizeLineItem(item, ctx);
    return;
  }
  if (!isEditableServerStatus(serverStatus) && !SUBMITTED_PROOF_FINALISATION_ENABLED) {
    ctx.blocked = true; // defensive; reconcile already guards locked+disabled
    return;
  }

  // Area 1: bind key+bytes+hash+size+metadata from one fresh read; upload THAT version.
  const bound = await bindLineItemProof(item.localId);
  if (!bound) return; // proof removed before upload
  const path = buildProofPath(period, bound.key);
  await uploadProofStable(supabase, path, bound);

  const { data: existing, error: selErr } = await supabase
    .from("cashbook_attachment").select("id").eq("line_item_id", lineServerId).eq("file_url", path).limit(1);
  if (selErr) throw new Error(selErr.message);
  if (!existing || existing.length === 0) {
    const { data: ins, error: insErr } = await supabase.from("cashbook_attachment").insert({
      line_item_id: lineServerId,
      file_url: path,
      // Task 3: date + bank ref come from the SAME bound version as the uploaded bytes/key.
      transaction_date: bound.date,
      bank_reference: bound.bankRef,
      congregation_id: period.congregationId,
      uploaded_by: period.capturedByUserId,
    }).select("id");
    if (insErr) throw new Error(insErr.message);
    requireOneRow(ins as { id?: string }[] | null, "attachment insert");
  }

  const { data: stRows, error: stErr } = await supabase
    .from("cashbook_line_item").update({ proof_status: "Deposited" }).eq("id", lineServerId).select("id");
  if (stErr) throw new Error(stErr.message);
  requireOneRow(stRows as { id?: string }[] | null, "proof-status update");

  // Area 1: atomic compare-and-clear. Clear ONLY the exact delivered version; a newer
  // replacement (different key) is left intact and keeps the parent pending.
  await db.transaction("rw", db.lineItems, async () => {
    const current = await db.lineItems.get(item.localId);
    if (!current) throw new Error("line item vanished during proof finalisation");
    if (current.proofObjectKey === bound.key) {
      await db.lineItems.update(item.localId, { proof_status: "Deposited", proofBlob: null });
    } else {
      ctx.pendingRemains = true; // newer bytes await their own delivery
    }
  });
  // Row + proof both handled: mark synced iff nothing newer slipped in.
  await finalizeLineItem(item, ctx);
}

async function syncDepositSlip(
  supabase: SB,
  periodServerId: string,
  serverStatus: string,
  period: LocalPeriod,
  items: LocalLineItem[],
  ctx: ReconcileCtx
): Promise<void> {
  if (!period.depositBlob) return;
  if (!isEditableServerStatus(serverStatus) && !SUBMITTED_PROOF_FINALISATION_ENABLED) {
    ctx.blocked = true;
    return;
  }

  // Area 1: bind the deposit version (key+bytes+hash+size) from one fresh read.
  const bound = await bindDepositProof(period.localId);
  if (!bound) return;
  const path = buildProofPath(period, bound.key);
  const banked = items.filter((i) => i.item_type === "CashBanked");

  let allAcked = banked.length > 0;
  let uploaded = false;
  for (const bi of banked) {
    const current = await db.lineItems.get(bi.localId);
    const lineServerId = current?.serverId;
    if (!lineServerId) {
      allAcked = false; // R02: required banked item has no server id yet
      continue;
    }
    if (!uploaded) {
      await uploadProofStable(supabase, path, bound);
      uploaded = true;
    }
    const { data: existing, error: selErr } = await supabase
      .from("cashbook_attachment").select("id").eq("line_item_id", lineServerId).eq("file_url", path).limit(1);
    if (selErr) throw new Error(selErr.message);
    if (!existing || existing.length === 0) {
      const { data: ins, error: insErr } = await supabase.from("cashbook_attachment").insert({
        line_item_id: lineServerId,
        file_url: path,
        // Task 3: deposit date + bank ref bound to the same slip version as the bytes/key.
        transaction_date: bound.date,
        bank_reference: bound.bankRef,
        congregation_id: period.congregationId,
        uploaded_by: period.capturedByUserId,
      }).select("id");
      if (insErr) throw new Error(insErr.message);
      requireOneRow(ins as { id?: string }[] | null, "deposit attachment insert");
    }
    const { data: stRows, error: stErr } = await supabase
      .from("cashbook_line_item").update({ proof_status: "Deposited" }).eq("id", lineServerId).select("id");
    if (stErr) throw new Error(stErr.message);
    requireOneRow(stRows as { id?: string }[] | null, "deposit proof-status update");
    await db.lineItems.update(bi.localId, { proof_status: "Deposited" });
  }

  if (!allAcked) {
    throw new Error("Deposit slip retained: not every banked item has a confirmed server id/attachment yet");
  }
  // Area 1: release slip bytes only in a txn and only if this identity is still current.
  await db.transaction("rw", db.periods, async () => {
    const fresh = await db.periods.get(period.localId);
    if (fresh && fresh.depositObjectKey === bound.key) {
      await db.periods.update(period.localId, { depositBlob: null });
    } else {
      ctx.pendingRemains = true;
    }
  });
  void periodServerId;
}

async function persistConflictAudit(
  supabase: SB,
  period: LocalPeriod,
  serverId: string,
  serverStatus: string
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
