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
import { db, type CachedCredential, type OfflineUserProfile } from "@/db/schema";
import type { HierarchyLevel } from "@/lib/types";
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
  return { ok: true, credential };
}

// ─── Offline unlock (Req 5) ────────────────────────────────────────────────────
export async function unlockOffline(pin: string, userId?: string): Promise<UnlockResult> {
  const credential = userId
    ? await db.credentials.get(userId)
    : (await db.credentials.toArray())[0];

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

  // Success: reset counters, establish provisional offline session.
  await db.credentials.update(credential.userId, { failedAttempts: 0, lockedUntil: null });
  currentSession = {
    userId: credential.userId,
    role: credential.role,
    accessStartDate: credential.accessStartDate,
    accessEndDate: credential.accessEndDate,
    activatedAt: credential.activatedAt,
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

// ─────────────────────────────────────────────────────────────────────────────
// OFFLINE USER PROFILE (offline-pin-multiuser) — NON-SECRET display/scope cache.
// These touch only the `offlineUsers` store; they NEVER read or write PIN material,
// so the fail-closed auth + PIN-keyed HMAC invariants are untouched.
// ─────────────────────────────────────────────────────────────────────────────

// Display rule mirrors AppHeader / identity.ts: email prefix with the first char
// capitalized; initials = first two chars of that, uppercased.
function deriveDisplayName(email: string): string {
  const name = email.split("@")[0] || "User";
  return name.charAt(0).toUpperCase() + name.slice(1);
}

/**
 * Persist (upsert) the current user's non-secret offline profile keyed by userId.
 * Resolves the congregation name from the cached congregations store (Supabase
 * fallback when online); falls back to the congregationId string, never blocking.
 * Returns `firstTimeCached` = whether no row existed BEFORE this upsert (for the
 * optional first-time confirmation). Per-user write only; stores NO secret field.
 */
export async function persistOfflineUserProfile(input: {
  userId: string;
  email: string;
  role: Role;
  congregationId: string | null;
  hierarchyId: string | null;
  scopeLevel: HierarchyLevel;
}): Promise<{ firstTimeCached: boolean }> {
  const existing = await db.offlineUsers.get(input.userId);
  const firstTimeCached = existing == null;

  const displayName = deriveDisplayName(input.email);
  const initials = displayName.slice(0, 2).toUpperCase();

  let congregationName: string | null = null;
  if (input.congregationId) {
    const cached = await db.congregations.get(input.congregationId);
    if (cached?.name) {
      congregationName = cached.name;
    } else if (isOnline()) {
      try {
        const supabase = createClient();
        const { data } = await supabase
          .from("congregations")
          .select("name")
          .eq("id", input.congregationId)
          .maybeSingle();
        congregationName = data?.name ?? null;
      } catch {
        // Non-fatal: name resolution must never block login.
      }
    }
    // R1.4: fall back to the congregationId when the name cannot be resolved.
    if (!congregationName) congregationName = input.congregationId;
  }

  const profile: OfflineUserProfile = {
    userId: input.userId,
    email: input.email,
    role: input.role,
    displayName,
    initials,
    congregationId: input.congregationId,
    congregationName,
    scopeLevel: input.scopeLevel,
    hierarchyId: input.hierarchyId,
    lastSyncAt: new Date().toISOString(),
  };
  await db.offlineUsers.put(profile);
  return { firstTimeCached };
}

/**
 * List offline users that have a USABLE cached credential (R2.7), newest first.
 * A profile without a matching `credentials` row (e.g. a failed/absent PIN set) is
 * never offered for unlock. Pure Dexie reads; no crypto, no network.
 */
export async function getOfflineUsers(): Promise<OfflineUserProfile[]> {
  const profiles = await db.offlineUsers.toArray();
  const usable: OfflineUserProfile[] = [];
  for (const p of profiles) {
    const cred = await db.credentials.get(p.userId);
    if (cred) usable.push(p);
  }
  // lastSyncAt is ISO, so lexicographic desc == chronological newest-first.
  return usable.sort((a, b) => (a.lastSyncAt < b.lastSyncAt ? 1 : -1));
}

/** True when an offline PIN credential exists for this user on this device. */
export async function hasPin(userId: string): Promise<boolean> {
  if (!userId) return false;
  return (await db.credentials.get(userId)) != null;
}

/**
 * Remove this user's offline PIN credential from this device (Change/Remove).
 * Deletes only the secret credential; the non-secret offline profile is left intact.
 */
export async function removePin(userId: string): Promise<void> {
  if (!userId) return;
  await db.credentials.delete(userId);
}
