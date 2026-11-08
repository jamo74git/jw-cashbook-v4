// ─────────────────────────────────────────────────────────────────────────────
// ROLE GUIDE DISMISSAL PREFERENCES (PRIORITY 3)
// Two independent, per-user dismissals so the "What you can do here" card is NEVER a
// compulsory pop-up:
//   • session dismiss      — this browser session only (sessionStorage)
//   • "Don't show again"   — persisted across sessions (localStorage)
// The card is always re-openable via Help regardless of either flag. Storage access is
// guarded for non-browser (test/SSR) environments and private-mode failures, mirroring
// deviceId.ts; an in-memory store may be injected for tests. The auto-show decision
// itself (shouldAutoShowGuide) is pure.
// ─────────────────────────────────────────────────────────────────────────────

export const ROLE_GUIDE_DONT_SHOW_PREFIX = "oac_role_guide_dont_show_";
export const ROLE_GUIDE_SESSION_PREFIX = "oac_role_guide_session_dismissed_";

// Window event that re-opens the guide from the Help entry point. Dispatched by the
// header's Help control; listened for by the global RoleGuideHost.
export const ROLE_GUIDE_OPEN_EVENT = "oac:open-role-guide";

/** The slice of the Web Storage API these helpers use. */
export type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function resolveStorage(kind: "local" | "session", injected?: StorageLike): StorageLike | null {
  if (injected) return injected;
  try {
    const s = kind === "local" ? localStorage : sessionStorage;
    return typeof s === "undefined" ? null : s;
  } catch {
    return null;
  }
}

/** True when this user has chosen "Don't show again" (persisted across sessions). */
export function isRoleGuideDontShow(userId: string, storage?: StorageLike): boolean {
  if (!userId) return false;
  const s = resolveStorage("local", storage);
  try {
    return s?.getItem(ROLE_GUIDE_DONT_SHOW_PREFIX + userId) === "1";
  } catch {
    return false;
  }
}

/** Set/clear the persisted "Don't show again" flag for this user. */
export function setRoleGuideDontShow(userId: string, value: boolean, storage?: StorageLike): void {
  if (!userId) return;
  const s = resolveStorage("local", storage);
  if (!s) return;
  try {
    const key = ROLE_GUIDE_DONT_SHOW_PREFIX + userId;
    if (value) s.setItem(key, "1");
    else s.removeItem(key);
  } catch {
    // Storage unavailable (private mode / quota) — treat as not persisted.
  }
}

/** True when this user dismissed the guide for the current browser session. */
export function isRoleGuideSessionDismissed(userId: string, storage?: StorageLike): boolean {
  if (!userId) return false;
  const s = resolveStorage("session", storage);
  try {
    return s?.getItem(ROLE_GUIDE_SESSION_PREFIX + userId) === "1";
  } catch {
    return false;
  }
}

/** Mark the guide dismissed for this browser session (cleared on a new session). */
export function setRoleGuideSessionDismissed(userId: string, storage?: StorageLike): void {
  if (!userId) return;
  const s = resolveStorage("session", storage);
  if (!s) return;
  try {
    s.setItem(ROLE_GUIDE_SESSION_PREFIX + userId, "1");
  } catch {
    // Storage unavailable — the guide simply may re-appear; never blocks.
  }
}

/**
 * Pure auto-show decision. The guide auto-appears after sign-in ONLY when the user has
 * neither persisted "Don't show again" nor dismissed it for this session. Help can
 * always re-open it regardless of this result.
 */
export function shouldAutoShowGuide(state: {
  dontShowAgain: boolean;
  sessionDismissed: boolean;
}): boolean {
  return !state.dontShowAgain && !state.sessionDismissed;
}
