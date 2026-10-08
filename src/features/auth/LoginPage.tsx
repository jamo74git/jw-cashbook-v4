import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { db } from "@/db/schema";
import { getDashboardRoute } from "@/lib/permissions";
import { activateOffline, stageCredentialRefresh, unlockOffline } from "@/services/authService";
import { autoRefreshReferenceCache } from "@/utils/cacheLoader";
import { useOnlineStatus } from "@/lib/useOnlineStatus";
import { LoginForm, type AuthenticatedContext } from "@/features/auth/LoginForm";
import { OnlineRequired } from "@/features/auth/OnlineRequired";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Role } from "@/lib/types";

type Mode = "loading" | "password" | "pin-setup" | "pin-unlock" | "online-required";

const MIN_PIN_LENGTH = 4;

export function LoginPage() {
  const navigate = useNavigate();
  const online = useOnlineStatus();
  const [mode, setMode] = useState<Mode>("loading");
  const [authCtx, setAuthCtx] = useState<AuthenticatedContext | null>(null);
  // Resolved target user for an offline PIN unlock (P1-E: unlock the relevant user's
  // own credential, never the first/arbitrary record).
  const [unlockUserId, setUnlockUserId] = useState<string | null>(null);

  // Initial-mode effect. Keyed on `online` and re-runs on every connectivity flip so a
  // transient `navigator.onLine` value cannot permanently strand the user — when
  // connectivity changes the mode is re-resolved. Fail-closed throughout: offline with
  // no credential for the relevant user resolves to `online-required`, never a stray PIN
  // prompt or an unusable password form.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // Online always starts at the password form.
      if (online) {
        if (!cancelled) {
          setUnlockUserId(null);
          setMode("password");
        }
        return;
      }
      // Offline: resolve the relevant user via the pointer, then gate on real per-user
      // credential existence. A null pointer, a missing credential, or any read error
      // ⇒ `online-required` (fail-closed).
      try {
        const meta = await db.syncMeta.get("global");
        const uid = meta?.lastActiveUserId ?? null;
        const cred = uid ? await db.credentials.get(uid) : undefined;
        if (cancelled) return;
        if (uid && cred) {
          setUnlockUserId(uid);
          setMode("pin-unlock");
        } else {
          setUnlockUserId(null);
          setMode("online-required");
        }
      } catch {
        if (cancelled) return;
        setUnlockUserId(null);
        setMode("online-required");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [online]);

  async function handleAuthenticated(ctx: AuthenticatedContext) {
    // Populate offline reference caches while we have an active online session.
    autoRefreshReferenceCache();

    // PER-USER decision (never a global count): does THIS user already have a credential?
    const existing = await db.credentials.get(ctx.userId);
    if (existing) {
      // Defect C / P1-C: stage the fresh server-derived role/access window from this
      // login. staging leaves the HMAC-protected set (and `hmac`) untouched so the PIN
      // binding stays valid; it is committed at the next offline unlock. The current
      // session routes immediately with the FRESH role.
      await stageCredentialRefresh(ctx.userId, {
        role: ctx.role,
        accessStartDate: ctx.accessStartDate ?? existing.accessStartDate,
        accessEndDate: ctx.accessEndDate,
      });
      navigate(getDashboardRoute(ctx.role));
      return;
    }

    // Defect D / P1-D: no credential for THIS user — offer PIN setup even when other
    // users' credentials exist on the device.
    setAuthCtx(ctx);
    setMode("pin-setup");
  }

  if (mode === "loading") {
    return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-6">
      <div className="w-full max-w-sm space-y-4">
        <div className="text-center space-y-1">
          <img src="/nac-logo.png" alt="NAC" width={40} height={40} className="mx-auto rounded" />
          <h1 className="text-lg font-bold">OAC Cashbook</h1>
        </div>

        {mode === "password" && <LoginForm onAuthenticated={handleAuthenticated} />}
        {mode === "pin-setup" && authCtx && (
          <PinSetup ctx={authCtx} onDone={(role) => navigate(getDashboardRoute(role))} />
        )}
        {mode === "pin-unlock" && (
          <PinUnlock
            userId={unlockUserId}
            onUnlocked={(role) => navigate(getDashboardRoute(role))}
            onUsePassword={() => setMode("password")}
          />
        )}
        {mode === "online-required" && (
          <OnlineRequired onUsePassword={() => setMode("password")} />
        )}
      </div>
    </div>
  );
}

// ─── Offline PIN setup (activateOffline) ──────────────────────────────────────
function PinSetup({ ctx, onDone }: { ctx: AuthenticatedContext; onDone: (role: Role) => void }) {
  const [pin, setPin] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (pin.length < MIN_PIN_LENGTH) {
      setError(`PIN must be at least ${MIN_PIN_LENGTH} digits.`);
      return;
    }
    if (pin !== confirm) {
      setError("PINs do not match.");
      return;
    }
    setBusy(true);
    const res = await activateOffline({
      email: ctx.email,
      password: ctx.password,
      pin,
      turnstileToken: ctx.turnstileToken ?? undefined,
    });
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    onDone(res.credential.role);
  }

  // Confirmed-Skip (defect A / P1-A): require an explicit confirmation that offline
  // capture is unavailable until a PIN is set. On confirm we only navigate — NO
  // credential is persisted and NO "setup complete" flag is set. Because offline mode
  // selection now gates on real per-user credential existence, a skipped setup resolves
  // offline to `online-required`, so no offline dead-end is reachable.
  function handleSkip() {
    const confirmed = window.confirm(
      "Offline capture will be unavailable until you set a PIN. Continue?"
    );
    if (confirmed) onDone(ctx.role);
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Set an offline PIN so you can capture without a connection.
      </p>
      <div className="space-y-2">
        <Label htmlFor="pin">New PIN</Label>
        <Input id="pin" type="password" inputMode="numeric" autoComplete="new-password" value={pin} onChange={(e) => setPin(e.target.value)} />
      </div>
      <div className="space-y-2">
        <Label htmlFor="pin-confirm">Confirm PIN</Label>
        <Input id="pin-confirm" type="password" inputMode="numeric" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
      </div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <div className="flex gap-2">
        <Button type="submit" className="flex-1" disabled={busy}>
          {busy ? "Saving…" : "Set PIN"}
        </Button>
        <Button type="button" variant="outline" onClick={handleSkip}>
          Skip
        </Button>
      </div>
    </form>
  );
}

// ─── Offline PIN unlock (unlockOffline) ───────────────────────────────────────
function PinUnlock({
  userId,
  onUnlocked,
  onUsePassword,
}: {
  userId: string | null;
  onUnlocked: (role: Role) => void;
  onUsePassword: () => void;
}) {
  const [pin, setPin] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    // Target the resolved relevant user's own credential (P1-E). `userId` is non-null
    // whenever this screen is reached via the fail-closed initial-mode effect.
    const res = await unlockOffline(pin, userId ?? undefined);
    setBusy(false);
    if (res.ok) {
      onUnlocked(res.session.role);
      return;
    }
    const suffix = res.remainingAttempts !== undefined ? ` (${res.remainingAttempts} left)` : "";
    setError(res.message + suffix);
  }

  return (
    <form onSubmit={submit} className="space-y-3">
      <p className="text-sm text-muted-foreground">Enter your PIN to unlock offline capture.</p>
      <div className="space-y-2">
        <Label htmlFor="unlock-pin">PIN</Label>
        <Input id="unlock-pin" type="password" inputMode="numeric" autoComplete="current-password" value={pin} onChange={(e) => setPin(e.target.value)} autoFocus />
      </div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <Button type="submit" className="w-full" disabled={busy}>
        {busy ? "Unlocking…" : "Unlock"}
      </Button>
      <Button type="button" variant="ghost" className="w-full text-xs" onClick={onUsePassword}>
        Sign in with password instead
      </Button>
    </form>
  );
}
