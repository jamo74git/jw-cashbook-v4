// ─────────────────────────────────────────────────────────────────────────────
// offline-pin-flow-fix — Task 2: PRESERVATION property tests (Property 2)
//
// These lock in the NON-BUGGY behavior that must stay identical after the fix
// (`NOT isBugCondition(X)` inputs). They are written and observed on the UNFIXED
// code first; the EXPECTED OUTCOME here is that they PASS, establishing the
// baseline to preserve. Task 9.2 re-runs this exact file against the fixed code.
//
// Captured cases (design "Preservation Checking", bugfix.md 3.1–3.8):
//   3.1  unlock + lockout         3.2/3.6 crypto unchanged + raw PIN never stored
//   3.3  fail-closed              3.4     dashboard routing via getDashboardRoute
//   3.5  revoke/expire            3.8     multi-user credential coexistence
//
// Env: Vitest (node). Dexie runs on fake-indexeddb; WebCrypto is native under
// Node ≥ 20. The Supabase client is mocked so the online activation / reconnect
// paths are deterministic. Crypto primitives in src/services/crypto.ts are used
// unmodified (never mocked), per the hard constraints.
// ─────────────────────────────────────────────────────────────────────────────

import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fc from "fast-check";

// ── Controllable Supabase mock (hoisted so vi.mock's factory can see it) ──────
const mock = vi.hoisted(() => ({
  turnstileResult: { data: { success: true } as unknown, error: null as unknown },
  signInResult: {
    data: { user: { id: "user-default" } as { id: string } | null },
    error: null as unknown,
  },
  accessResult: { data: null as unknown, error: null as unknown },
  signOutCount: 0,
}));

vi.mock("@/lib/supabase/client", () => ({
  createClient: () => ({
    functions: {
      invoke: async () => mock.turnstileResult,
    },
    auth: {
      signInWithPassword: async () => mock.signInResult,
      signOut: async () => {
        mock.signOutCount++;
        return { error: null };
      },
    },
    from: () => {
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        order: () => builder,
        limit: () => builder,
        maybeSingle: async () => mock.accessResult,
      };
      return builder;
    },
  }),
}));

import {
  activateOffline,
  unlockOffline,
  revalidateOnReconnect,
  signOut,
  getSession,
  isTtlExpired,
  enforceTTL,
  isWithinAccessWindow,
  MAX_FAILED_ATTEMPTS,
  OFFLINE_SESSION_TTL_MS,
} from "@/services/authService";
import {
  derivePinHash,
  computeHmac,
  verifyPin,
  verifyHmac,
  generateSalt,
} from "@/services/crypto";
import { db } from "@/db/schema";
import { getDashboardRoute } from "@/lib/permissions";
import { ROLES, type Role } from "@/lib/types";

// Low work factor keeps the property runs fast; crypto determinism is unaffected.
const LOW_ITERS = 1000;
const FAR_PAST = "2000-01-01T00:00:00.000Z";
const FAR_FUTURE = "2999-01-01T00:00:00.000Z";

const pinArb = () => fc.integer({ min: 1000, max: 999999 }).map(String);

/** Seed a real CachedCredential for `userId` via the production activation path. */
async function activate(
  userId: string,
  pin: string,
  role: Role,
  start: string = FAR_PAST,
  end: string | null = FAR_FUTURE,
) {
  mock.signInResult = { data: { user: { id: userId } }, error: null };
  mock.accessResult = {
    data: { role, status: "active", start_date: start, end_date: end },
    error: null,
  };
  const res = await activateOffline({
    email: `${userId}@test`,
    password: "pw",
    pin,
    iterations: LOW_ITERS,
  });
  if (!res.ok) throw new Error(`activate(${userId}) failed: ${res.reason}`);
  return res.credential;
}

beforeEach(async () => {
  // authService.isOnline() reads navigator.onLine; pin it true for the online paths.
  vi.stubGlobal("navigator", { onLine: true });
  mock.turnstileResult = { data: { success: true }, error: null };
  mock.signInResult = { data: { user: { id: "user-default" } }, error: null };
  mock.accessResult = { data: null, error: null };
  mock.signOutCount = 0;
  signOut();
  await db.credentials.clear();
  await db.syncMeta.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("offline-pin-flow preservation (Property 2 — NOT isBugCondition)", () => {
  // ── 3.1 unlock + lockout ────────────────────────────────────────────────
  // Validates: Requirements 3.1
  it("3.1 correct PIN unlocks; wrong PIN increments failedAttempts and locks at MAX_FAILED_ATTEMPTS", async () => {
    await fc.assert(
      fc.asyncProperty(pinArb(), async (pin) => {
        await db.credentials.clear();
        signOut();
        const userId = "u-lock";
        await activate(userId, pin, "Treasurer");

        // Correct PIN unlocks and establishes a provisional session.
        const ok = await unlockOffline(pin, userId);
        expect(ok.ok).toBe(true);
        if (ok.ok) expect(ok.session.role).toBe("Treasurer");

        // A guaranteed-different PIN (longer string) drives the lockout counter.
        const wrong = pin + "0";
        for (let i = 1; i < MAX_FAILED_ATTEMPTS; i++) {
          const r = await unlockOffline(wrong, userId);
          expect(r.ok).toBe(false);
          if (!r.ok) expect(r.reason).toBe("bad_pin");
        }
        const locked = await unlockOffline(wrong, userId);
        expect(locked.ok).toBe(false);
        if (!locked.ok) expect(locked.reason).toBe("locked");

        const cred = await db.credentials.get(userId);
        expect(cred?.lockedUntil).toBeTruthy();
      }),
      { numRuns: 10 },
    );
  });

  // ── 3.2 / 3.6 crypto unchanged + raw PIN never stored ────────────────────
  // Validates: Requirements 3.2, 3.6
  it("3.2/3.6 PBKDF2 + PIN-keyed HMAC are deterministic and verify correctly", async () => {
    await fc.assert(
      fc.asyncProperty(pinArb(), pinArb(), async (pin, other) => {
        const salt = generateSalt();

        const h1 = await derivePinHash(pin, salt, LOW_ITERS);
        const h2 = await derivePinHash(pin, salt, LOW_ITERS);
        expect(h1).toBe(h2);
        expect(await verifyPin(pin, h1, salt, LOW_ITERS)).toBe(true);

        const message = JSON.stringify([h1, salt, LOW_ITERS, "Treasurer"]);
        const m1 = await computeHmac(message, pin, salt, LOW_ITERS);
        const m2 = await computeHmac(message, pin, salt, LOW_ITERS);
        expect(m1).toBe(m2);
        expect(await verifyHmac(message, m1, pin, salt, LOW_ITERS)).toBe(true);

        // A different PIN must not verify against either the hash or the HMAC.
        if (other !== pin) {
          expect(await verifyPin(other, h1, salt, LOW_ITERS)).toBe(false);
          expect(await verifyHmac(message, m1, other, salt, LOW_ITERS)).toBe(false);
        }
      }),
      { numRuns: 15 },
    );
  });

  // Validates: Requirements 3.6
  it("3.6 a persisted credential stores only pinHash/salt/hmac — never the raw PIN", async () => {
    const pin = "246813";
    await activate("u-norawpin", pin, "Elder");
    const stored = await db.credentials.get("u-norawpin");

    expect(stored).toBeTruthy();
    expect(stored!.pinHash).toBeTruthy();
    expect(stored!.salt).toBeTruthy();
    expect(stored!.hmac).toBeTruthy();
    // No field named for the PIN and no field value equal to the raw PIN.
    expect(Object.keys(stored!)).not.toContain("pin");
    expect(Object.values(stored!)).not.toContain(pin);
  });

  // ── 3.3 fail-closed ──────────────────────────────────────────────────────
  // Validates: Requirements 3.3
  it("3.3 each failed step blocks and never establishes a session", async () => {
    // (a) bad auth -> blocked, no session.
    mock.signInResult = { data: { user: null }, error: { message: "bad creds" } };
    let r = await activateOffline({ email: "x@test", password: "pw", pin: "1234", iterations: LOW_ITERS });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("auth");
    expect(getSession()).toBeNull();

    // (b) authenticated but no active access -> signed out, blocked.
    mock.signInResult = { data: { user: { id: "u-noaccess" } }, error: null };
    mock.accessResult = { data: null, error: null };
    r = await activateOffline({ email: "x@test", password: "pw", pin: "1234", iterations: LOW_ITERS });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe("no_access");
    expect(mock.signOutCount).toBeGreaterThan(0);
    expect(getSession()).toBeNull();

    // (c) tampered HMAC-protected field -> integrity failure, locked, no session.
    const pin = "4321";
    await activate("u-tamper", pin, "Treasurer");
    await db.credentials.update("u-tamper", { role: "HO" }); // mutate protected field, do NOT re-sign
    const unlock = await unlockOffline(pin, "u-tamper");
    expect(unlock.ok).toBe(false);
    if (!unlock.ok) expect(unlock.reason).toBe("integrity");
    expect(getSession()).toBeNull();

    // (d) out-of-window access windows fail closed.
    const now = new Date("2020-06-15T00:00:00.000Z");
    expect(isWithinAccessWindow("2020-07-01T00:00:00.000Z", null, now)).toBe(false); // not started
    expect(isWithinAccessWindow("2020-01-01T00:00:00.000Z", "2020-02-01T00:00:00.000Z", now)).toBe(false); // expired

    // (e) TTL expiry ends an established session.
    await db.credentials.clear();
    signOut();
    const ttlPin = "5678";
    await activate("u-ttl", ttlPin, "Auditor");
    const ur = await unlockOffline(ttlPin, "u-ttl");
    expect(ur.ok).toBe(true);
    expect(getSession()).not.toBeNull();
    const activatedAt = ur.ok ? ur.session.activatedAt : new Date().toISOString();
    expect(isTtlExpired(activatedAt, new Date(Date.now() + OFFLINE_SESSION_TTL_MS + 10_000))).toBe(true);
    const future = new Date(Date.now() + OFFLINE_SESSION_TTL_MS + 10_000);
    expect(enforceTTL(future)).toBeNull();
    expect(getSession()).toBeNull();
  });

  // ── 3.4 dashboard routing ────────────────────────────────────────────────
  // Validates: Requirements 3.4
  it("3.4 getDashboardRoute(role) is stable for every role (routing unchanged)", () => {
    const expected: Record<Role, string> = {
      HO: "/ho",
      Apostle: "/review",
      Overseer: "/review",
      Elder: "/elder",
      Chairperson: "/chairperson",
      Treasurer: "/treasurer",
      Auditor: "/audit",
      Secretary: "/secretary",
    };
    for (const role of ROLES) {
      expect(getDashboardRoute(role)).toBe(expected[role]);
    }
  });

  // Validates: Requirements 3.1, 3.4
  it("3.4 a valid unlock yields the credential role, which routes via getDashboardRoute", async () => {
    await fc.assert(
      fc.asyncProperty(fc.constantFrom(...ROLES), pinArb(), async (role, pin) => {
        await db.credentials.clear();
        signOut();
        await activate("u-route", pin, role);
        const r = await unlockOffline(pin, "u-route");
        expect(r.ok).toBe(true);
        if (r.ok) {
          expect(r.session.role).toBe(role);
          expect(getDashboardRoute(r.session.role)).toBe(getDashboardRoute(role));
          expect(typeof getDashboardRoute(r.session.role)).toBe("string");
        }
      }),
      { numRuns: 8 },
    );
  });

  // ── 3.5 revoke / expire ──────────────────────────────────────────────────
  // Validates: Requirements 3.5
  it("3.5 revalidateOnReconnect on a revoked user deletes the credential and ends the session", async () => {
    const pin = "1357";
    await activate("u-revoke", pin, "Treasurer");
    const ur = await unlockOffline(pin, "u-revoke");
    expect(ur.ok).toBe(true);
    expect(getSession()).not.toBeNull();

    // Server now reports no active access -> revoked.
    mock.accessResult = { data: null, error: null };
    const rev = await revalidateOnReconnect("u-revoke");
    expect(rev.ok).toBe(false);
    if (!rev.ok) expect(rev.reason).toBe("revoked");
    expect(await db.credentials.get("u-revoke")).toBeUndefined();
    expect(getSession()).toBeNull();
  });

  // Validates: Requirements 3.5
  it("3.5 revalidateOnReconnect on an out-of-window user ends the session (credential retained)", async () => {
    const pin = "2468";
    await activate("u-exp", pin, "Elder");
    const ur = await unlockOffline(pin, "u-exp");
    expect(ur.ok).toBe(true);

    // Access present but the window has already closed.
    mock.accessResult = {
      data: {
        role: "Elder",
        status: "active",
        start_date: "2000-01-01T00:00:00.000Z",
        end_date: "2001-01-01T00:00:00.000Z",
      },
      error: null,
    };
    const rev = await revalidateOnReconnect("u-exp");
    expect(rev.ok).toBe(false);
    if (!rev.ok) expect(rev.reason).toBe("expired");
    expect(getSession()).toBeNull();
    // Expiry ends the session but does not delete the credential (only revoke deletes).
    expect(await db.credentials.get("u-exp")).toBeTruthy();
  });

  // ── 3.8 multi-user coexistence ───────────────────────────────────────────
  // Validates: Requirements 3.8
  it("3.8 operating on userA never mutates or deletes userB's credential", async () => {
    const pinA = "1111";
    const pinB = "2222";
    await activate("userA", pinA, "Treasurer");
    await activate("userB", pinB, "Elder");
    const beforeB = await db.credentials.get("userB");

    // Lock userA with repeated wrong PINs.
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) await unlockOffline("9999", "userA");
    expect(await db.credentials.get("userB")).toEqual(beforeB);

    // Revoke userA -> only userA's credential is deleted.
    mock.accessResult = { data: null, error: null };
    await revalidateOnReconnect("userA");
    expect(await db.credentials.get("userA")).toBeUndefined();
    expect(await db.credentials.get("userB")).toEqual(beforeB);

    // userB is still unlockable with its own PIN.
    const ub = await unlockOffline(pinB, "userB");
    expect(ub.ok).toBe(true);
    if (ub.ok) expect(ub.session.role).toBe("Elder");
  });

  // Validates: Requirements 3.8
  it("3.8 (property) unlocking an arbitrary user leaves every other user's credential intact", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uniqueArray(fc.integer({ min: 1, max: 6 }).map((n) => `pu-${n}`), {
          minLength: 2,
          maxLength: 4,
        }),
        pinArb(),
        fc.nat(),
        async (userIds, pin, pick) => {
          await db.credentials.clear();
          signOut();
          for (const uid of userIds) await activate(uid, pin, "Treasurer");

          const target = userIds[pick % userIds.length];
          const snapshots = new Map(
            await Promise.all(
              userIds
                .filter((u) => u !== target)
                .map(async (u) => [u, await db.credentials.get(u)] as const),
            ),
          );

          // A correct unlock of the target must not touch the others.
          const r = await unlockOffline(pin, target);
          expect(r.ok).toBe(true);
          for (const [u, snap] of snapshots) {
            expect(await db.credentials.get(u)).toEqual(snap);
          }
        },
      ),
      { numRuns: 8 },
    );
  });
});
