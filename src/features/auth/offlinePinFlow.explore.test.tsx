// @vitest-environment jsdom
// ─────────────────────────────────────────────────────────────────────────────
// BUG-CONDITION EXPLORATION TESTS — offline-pin-flow-fix (bugfix spec, Task 1)
//
// Property 1 (Bug Condition): the per-user offline PIN flow must be correct and
// usable. These tests encode the design's "Exploratory Bug Condition Checking"
// cases and assert the EXPECTED (post-fix) behaviour.
//
//   >>> THEY ARE EXPECTED TO FAIL ON THE CURRENT (UNFIXED) CODE. <<<
//   A failure here is the SUCCESS case: it surfaces the counterexample that
//   proves defects A, B, C, D exist. Do NOT fix the test or the code here.
//
// Root cause (confirmed in committed code): every PinSetup / offline-mode /
// unlock-target decision is driven by a GLOBAL view of the Dexie `credentials`
// store (`db.credentials.count()` / `(await db.credentials.toArray())[0]`)
// instead of the authenticating user's OWN record (`db.credentials.get(userId)`),
// and `AuthenticatedContext` discards `data.user.id`.
//
// Harness notes:
//  - Dexie runs on `fake-indexeddb` (in-memory IndexedDB).
//  - WebCrypto (PBKDF2 + PIN-keyed HMAC) runs unmodified under Node >= 20.
//  - `LoginForm` is stubbed so the online handoff (`onAuthenticated`) can be driven
//    without a live Supabase; crypto / Dexie / orchestration logic are REAL.
//  - `cacheLoader.autoRefreshReferenceCache` is stubbed to a no-op (no network).
//  - A low PBKDF2 iteration count is used purely to keep the suite fast; the crypto
//    primitives themselves (src/services/crypto.ts) are untouched.
//
// Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7
// ─────────────────────────────────────────────────────────────────────────────

import "fake-indexeddb/auto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, act } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";

import { db, type CachedCredential } from "@/db/schema";
import {
  derivePinHash,
  generateSalt,
  computeHmac,
  verifyHmac,
} from "@/services/crypto";
import { unlockOffline } from "@/services/authService";
import type { Role } from "@/lib/types";

// ─── Capture the real orchestration's online handoff via a stubbed LoginForm ──
const hoisted = vi.hoisted(() => ({
  onAuthenticated: { current: null as null | ((ctx: unknown) => void) },
}));

vi.mock("@/features/auth/LoginForm", () => ({
  LoginForm: (props: { onAuthenticated?: (ctx: unknown) => void }) => {
    hoisted.onAuthenticated.current = props.onAuthenticated ?? null;
    return <div data-testid="password-form" />;
  },
}));

// No network during the online handoff.
vi.mock("@/utils/cacheLoader", () => ({
  autoRefreshReferenceCache: () => {},
  refreshReferenceCache: async () => ({ ok: true }),
}));

// Imported AFTER the mocks above so LoginPage picks up the stubbed LoginForm.
import { LoginPage } from "@/features/auth/LoginPage";

// ─── Test identities ──────────────────────────────────────────────────────────
// userB's id sorts BEFORE userA's, so `(await db.credentials.toArray())[0]` is
// userB — this is what makes the identity-blind "first record" defect observable.
const USER_B = "11111111-1111-4111-8111-111111111111"; // sorts first
const USER_A = "22222222-2222-4222-8222-222222222222";

const FAST_ITER = 1000; // speed only; primitives unchanged

// ─── Seed a VALID credential (correct PIN unlocks, HMAC integrity passes) ──────
// Mirrors authService.integrityMessage's canonical field order exactly so the
// seeded HMAC is the one the real unlockOffline will verify.
function integrityMessage(f: {
  pinHash: string;
  salt: string;
  kdfIterations: number;
  role: Role;
  accessStartDate: string;
  accessEndDate: string | null;
  activatedAt: string;
}): string {
  return JSON.stringify([
    f.pinHash,
    f.salt,
    f.kdfIterations,
    f.role,
    f.accessStartDate,
    f.accessEndDate,
    f.activatedAt,
  ]);
}

async function seedCredential(opts: {
  userId: string;
  pin: string;
  role: Role;
  iterations?: number;
}): Promise<CachedCredential> {
  const kdfIterations = opts.iterations ?? FAST_ITER;
  const salt = generateSalt();
  const pinHash = await derivePinHash(opts.pin, salt, kdfIterations);
  const activatedAt = new Date().toISOString();
  const accessStartDate = "2020-01-01T00:00:00.000Z";
  const accessEndDate: string | null = null;
  const hmac = await computeHmac(
    integrityMessage({
      pinHash,
      salt,
      kdfIterations,
      role: opts.role,
      accessStartDate,
      accessEndDate,
      activatedAt,
    }),
    opts.pin,
    salt,
    kdfIterations
  );
  const credential: CachedCredential = {
    userId: opts.userId,
    pinHash,
    salt,
    kdfIterations,
    hmac,
    role: opts.role,
    accessStartDate,
    accessEndDate,
    activatedAt,
    failedAttempts: 0,
    lockedUntil: null,
  };
  await db.credentials.put(credential);
  return credential;
}

// ─── Connectivity control (jsdom) ──────────────────────────────────────────────
function setOnline(value: boolean) {
  Object.defineProperty(window.navigator, "onLine", {
    configurable: true,
    get: () => value,
  });
}

// ─── Render LoginPage inside a router that reveals navigation ──────────────────
function LocationProbe() {
  const loc = useLocation();
  return <div data-testid="navigated-to">{loc.pathname}</div>;
}

function renderLoginPage() {
  return render(
    <MemoryRouter initialEntries={["/"]}>
      <Routes>
        <Route path="/" element={<LoginPage />} />
        <Route path="*" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>
  );
}

// ─── Lifecycle ─────────────────────────────────────────────────────────────────
beforeEach(async () => {
  await db.credentials.clear();
  await db.syncMeta.clear();
  hoisted.onAuthenticated.current = null;
  setOnline(true);
});

afterEach(() => {
  cleanup();
});

describe("Bug condition exploration — offline PIN flow (EXPECTED TO FAIL on unfixed code)", () => {
  // ───────────────────────────────────────────────────────────────────────────
  // Defect D — identity-blind decisions (another user's credential hijacks the flow)
  // ───────────────────────────────────────────────────────────────────────────

  // D-suppress-setup (Req 1.5, 1.7): a credential for userB must NOT suppress
  // userA's PIN setup. Expected post-fix: userA (no own credential) sees pin-setup.
  it("D-suppress-setup: another user's credential must not suppress this user's PIN setup", async () => {
    await seedCredential({ userId: USER_B, pin: "1111", role: "Treasurer" });

    setOnline(true);
    renderLoginPage();
    await screen.findByTestId("password-form");

    // Drive the real handleAuthenticated for userA (who has NO credential).
    expect(hoisted.onAuthenticated.current).not.toBeNull();
    await act(async () => {
      await hoisted.onAuthenticated.current!({
        userId: USER_A,
        email: "treasurer@bosmont.test",
        password: "pw",
        role: "Treasurer",
        turnstileToken: null,
      });
    });

    // EXPECTED (post-fix): PIN setup is offered to userA.
    // UNFIXED: global count() > 0 -> routes straight to the dashboard (fails here).
    await screen.findByText(/Set an offline PIN/i);
    expect(screen.queryByTestId("navigated-to")).toBeNull();
  });

  // D-wrong-unlock (Req 2.4, 2.7): unlockOffline must target the RESOLVED user, not
  // an arbitrary first record. Per the approved design the caller passes an explicit
  // userId, so `unlockOffline(pin, USER_A)` must validate against userA even though
  // userB sorts first in the store. REAL exported unlockOffline is exercised here.
  it("D-wrong-unlock: unlock must target the intended user, not toArray()[0]", async () => {
    await seedCredential({ userId: USER_B, pin: "1111", role: "Treasurer" });
    await seedCredential({ userId: USER_A, pin: "2222", role: "Elder" });

    // Precondition that makes the defect observable: userB is the first record.
    const first = (await db.credentials.toArray())[0];
    expect(first.userId).toBe(USER_B);

    // Target userA explicitly with userA's correct PIN (design: unlockOffline(pin, userId)).
    const res = await unlockOffline("2222", USER_A);

    // Design behaviour: resolves to userA and unlocks — NOT toArray()[0] (userB).
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.session.userId).toBe(USER_A);
      expect(res.session.role).toBe("Elder");
    }
  });

  // D-offline-prompt (Req 1.6): offline with only another user's credential must
  // NOT present a PIN prompt bound to that other user. Expected post-fix:
  // the online-required screen (no PIN input).
  it("D-offline-prompt: offline with only another user's credential must not prompt a PIN", async () => {
    await seedCredential({ userId: USER_B, pin: "1111", role: "Treasurer" });

    setOnline(false);
    renderLoginPage();

    // Wait for the initial-mode effect to settle (leaves the loading screen).
    await waitFor(() => {
      expect(screen.queryByText(/Loading/i)).toBeNull();
    });

    // EXPECTED (post-fix): no PIN-unlock prompt is shown for userA.
    // UNFIXED: global count() > 0 && offline -> pin-unlock against userB (fails here).
    expect(screen.queryByText(/Enter your PIN to unlock/i)).toBeNull();
    expect(screen.queryByLabelText(/^PIN$/i)).toBeNull();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Defect A — Skip persists no credential -> later offline dead-end
  // ───────────────────────────────────────────────────────────────────────────

  // A-skip (Req 2.1): per the approved design, confirmed-Skip persists NO credential
  // and sets no "setup complete" flag; the offline dead-end is avoided because offline
  // mode selection then resolves to `online-required` (never a stray PIN prompt or an
  // unusable password form). Assert exactly that: after Skip no credential exists for
  // userA, and resolving the offline initial mode yields the online-required screen.
  it("A-skip: confirmed Skip persists no credential and offline resolves to online-required", async () => {
    // jsdom does not implement window.confirm; the confirmed-Skip path is confirm-gated.
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

    setOnline(true);
    renderLoginPage();
    await screen.findByTestId("password-form");

    // userA logs in for the first time; no credential exists for anyone.
    await act(async () => {
      await hoisted.onAuthenticated.current!({
        userId: USER_A,
        email: "treasurer@bosmont.test",
        password: "pw",
        role: "Treasurer",
        turnstileToken: null,
      });
    });

    // Setup screen is offered (no credential anywhere) — press "Skip" and confirm.
    const skip = await screen.findByRole("button", { name: /Skip/i });
    await act(async () => {
      skip.click();
    });
    expect(confirmSpy).toHaveBeenCalled();

    // Design behaviour: the confirmed-Skip path persists NO credential for userA.
    const cred = await db.credentials.get(USER_A);
    expect(cred).toBeUndefined();

    // And resolving the offline initial mode yields online-required (no PIN prompt),
    // so the skipped setup cannot dead-end the user.
    cleanup();
    setOnline(false);
    renderLoginPage();
    await waitFor(() => {
      expect(screen.queryByText(/Loading/i)).toBeNull();
    });
    await screen.findByText(/Offline access not set up/i);
    expect(screen.queryByText(/Enter your PIN to unlock/i)).toBeNull();
    expect(screen.queryByLabelText(/^PIN$/i)).toBeNull();

    confirmSpy.mockRestore();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Defect B — offline + empty store dead-ends on an unusable password form
  // ───────────────────────────────────────────────────────────────────────────

  // B-offline-deadend (Req 1.2): offline with nothing cached must show an explicit
  // online-required screen, never the password form (which cannot authenticate
  // offline). Expected post-fix: online-required; password form absent.
  it("B-offline-deadend: offline with an empty store must not render the password form", async () => {
    setOnline(false);
    renderLoginPage();

    await waitFor(() => {
      expect(screen.queryByText(/Loading/i)).toBeNull();
    });

    // EXPECTED (post-fix): online-required screen, not the unusable password form.
    // UNFIXED: (!online && count === 0) -> renders the password form (fails here).
    expect(screen.queryByTestId("password-form")).toBeNull();
  });

  // ───────────────────────────────────────────────────────────────────────────
  // Defect C — existing credential never refreshed on online login
  // ───────────────────────────────────────────────────────────────────────────

  // C-no-refresh (Req 2.3): online login with an existing credential uses STAGED
  // refresh (rebind-at-unlock). A password-only login has no raw PIN, so it cannot
  // re-sign the PIN-keyed HMAC; per the approved design it stages the fresh role into
  // `pendingRole` and leaves the HMAC-protected `role` (and the `hmac`) UNCHANGED. The
  // committed role is updated only at the NEXT offline unlock, when the entered PIN
  // re-binds the HMAC over the new protected set.
  it("C-no-refresh: online login stages the fresh role, committed at next unlock", async () => {
    // Stale cached role is Treasurer; the server now says Elder.
    const seeded = await seedCredential({ userId: USER_A, pin: "2222", role: "Treasurer" });

    setOnline(true);
    renderLoginPage();
    await screen.findByTestId("password-form");

    await act(async () => {
      await hoisted.onAuthenticated.current!({
        userId: USER_A,
        email: "treasurer@bosmont.test",
        password: "pw",
        role: "Elder", // new server-derived role
        turnstileToken: null,
      });
    });

    // Immediately after login: the fresh role is STAGED, but the HMAC-protected set and
    // the stored HMAC are untouched (the existing PIN binding stays valid).
    const afterLogin = await db.credentials.get(USER_A);
    expect(afterLogin?.pendingRole).toBe("Elder");
    expect(afterLogin?.role).toBe("Treasurer");
    expect(afterLogin?.hmac).toBe(seeded.hmac);

    // Next offline unlock with the correct PIN commits the staged refresh (rebind).
    const res = await unlockOffline("2222", USER_A);
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.session.role).toBe("Elder");
    }

    // The committed role is now Elder and the recomputed HMAC verifies against the NEW
    // protected set under the entered PIN.
    const afterUnlock = await db.credentials.get(USER_A);
    expect(afterUnlock?.role).toBe("Elder");
    expect(afterUnlock?.pendingRole ?? null).toBeNull();
    const integrityOk = await verifyHmac(
      integrityMessage(afterUnlock!),
      afterUnlock!.hmac,
      "2222",
      afterUnlock!.salt,
      afterUnlock!.kdfIterations
    );
    expect(integrityOk).toBe(true);
  });
});
