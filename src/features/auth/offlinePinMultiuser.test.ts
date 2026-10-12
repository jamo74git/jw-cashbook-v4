// ─────────────────────────────────────────────────────────────────────────────
// offline-pin-multiuser — Task 9: property / behavior tests
//
// Covers the design's Correctness Properties for the multi-user offline flow:
//   P1/P3  profile fidelity + isolation (firstTimeCached, update-not-duplicate)
//   P2     no secret leakage in the offline profile
//   P4     credential-backed listing (getOfflineUsers) incl. the R3.7 no-orphan case
//   P5     targeted per-user unlock (right vs wrong PIN; lockout preserved; isolation)
//   P6/P7  offline identity hydration + scope soundness (never 0 when a cong is cached)
//
// Env: Vitest (node). Dexie on fake-indexeddb; WebCrypto native under Node >= 20.
// The Supabase client is mocked so activation is deterministic; crypto primitives
// in src/services/crypto.ts are used unmodified (never mocked).
// ─────────────────────────────────────────────────────────────────────────────

import "fake-indexeddb/auto";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

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
    functions: { invoke: async () => mock.turnstileResult },
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
  signOut,
  getSession,
  persistOfflineUserProfile,
  getOfflineUsers,
  MAX_FAILED_ATTEMPTS,
} from "@/services/authService";
import { getCurrentIdentity, computeScopeCount } from "@/lib/identity";
import { db, type CongregationLookup } from "@/db/schema";
import type { Role } from "@/lib/types";

const LOW_ITERS = 1000;
const FAR_PAST = "2000-01-01T00:00:00.000Z";
const FAR_FUTURE = "2999-01-01T00:00:00.000Z";

/** Seed a real CachedCredential for `userId` via the production activation path. */
async function activate(userId: string, pin: string, role: Role) {
  mock.signInResult = { data: { user: { id: userId } }, error: null };
  mock.accessResult = {
    data: { role, status: "active", start_date: FAR_PAST, end_date: FAR_FUTURE },
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

function cong(id: string, name: string, elderId: string | null): CongregationLookup {
  return {
    id,
    name,
    code: id.toUpperCase(),
    overseership_id: null,
    eldership_id: elderId,
    apostleship_id: null,
    district_id: null,
  };
}

beforeEach(async () => {
  vi.stubGlobal("navigator", { onLine: true });
  mock.turnstileResult = { data: { success: true }, error: null };
  mock.signInResult = { data: { user: { id: "user-default" } }, error: null };
  mock.accessResult = { data: null, error: null };
  mock.signOutCount = 0;
  signOut();
  await db.credentials.clear();
  await db.offlineUsers.clear();
  await db.congregations.clear();
  await db.syncMeta.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("offline-pin-multiuser (Task 9 — properties)", () => {
  // ── P1/P3: profile fidelity + firstTimeCached + isolation ─────────────────
  // Validates: Requirements 1.1, 2a, 1.8
  it("persistOfflineUserProfile reports firstTimeCached and updates (not duplicates) the row", async () => {
    await db.congregations.put(cong("cong-bos", "Bosmont", "eld-1"));

    const first = await persistOfflineUserProfile({
      userId: "userA",
      email: "treasurer@bosmont.test",
      role: "Treasurer",
      congregationId: "cong-bos",
      hierarchyId: "eld-1",
      scopeLevel: "Congregation",
    });
    expect(first.firstTimeCached).toBe(true);

    const stored = await db.offlineUsers.get("userA");
    expect(stored?.email).toBe("treasurer@bosmont.test");
    expect(stored?.role).toBe("Treasurer");
    expect(stored?.displayName).toBe("Treasurer");
    expect(stored?.initials).toBe("TR");
    expect(stored?.congregationName).toBe("Bosmont");
    expect(stored?.lastSyncAt).toBeTruthy();

    // A repeat login updates the same row and reports firstTimeCached=false.
    const second = await persistOfflineUserProfile({
      userId: "userA",
      email: "treasurer@bosmont.test",
      role: "Elder",
      congregationId: "cong-bos",
      hierarchyId: "eld-1",
      scopeLevel: "Congregation",
    });
    expect(second.firstTimeCached).toBe(false);
    expect(await db.offlineUsers.count()).toBe(1);
    expect((await db.offlineUsers.get("userA"))?.role).toBe("Elder");
  });

  // Validates: Requirements 1.4 (name fallback to id when unresolved, non-blocking)
  it("falls back congregationName to the congregationId when the name cannot be resolved", async () => {
    vi.stubGlobal("navigator", { onLine: false }); // no Supabase fallback, nothing cached
    const res = await persistOfflineUserProfile({
      userId: "userX",
      email: "x@test",
      role: "Treasurer",
      congregationId: "cong-unknown",
      hierarchyId: null,
      scopeLevel: "Congregation",
    });
    expect(res.firstTimeCached).toBe(true);
    expect((await db.offlineUsers.get("userX"))?.congregationName).toBe("cong-unknown");
  });

  // ── P2: no secret leakage ─────────────────────────────────────────────────
  // Validates: Requirements 1.7
  it("the offline profile stores no PIN / hash / salt / HMAC field", async () => {
    await persistOfflineUserProfile({
      userId: "userA",
      email: "treasurer@bosmont.test",
      role: "Treasurer",
      congregationId: null,
      hierarchyId: null,
      scopeLevel: "Congregation",
    });
    const stored = await db.offlineUsers.get("userA");
    const keys = Object.keys(stored!);
    for (const forbidden of ["pin", "pinHash", "salt", "hmac", "kdfIterations"]) {
      expect(keys).not.toContain(forbidden);
    }
  });

  // ── P4: credential-backed listing + no-orphan (R3.7) ──────────────────────
  // Validates: Requirements 2.7, 3.7
  it("getOfflineUsers lists only profiles with a usable credential, newest first", async () => {
    // userA: profile + credential (listed). userB: profile only (orphan, excluded).
    await activate("userA", "1111", "Treasurer");
    await persistOfflineUserProfile({
      userId: "userA", email: "a@bosmont.test", role: "Treasurer",
      congregationId: null, hierarchyId: null, scopeLevel: "Congregation",
    });
    await persistOfflineUserProfile({
      userId: "userB", email: "b@other.test", role: "Treasurer",
      congregationId: null, hierarchyId: null, scopeLevel: "Congregation",
    });

    let users = await getOfflineUsers();
    expect(users.map((u) => u.userId)).toEqual(["userA"]);

    // Give userB a credential too; now both are listed, newest lastSyncAt first.
    await activate("userB", "2222", "Treasurer");
    // Bump userB's lastSyncAt so it sorts ahead of userA.
    await db.offlineUsers.update("userB", { lastSyncAt: "2999-12-31T00:00:00.000Z" });
    users = await getOfflineUsers();
    expect(users.map((u) => u.userId)).toEqual(["userB", "userA"]);
  });

  // Validates: Requirements 3.7 (failed PIN-set leaves no offline-usable profile)
  it("a profile without a credential (failed/absent PIN set) is never offered for unlock", async () => {
    await persistOfflineUserProfile({
      userId: "orphan", email: "orphan@test", role: "Treasurer",
      congregationId: null, hierarchyId: null, scopeLevel: "Congregation",
    });
    expect(await db.offlineUsers.get("orphan")).toBeTruthy();
    expect(await getOfflineUsers()).toEqual([]);
  });

  // ── P5: targeted per-user unlock ──────────────────────────────────────────
  // Validates: Requirements 3.1, 3.2, 3.3, 3.4
  it("unlocks the selected user with their PIN; a wrong PIN never unlocks another user", async () => {
    await activate("userB", "1111", "Treasurer"); // sorts first in the raw store
    await activate("userA", "2222", "Elder");

    // Right PIN for the explicitly selected userA unlocks userA (not toArray()[0]).
    const ok = await unlockOffline("2222", "userA");
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.session.userId).toBe("userA");
      expect(ok.session.role).toBe("Elder");
    }

    signOut();
    // Wrong PIN for userA fails and must not establish any session for userB.
    const bad = await unlockOffline("9999", "userA");
    expect(bad.ok).toBe(false);
    expect(getSession()).toBeNull();
    // userB's credential is untouched and still unlockable with its own PIN.
    const okB = await unlockOffline("1111", "userB");
    expect(okB.ok).toBe(true);
    if (okB.ok) expect(okB.session.userId).toBe("userB");
  });

  // Validates: Requirements 3.3 (lockout preserved per-user)
  it("preserves the lockout threshold for the targeted user without affecting others", async () => {
    await activate("userA", "2222", "Treasurer");
    await activate("userB", "3333", "Elder");
    for (let i = 0; i < MAX_FAILED_ATTEMPTS; i++) await unlockOffline("0000", "userA");
    expect((await db.credentials.get("userA"))?.lockedUntil).toBeTruthy();
    expect((await db.credentials.get("userB"))?.lockedUntil ?? null).toBeNull();
  });

  // ── P7: scope soundness ───────────────────────────────────────────────────
  // Validates: Requirements 6.1, 6.2, 6.3
  it("computeScopeCount is never 0 when a congregation is known; counts an Eldership", async () => {
    await db.congregations.bulkPut([
      cong("c1", "Alpha", "eld-1"),
      cong("c2", "Beta", "eld-1"),
      cong("c3", "Gamma", "eld-2"),
    ]);
    expect(await computeScopeCount({ scopeLevel: "Eldership", hierarchyId: "eld-1", congregationId: null })).toBe(2);
    expect(await computeScopeCount({ scopeLevel: "Congregation", hierarchyId: null, congregationId: "c1" })).toBe(1);
    expect(await computeScopeCount({ scopeLevel: "Congregation", hierarchyId: null, congregationId: null })).toBe(0);
  });

  // ── P6: offline identity hydration ────────────────────────────────────────
  // Validates: Requirements 4.1, 4.2, 4.3, 5.1, 6.1
  it("getCurrentIdentity hydrates identity offline and is fail-closed with no session", async () => {
    await db.congregations.put(cong("cong-bos", "Bosmont", "eld-1"));
    await activate("userA", "2222", "Treasurer");
    await persistOfflineUserProfile({
      userId: "userA", email: "treasurer@bosmont.test", role: "Treasurer",
      congregationId: "cong-bos", hierarchyId: "eld-1", scopeLevel: "Congregation",
    });

    const unlock = await unlockOffline("2222", "userA");
    expect(unlock.ok).toBe(true);

    // Now offline: identity must come from the session + cached profile.
    vi.stubGlobal("navigator", { onLine: false });
    const id = await getCurrentIdentity();
    expect(id).not.toBeNull();
    expect(id?.isOnline).toBe(false);
    expect(id?.initials).toBe("TR");
    expect(id?.email).toBe("treasurer@bosmont.test");
    expect(id?.role).toBe("Treasurer");
    expect(id?.congregationName).toBe("Bosmont");
    expect((id?.scopeCount ?? 0)).toBeGreaterThanOrEqual(1);

    // Fail-closed: no session offline -> null (never a populated-but-wrong identity).
    signOut();
    expect(await getCurrentIdentity()).toBeNull();
  });
});
