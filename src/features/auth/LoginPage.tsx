import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { db, type OfflineUserProfile } from "@/db/schema";
import { getDashboardRoute } from "@/lib/permissions";
import {
  activateOffline,
  unlockOffline,
  persistOfflineUserProfile,
  getOfflineUsers,
} from "@/services/authService";
import { autoRefreshReferenceCache } from "@/utils/cacheLoader";
import { getCurrentIdentity, type CurrentIdentity } from "@/lib/identity";
import { isOfflinePinDismissed, setOfflinePinDismissed } from "@/lib/deviceId";
import { useOnlineStatus } from "@/lib/useOnlineStatus";
import { LoginForm, type AuthenticatedContext } from "@/features/auth/LoginForm";
import { AccountPicker } from "@/features/auth/AccountPicker";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Role } from "@/lib/types";

type Mode = "loading" | "password" | "pin-setup" | "pin-unlock" | "account-picker";

const MIN_PIN_LENGTH = 4;

export function LoginPage() {
  const navigate = useNavigate();
  const online = useOnlineStatus();
  const [mode, setMode] = useState<Mode>("loading");
  const [authCtx, setAuthCtx] = useState<AuthenticatedContext | null>(null);
  const [offlineUsers, setOfflineUsers] = useState<OfflineUserProfile[]>([]);
  const [unlockUserId, setUnlockUserId] = useState<string | undefined>(undefined);

  // Decide the initial mode. Offline: resolve the offline users with a usable
  // credential and partition 0 -> password, 1 -> pin-unlock, >1 -> account-picker.
  useEffect(() => {
    (async () => {
      if (online) {
        setMode("password");
        return;
      }
      const users = await getOfflineUsers();
      setOfflineUsers(users);
      if (users.length === 0) {
        setMode("password");
      } else if (users.length === 1) {
        setUnlockUserId(users[0].userId);
        setMode("pin-unlock");
      } else {
        setMode("account-picker");
      }
    })();
  }, [online]);

  async function handleAuthenticated(ctx: AuthenticatedContext) {
    // Populate offline reference caches while we have an active online session.
    autoRefreshReferenceCache();
    // Persist a fresh non-secret offline profile (whether or not a PIN is set now),
    // so the AccountPicker can list this user. Non-fatal.
    try {
      await persistOfflineUserProfile({
        userId: ctx.userId,
        email: ctx.email,
        role: ctx.role,
        congregationId: ctx.congregationId,
        hierarchyId: ctx.hierarchyId,
        scopeLevel: ctx.scopeLevel,
      });
    } catch {
      // Non-blocking: login proceeds even if the profile cache write fails.
    }
    const existing = await db.credentials.get(ctx.userId);
    if (existing) {
      navigate(getDashboardRoute(ctx.role));
      return;
    }
    // Respect a per-device "Don't ask again" dismissal: don't nag on every sign-in.
    if (isOfflinePinDismissed(ctx.userId)) {
      navigate(getDashboardRoute(ctx.role));
      return;
    }
    setAuthCtx(ctx);
    setMode("pin-setup");
  }

  // Remove a user's offline access from this device (Offline PIN: Remove).
  async function handleRemoveOfflineUser(userId: string) {
    await db.credentials.delete(userId);
    await db.offlineUsers.delete(userId);
    const users = await getOfflineUsers();
    setOfflineUsers(users);
    if (users.length === 0) setMode("password");
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
        {mode === "account-picker" && (
          <AccountPicker
            users={offlineUsers}
            onSelect={(id) => {
              setUnlockUserId(id);
              setMode("pin-unlock");
            }}
            onUsePassword={() => setMode("password")}
            onRemove={handleRemoveOfflineUser}
          />
        )}
        {mode === "pin-unlock" && (
          <PinUnlock
            userId={unlockUserId}
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
  const [dontAsk, setDontAsk] = useState(false);
  const [who, setWho] = useState<CurrentIdentity | null>(null);

  // Resolve the signed-in user's display context (name + congregation + number)
  // for the modal header. Stays in the current online session — no re-login.
  useEffect(() => {
    getCurrentIdentity()
      .then(setWho)
      .catch(() => setWho(null));
  }, []);

  // Skip = "Remind me later" (no flag). With the checkbox ticked, persist the
  // per-device dismissal so this user is not prompted again on this device.
  function handleSkip() {
    if (dontAsk) setOfflinePinDismissed(ctx.userId, true);
    onDone(ctx.role);
  }

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
      <div className="rounded-md border bg-muted/40 p-2 text-xs">
        <p className="font-medium">
          Setting offline PIN for: {who?.displayName ?? ctx.email} ({who?.email ?? ctx.email})
        </p>
        {who?.congregationName && (
          <p className="text-muted-foreground">
            {who.congregationName}
            {who.congregationNumber ? ` (No: ${who.congregationNumber})` : ""}
            {who.overseershipName ? ` — Overseership: ${who.overseershipName}` : ""}
          </p>
        )}
      </div>
      <p className="text-sm text-muted-foreground">
        Set an offline PIN so you can capture without a connection.
      </p>
      <div className="space-y-2">
        <Label htmlFor="pin-email">Email</Label>
        <Input id="pin-email" type="email" value={who?.email ?? ctx.email} disabled />
      </div>
      <div className="space-y-2">
        <Label htmlFor="pin">New PIN</Label>
        <Input id="pin" type="password" inputMode="numeric" autoComplete="new-password" value={pin} onChange={(e) => setPin(e.target.value)} />
      </div>
      <div className="space-y-2">
        <Label htmlFor="pin-confirm">Confirm PIN</Label>
        <Input id="pin-confirm" type="password" inputMode="numeric" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
      </div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <input
          type="checkbox"
          checked={dontAsk}
          onChange={(e) => setDontAsk(e.target.checked)}
        />
        Don&apos;t ask again for this device
      </label>
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
  userId?: string;
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
    const res = await unlockOffline(pin, userId);
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
