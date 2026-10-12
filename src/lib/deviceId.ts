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

// ─────────────────────────────────────────────────────────────────────────────
// OFFLINE-PIN "DON'T ASK AGAIN" DISMISSAL (GAP A)
// Per-user, per-device preference persisted in localStorage so a user who skipped
// offline-PIN setup with "Don't ask again for this device" is not nagged on every
// sign-in. Device scoping is implicit: localStorage is per browser/device. Guarded
// for non-browser (test/SSR) environments so it never throws.
// ─────────────────────────────────────────────────────────────────────────────

export const OFFLINE_PIN_DISMISSED_PREFIX = "oac_offline_pin_dismissed_";

/** True when this user has dismissed offline-PIN setup on this device. */
export function isOfflinePinDismissed(userId: string): boolean {
  if (!userId) return false;
  try {
    if (typeof localStorage === "undefined") return false;
    return localStorage.getItem(OFFLINE_PIN_DISMISSED_PREFIX + userId) === "1";
  } catch {
    return false;
  }
}

/**
 * Set/clear the per-user dismissal flag. `true` = "Don't ask again for this device";
 * `false` = remind again / re-enable. A plain Skip never calls this (remind later).
 */
export function setOfflinePinDismissed(userId: string, dismissed: boolean): void {
  if (!userId) return;
  try {
    if (typeof localStorage === "undefined") return;
    const key = OFFLINE_PIN_DISMISSED_PREFIX + userId;
    if (dismissed) localStorage.setItem(key, "1");
    else localStorage.removeItem(key);
  } catch {
    // Storage unavailable (private mode / quota) — treat as non-dismissed.
  }
}
