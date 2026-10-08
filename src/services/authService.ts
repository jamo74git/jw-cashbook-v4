// ─────────────────────────────────────────────────────────────────────────────
// AUTH_SERVICE — offline PIN authentication lifecycle
// activation (online, Turnstile-gated) -> offline unlock (lockout) -> TTL ->
// reconnect re-validation (status/window/role) -> deactivation invalidation.
//
// Offline auth is a CONVENIENCE GATE, not the authority. Supabase RLS + reconnect
// re-validation remain authoritative (Req 6, 12, 13.2). Role/access resolved offline
// are provisional and cut off at next reconnect or by TTL expiry.
// ─────────────────────────────────────────────────────────────────────────────

import { createClient } from "@/lib/supabase/client";
import { db, type CachedCredential } from "@/db/schema";
import {
  DEFAULT_PBKDF2_ITERATIONS,
  derivePinHash,
  generateSalt,
  computeHmac,
  verifyHmac,
  verifyPin,
} from "@/services/crypto";
import type { Role } from "@/lib/types";

// ─── Tunable security parameters ─────────────────────────────────────────────
export const MAX_FAILED_ATTEMPTS = 5;
/** Max offline session lifetime before online re-auth is required (Req 6.1). */
export const OFFLINE_SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

// ─── Result types ─────────────────────────────────────────────────────────────
export interface OfflineSession {
  userId: string;
  role: Role;
  accessStartDate: string;
  accessEndDate: string | null;
  activatedAt: string;
  sessionStartedAt: string;
}

export type ActivationResult =
  | { ok: true; credential: CachedCredential }
  | { ok: false; reason: "offline" | "turnstile" | "auth" | "no_access" | "error"; message: string };

export type UnlockResult =
  | { ok: true; session: OfflineSession }
  | {
      ok: false;
      reason: "no_credential" | "locked" | "integrity" | "bad_pin";
      message: string;
      remainingAttempts?: number;
    };

export type RevalidationResult =
  | { ok: true; role: Role }
  | { ok: false; reason: "offline" | "inactive" | "expired" | "revoked" | "error"; message: string };

// ─── Integrity-protected canonical serialization (Req 15.3) ──────────────────
// Stable field order so the HMAC is reproducible.
function integrityMessage(fields: {
  pinHash: string;
  salt: string;
  kdfIterations: number;
  role: Role;
  accessStartDate: string;
  accessEndDate: string | null;
  activatedAt: string;
}): string {
  return JSON.stringify([
    fields.pinHash,
    fields.salt,
    fields.kdfIterations,
    fields.role,
    fields.accessStartDate,
    fields.accessEndDate,
    fields.activatedAt,
  ]);
}

// ─── In-memory offline session ────────────────────────────────────────────────
let currentSession: OfflineSession | null = null;
export function getSession(): OfflineSession | null {
  return currentSession;
}

function isOnline(): boolean {
  return typeof navigator === "undefined" ? true : navigator.onLine;
}

// ─── TTL helpers (pure; Property 6) ──────────────────────────────────────────
export function isTtlExpired(
  activatedAt: string,
  now: Date = new Date(),
  ttlMs: number = OFFLINE_SESSION_TTL_MS
): boolean {
  return now.getTime() > new Date(activatedAt).getTime() + ttlMs;
}

/** Ends the in-memory session if the offline TTL is exceeded (Req 6.1, 6.2). */
export function enforceTTL(now: Date = new Date()): OfflineSession | null {
  if (currentSession && isTtlExpired(currentSession.activatedAt, now)) {
    currentSession = null;
  }
  return currentSession;
}

// ─── Access-window helper (pure; fail-closed) ────────────────────────────────
export function isWithinAccessWindow(
  startDate: string,
  endDate: string | null,
  now: Date = new Date()
): boolean {
  const nowIso = now.toISOString();
  if (startDate && startDate > nowIso) return false;
  if (endDate && endDate < nowIso) return false;
  return true;
}

// ─── Online activation (Req 4) ────────────────────────────────────────────────
export async function activateOffline(input: {
  email: string;
  password: string;
  pin: string;
  turnstileToken?: string;
  iterations?: number;
}): Promise<ActivationResult> {
  if (!isOnline()) {
    return { ok: false, reason: "offline", message: "Activation requires an internet connection." };
  }

  const supabase = createClient();

  // Step 0: Turnstile (if a token is supplied) — verified server-side (Req 7).
  if (input.turnstileToken) {
    const { data, error } = await supabase.functions.invoke("verify-turnstile", {
      body: { token: input.turnstileToken },
    });
    if (error || !data?.success) {
      return { ok: false, reason: "turnstile", message: "Security verification failed." };
    }
  }

  // Step 1: authenticate with Supabase.
  const { data: auth, error: authErr } = await supabase.auth.signInWithPassword({
    email: input.email.trim(),
    password: input.password,
  });
  if (authErr || !auth.user) {
    return { ok: false, reason: "auth", message: "Invalid email or password." };
  }

  // Step 2: load the single active access record.
  const { data: access } = await supabase
    .from("user_hierarchy_access")
    .select("role, status, start_date, end_date")
    .eq("user_id", auth.user.id)
    .eq("status", "active")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (!access) {
    await supabase.auth.signOut();
    return { ok: false, reason: "no_access", message: "Access is restricted to registered members." };
  }

  // Step 3: derive credential material and persist (raw PIN never stored).
  const iterations = input.iterations ?? DEFAULT_PBKDF2_ITERATIONS;
  const salt = generateSalt();
  const pinHash = await derivePinHash(input.pin, salt, iterations);
  const activatedAt = new Date().toISOString();
  const role = access.role as Role;

  const hmac = await computeHmac(
    integrityMessage({
      pinHash,
      salt,
      kdfIterations: iterations,
      role,
      accessStartDate: access.start_date,
      accessEndDate: access.end_date,
      activatedAt,
    }),
    input.pin,
    salt,
    iterations
  );

  const credential: CachedCredential = {
    userId: auth.user.id,
    pinHash,
    salt,
    kdfIterations: iterations,
    hmac,
    role,
    accessStartDate: access.start_date,
    accessEndDate: access.end_date,
    activatedAt,
    failedAttempts: 0,
    lockedUntil: null,
  };

  await db.credentials.put(credential);

  // Record the relevant-user pointer for offline mode resolution (Req 2.1, 2.7).
  // Activation wrote a fresh HMAC over fresh server fields, so no staged refresh is
  // needed here — just set the pointer on success.
  await setLastActiveUserId(auth.user.id);

  return { ok: true, credential };
}

// ─── Relevant-user pointer helper (read-merge-write; preserves other meta) ──────
// Records who last authenticated online / activated / unlocked offline so the offline
// mode selection can resolve the "relevant user". syncMeta is keyed only by `key`, so a
// read-merge-write keeps `lastSyncAt` / `lastReferenceRefreshAt` intact.
async function setLastActiveUserId(userId: string): Promise<void> {
  const meta = await db.syncMeta.get("global");
  await db.syncMeta.put({
    key: "global",
    lastSyncAt: meta?.lastSyncAt ?? null,
    lastReferenceRefreshAt: meta?.lastReferenceRefreshAt ?? null,
    schemaVersion: meta?.schemaVersion ?? 2,
    lastActiveUserId: userId,
  });
}

// ─── Staged credential refresh (Req 2.3, 2.5) ───────────────────────────────
// Called by LoginPage on a password-only online login when a credential already exists
// for the authenticating user. A password-only login has no raw PIN, so it cannot
// re-sign the PIN-keyed HMAC; instead it stages the fresh server-derived values in the
// non-protected `pending*` fields and leaves the HMAC-protected set (and `hmac`)
// untouched — the binding stays valid. The staged values are committed into the
// protected set (with the HMAC recomputed from the entered PIN) at the next offline
// unlock (rebind-at-unlock, see `unlockOffline`).
export async function stageCredentialRefresh(
  userId: string,
  serverFields: {
    role: Role;
    accessStartDate: string;
    accessEndDate: string | null;
  }
): Promise<void> {
  // Per-user lookup; never operate on another user's record (fail-closed, 3.8).
  const credential = await db.credentials.get(userId);
  if (!credential) {
    // No credential to refresh — the caller handles PinSetup for this user.
    return;
  }

  // Write ONLY the non-protected `pending*` fields; the HMAC-protected set and `hmac`
  // are left intact so the existing binding remains valid.
  await db.credentials.update(userId, {
    pendingRole: serverFields.role,
    pendingAccessStartDate: serverFields.accessStartDate,
    pendingAccessEndDate: serverFields.accessEndDate,
    pendingRefreshedAt: new Date().toISOString(),
  });

  // Record the relevant-user pointer for offline mode resolution (Req 2.7).
  await setLastActiveUserId(userId);
}

// ─── Offline unlock (Req 5) ────────────────────────────────────────────────────
export async function unlockOffline(pin: string, userId?: string): Promise<UnlockResult> {
  // Resolve the target user per-record. NEVER `(await db.credentials.toArray())[0]` —
  // that is defect D (the wrong user's credential). Prefer the explicit `userId`; when a
  // caller omits it, fall back to the relevant-user pointer, then `get` that record.
  const targetUserId =
    userId ?? (await db.syncMeta.get("global"))?.lastActiveUserId ?? undefined;
  const credential = targetUserId ? await db.credentials.get(targetUserId) : undefined;

  if (!credential) {
    return { ok: false, reason: "no_credential", message: "No offline access is set up on this device." };
  }

  // Locked until online re-authentication (Req 5.5).
  if (credential.lockedUntil) {
    return { ok: false, reason: "locked", message: "Offline access is locked. Sign in online to unlock." };
  }

  // Integrity check FIRST — reject tampered credential (Req 5.4, 15.4, Property 3).
  const integrityOk = await verifyHmac(
    integrityMessage(credential),
    credential.hmac,
    pin,
    credential.salt,
    credential.kdfIterations
  );

  const pinOk = await verifyPin(pin, credential.pinHash, credential.salt, credential.kdfIterations);

  // A correct PIN satisfies both the PIN hash and (being the HMAC key) the integrity
  // check. If the PIN is right but integrity fails, the stored fields were tampered.
  if (pinOk && !integrityOk) {
    await db.credentials.update(credential.userId, { lockedUntil: new Date().toISOString() });
    return { ok: false, reason: "integrity", message: "Stored credential failed its integrity check. Re-activate online." };
  }

  if (!pinOk) {
    const failedAttempts = credential.failedAttempts + 1;
    const locked = failedAttempts >= MAX_FAILED_ATTEMPTS;
    await db.credentials.update(credential.userId, {
      failedAttempts,
      lockedUntil: locked ? new Date().toISOString() : null,
    });
    if (locked) {
      return { ok: false, reason: "locked", message: "Too many attempts. Sign in online to unlock." };
    }
    return {
      ok: false,
      reason: "bad_pin",
      message: "Incorrect PIN.",
      remainingAttempts: MAX_FAILED_ATTEMPTS - failedAttempts,
    };
  }

  // Success: reset counters.
  await db.credentials.update(credential.userId, { failedAttempts: 0, lockedUntil: null });

  // Session fields default to the currently stored (pre-refresh) values; a successful
  // rebind-at-unlock below promotes any staged refresh over them.
  let sessionRole = credential.role;
  let sessionAccessStartDate = credential.accessStartDate;
  let sessionAccessEndDate = credential.accessEndDate;
  let sessionActivatedAt = credential.activatedAt;

  // Rebind-at-unlock (HMAC-Refresh Decision option 4): the integrity check above already
  // ran against the CURRENTLY STORED HMAC-protected fields, so a tampered record is
  // rejected before we get here. Now that the PIN is in hand, commit any staged refresh:
  // recompute the HMAC over the NEW protected set and persist it atomically with the new
  // fields, clearing all `pending*`. A failure aborts the commit and leaves the prior
  // valid credential intact (never a half-written protected set).
  const hasPendingRefresh =
    credential.pendingRole != null ||
    credential.pendingAccessStartDate != null ||
    credential.pendingAccessEndDate != null ||
    credential.pendingRefreshedAt != null;

  if (hasPendingRefresh) {
    const newRole = (credential.pendingRole ?? credential.role) as Role;
    const newAccessStartDate = credential.pendingAccessStartDate ?? credential.accessStartDate;
    // `pendingAccessEndDate` is nullable by design (a credential may legitimately have no
    // end date). Staging always writes the whole `pending*` set together, so when a
    // refresh is pending this value is authoritative (null => no end date).
    const newAccessEndDate = credential.pendingAccessEndDate ?? null;
    const newActivatedAt = credential.pendingRefreshedAt ?? credential.activatedAt;

    try {
      const newHmac = await computeHmac(
        integrityMessage({
          pinHash: credential.pinHash,
          salt: credential.salt,
          kdfIterations: credential.kdfIterations,
          role: newRole,
          accessStartDate: newAccessStartDate,
          accessEndDate: newAccessEndDate,
          activatedAt: newActivatedAt,
        }),
        pin,
        credential.salt,
        credential.kdfIterations
      );

      await db.credentials.update(credential.userId, {
        role: newRole,
        accessStartDate: newAccessStartDate,
        accessEndDate: newAccessEndDate,
        activatedAt: newActivatedAt,
        hmac: newHmac,
        pendingRole: null,
        pendingAccessStartDate: null,
        pendingAccessEndDate: null,
        pendingRefreshedAt: null,
      });

      sessionRole = newRole;
      sessionAccessStartDate = newAccessStartDate;
      sessionAccessEndDate = newAccessEndDate;
      sessionActivatedAt = newActivatedAt;
    } catch {
      // Commit failed: abort the rebind. The prior valid credential (and its HMAC) is
      // untouched, so the session proceeds on the pre-refresh fields and the staged
      // refresh is retried at the next unlock.
    }
  }

  // Record the relevant-user pointer for offline mode resolution (Req 2.7).
  await setLastActiveUserId(credential.userId);

  // Establish the provisional offline session from the now-current fields.
  currentSession = {
    userId: credential.userId,
    role: sessionRole,
    accessStartDate: sessionAccessStartDate,
    accessEndDate: sessionAccessEndDate,
    activatedAt: sessionActivatedAt,
    sessionStartedAt: new Date().toISOString(),
  };
  return { ok: true, session: currentSession };
}

// ─── Reconnect re-validation (Req 6.3–6.6, 12.5, 15.5) ───────────────────────
export async function revalidateOnReconnect(userId?: string): Promise<RevalidationResult> {
  if (!isOnline()) {
    return { ok: false, reason: "offline", message: "Cannot re-validate while offline." };
  }

  const credential = userId
    ? await db.credentials.get(userId)
    : (await db.credentials.toArray())[0];
  if (!credential) {
    return { ok: false, reason: "error", message: "No cached credential to re-validate." };
  }

  const supabase = createClient();
  const { data: access, error } = await supabase
    .from("user_hierarchy_access")
    .select("role, status, start_date, end_date")
    .eq("user_id", credential.userId)
    .eq("status", "active")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  // Any failure to complete re-validation is non-authorizing (Req 6.6).
  if (error) {
    currentSession = null;
    return { ok: false, reason: "error", message: "Re-validation failed." };
  }

  // Deactivated / revoked -> invalidate credential and end session (Req 6.4, 15.5).
  if (!access) {
    currentSession = null;
    await db.credentials.delete(credential.userId);
    return { ok: false, reason: "revoked", message: "Access has been revoked." };
  }

  // Outside the access window -> fail closed (Req 6.4).
  if (!isWithinAccessWindow(access.start_date, access.end_date)) {
    currentSession = null;
    return { ok: false, reason: "expired", message: "Access period is not active." };
  }

  // Reconcile server role into the credential and re-scope the session (Req 6.5).
  const serverRole = access.role as Role;
  const now = new Date().toISOString();
  await db.credentials.update(credential.userId, {
    role: serverRole,
    accessStartDate: access.start_date,
    accessEndDate: access.end_date,
    // Refresh activation timestamp so the offline TTL restarts on successful revalidation.
    activatedAt: now,
  });
  if (currentSession && currentSession.userId === credential.userId) {
    currentSession = { ...currentSession, role: serverRole, activatedAt: now };
  }

  return { ok: true, role: serverRole };
}

// ─── Sign out (Req 15.6) ──────────────────────────────────────────────────────
export function signOut(): void {
  currentSession = null;
}
