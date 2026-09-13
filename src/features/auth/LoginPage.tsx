import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { db } from "@/db/schema";
import { getDashboardRoute } from "@/lib/permissions";
import { activateOffline, unlockOffline } from "@/services/authService";
import { autoRefreshReferenceCache } from "@/utils/cacheLoader";
import { useOnlineStatus } from "@/lib/useOnlineStatus";
import { LoginForm, type AuthenticatedContext } from "@/features/auth/LoginForm";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Role } from "@/lib/types";

type Mode = "loading" | "password" | "pin-setup" | "pin-unlock";

const MIN_PIN_LENGTH = 4;

export function LoginPage() {
  const navigate = useNavigate();
  const online = useOnlineStatus();
  const [mode, setMode] = useState<Mode>("loading");
  const [authCtx, setAuthCtx] = useState<AuthenticatedContext | null>(null);

  // Decide the initial mode: offline with a cached credential -> PIN unlock.
  useEffect(() => {
    (async () => {
      const credCount = await db.credentials.count();
      if (!online && credCount > 0) setMode("pin-unlock");
      else setMode("password");
    })();
  }, [online]);

  async function handleAuthenticated(ctx: AuthenticatedContext) {
    // Populate offline reference caches while we have an active online session.
    autoRefreshReferenceCache();
    const existing = await db.credentials.count();
    if (existing > 0) {
      navigate(getDashboardRoute(ctx.role));
      return;
    }
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
            onUnlocked={(role) => navigate(getDashboardRoute(role))}
            onUsePassword={() => setMode("password")}
          />
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
        <Button type="button" variant="outline" onClick={() => onDone(ctx.role)}>
          Skip
        </Button>
      </div>
    </form>
  );
}

// ─── Offline PIN unlock (unlockOffline) ───────────────────────────────────────
function PinUnlock({
  onUnlocked,
  onUsePassword,
}: {
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
    const res = await unlockOffline(pin);
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
