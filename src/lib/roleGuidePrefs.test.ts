// PRIORITY 3 — role-guide dismissal persistence + the pure auto-show decision. The
// guide is never a compulsory pop-up: session dismiss and "Don't show again" each
// suppress auto-show, and the pure decision reflects exactly that. An in-memory store
// stands in for Web Storage (the vitest env is `node`).
import { describe, it, expect, beforeEach } from "vitest";
import {
  isRoleGuideDontShow,
  setRoleGuideDontShow,
  isRoleGuideSessionDismissed,
  setRoleGuideSessionDismissed,
  shouldAutoShowGuide,
  type StorageLike,
} from "@/lib/roleGuidePrefs";

const USER = "user-123";

function memStorage(): StorageLike {
  const m = new Map<string, string>();
  return {
    getItem: (k) => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k, v) => void m.set(k, v),
    removeItem: (k) => void m.delete(k),
  };
}

describe("shouldAutoShowGuide (pure decision)", () => {
  it("shows only when neither dismissal is set", () => {
    expect(shouldAutoShowGuide({ dontShowAgain: false, sessionDismissed: false })).toBe(true);
  });
  it("suppresses when dismissed for the session", () => {
    expect(shouldAutoShowGuide({ dontShowAgain: false, sessionDismissed: true })).toBe(false);
  });
  it("suppresses when 'Don't show again' is persisted", () => {
    expect(shouldAutoShowGuide({ dontShowAgain: true, sessionDismissed: false })).toBe(false);
  });
  it("suppresses when both are set", () => {
    expect(shouldAutoShowGuide({ dontShowAgain: true, sessionDismissed: true })).toBe(false);
  });
});

describe("don't-show-again persistence", () => {
  let store: StorageLike;
  beforeEach(() => {
    store = memStorage();
  });

  it("defaults to not dismissed", () => {
    expect(isRoleGuideDontShow(USER, store)).toBe(false);
  });
  it("persists and clears per user", () => {
    setRoleGuideDontShow(USER, true, store);
    expect(isRoleGuideDontShow(USER, store)).toBe(true);
    expect(isRoleGuideDontShow("other-user", store)).toBe(false);
    setRoleGuideDontShow(USER, false, store);
    expect(isRoleGuideDontShow(USER, store)).toBe(false);
  });
  it("is inert for an empty user id", () => {
    setRoleGuideDontShow("", true, store);
    expect(isRoleGuideDontShow("", store)).toBe(false);
  });
});

describe("session dismissal", () => {
  let store: StorageLike;
  beforeEach(() => {
    store = memStorage();
  });

  it("defaults to not dismissed and sets per user", () => {
    expect(isRoleGuideSessionDismissed(USER, store)).toBe(false);
    setRoleGuideSessionDismissed(USER, store);
    expect(isRoleGuideSessionDismissed(USER, store)).toBe(true);
    expect(isRoleGuideSessionDismissed("other-user", store)).toBe(false);
  });
});
