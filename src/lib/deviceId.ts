// ─────────────────────────────────────────────────────────────────────────────
// DEVICE ID (MVP hardening v5, Decision 4)
// Stable per-device UUID persisted in the Dexie syncMeta store under key "deviceId".
// Generated once on first use and reused thereafter. Used as r0DeviceId and for the
// same-device audit gate (syncEngine.isAuditApprovable). The "deviceId" row is an
// independent key from the "global" sync-bookkeeping row; neither writer clobbers the
// other.
// ─────────────────────────────────────────────────────────────────────────────

import { db } from "@/db/schema";

export const DEVICE_ID_KEY = "deviceId";

export async function getOrCreateDeviceId(): Promise<string> {
  const row = await db.syncMeta.get(DEVICE_ID_KEY);
  if (row?.value) return row.value;
  const id = globalThis.crypto.randomUUID();
  await db.syncMeta.put({
    key: DEVICE_ID_KEY,
    value: id,
    lastSyncAt: null,
    lastReferenceRefreshAt: null,
    schemaVersion: 4,
  });
  return id;
}
