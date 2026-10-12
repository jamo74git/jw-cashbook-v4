"use client";

import { useEffect, useState, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { createClient } from "@/lib/supabase/client";
import { getCurrentIdentity, type CurrentIdentity } from "@/lib/identity";
import { resolveHierarchyChain, type ChainSegment } from "@/lib/hierarchyChain";
import { setOfflinePinDismissed } from "@/lib/deviceId";
import {
  signOut as clearOfflineSession,
  hasPin,
  removePin,
  activateOffline,
} from "@/services/authService";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

export function AppHeader() {
  const supabase = createClient();
  const navigate = useNavigate();
  const [identity, setIdentity] = useState<CurrentIdentity | null>(null);
  const [chain, setChain] = useState<ChainSegment[]>([]);
  const [districtName, setDistrictName] = useState("");
  const [userHasPin, setUserHasPin] = useState(false);
  const [pinModal, setPinModal] = useState<null | "set" | "change">(null);
  const [pinToast, setPinToast] = useState<string | null>(null);
  const [showMenu, setShowMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    (async () => {
      // Online AND offline-aware; fail-closed null -> render nothing.
      const id = await getCurrentIdentity();
      if (!id) return;
      setIdentity(id);

      // Whether this user already has an offline PIN on this device (drives the
      // Settings-menu label: Set vs Change/Remove).
      setUserHasPin(await hasPin(id.userId));

      // Full canonical breadcrumb for ALL roles (cache-first, graceful fallback).
      const segs = await resolveHierarchyChain({
        congregationId: id.congregationId,
        hierarchyId: id.hierarchyId,
        scopeLevel: id.scopeLevel,
        congregationName: id.congregationName,
      });
      setChain(segs);

      // HO district-name display stays online-only (admin is online-only).
      if (id.role === "HO" && id.isOnline) {
        const {
          data: { user },
        } = await supabase.auth.getUser();
        const { data: assignments } = await supabase
          .from("ho_district_assignments")
          .select("district_id")
          .eq("user_id", user?.id ?? "");
        if (assignments && assignments.length > 0) {
          const { data: district } = await supabase
            .from("hierarchy_levels")
            .select("name")
            .eq("id", assignments[0].district_id)
            .single();
          if (district) setDistrictName(district.name);
        }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Close dropdown on click outside
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setShowMenu(false);
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  // Auto-dismiss the lightweight PIN toast (matches the app-wide banner pattern).
  useEffect(() => {
    if (!pinToast) return;
    const t = setTimeout(() => setPinToast(null), 3000);
    return () => clearTimeout(t);
  }, [pinToast]);

  async function handleSignOut() {
    clearOfflineSession();
    await supabase.auth.signOut();
    navigate("/login");
  }

  // Enable / Change open the INLINE PIN modal in dashboard context (no /login
  // redirect, no signOut). The modal collects the current password + new PIN and
  // calls activateOffline directly, keeping the Supabase session active.
  function handleEnablePin() {
    setShowMenu(false);
    setPinModal("set");
  }
  function handleChangePin() {
    setShowMenu(false);
    setPinModal("change");
  }
  async function handleRemovePin() {
    setShowMenu(false);
    if (!identity?.userId) return;
    await removePin(identity.userId);
    setOfflinePinDismissed(identity.userId, true);
    setUserHasPin(false);
    setPinToast(`Offline PIN removed for ${identity.email}`);
  }

  const displayName = identity?.displayName ?? "";
  const initials = identity?.initials ?? displayName.slice(0, 2).toUpperCase();
  // Canonical breadcrumb retained as the fallback for non-congregation scopes
  // (Overseer / Apostle / District).
  const breadcrumb = chain.map((s) => s.name).join(" | ");
  const scopeCount = identity?.scopeCount ?? 0;
  // Concise congregation identity: "Bosmont (No: 123) — Overseership: Beukes".
  // Pieces that don't resolve (number/overseership) are omitted gracefully.
  const congLine = identity?.congregationName
    ? `${identity.congregationName}${
        identity.congregationNumber ? ` (No: ${identity.congregationNumber})` : ""
      }${identity.overseershipName ? ` — Overseership: ${identity.overseershipName}` : ""}`
    : "";

  return (
    <header className="sticky top-0 z-50 border-b bg-background shadow-sm">
      <div className="flex h-12 items-center justify-between px-3 max-w-[1600px] mx-auto">
        {/* Left: Logo */}
        <div className="flex items-center gap-3">
          <img src="/nac-logo.png" alt="NAC" width={28} height={28} className="rounded" />
          <span className="text-sm font-semibold text-primary hidden sm:inline">OAC Management System</span>
        </div>

        {/* Right: Single banner line + avatar */}
        <div className="flex items-center gap-3 text-xs" ref={menuRef}>
          <div className="hidden md:flex items-center gap-2 min-w-0">
            <span className="font-medium">{displayName}</span>
            <span className="text-muted-foreground">|</span>
            <span>Role: <b>{identity?.role}</b></span>
            <span className="text-muted-foreground">|</span>
            {identity?.congregationId && congLine ? (
              <span className="truncate max-w-[640px]" title={congLine}>
                {congLine}
                {scopeCount > 1 && (
                  <span className="text-muted-foreground"> · current of {scopeCount}</span>
                )}
              </span>
            ) : identity?.role === "HO" && districtName ? (
              <span>District: <b>{districtName}</b></span>
            ) : breadcrumb ? (
              <span className="truncate max-w-[640px]" title={breadcrumb}>{breadcrumb}</span>
            ) : (
              <span>
                Scope: <b>{scopeCount} Congregation{scopeCount !== 1 ? "s" : ""}</b>
              </span>
            )}
          </div>
          {identity && <Badge variant="secondary" className="text-[10px] md:hidden">{identity.role}</Badge>}

          {/* Avatar dropdown */}
          <div className="relative">
            <button onClick={() => setShowMenu(!showMenu)} className="flex h-7 w-7 items-center justify-center rounded-full bg-primary text-primary-foreground text-[10px] font-bold hover:bg-primary/90">
              {initials}
            </button>
            {showMenu && (
              <div className="absolute right-0 top-9 z-50 min-w-40 rounded-md border bg-background p-1 shadow-lg">
                <div className="px-3 py-2 border-b text-xs">
                  <p className="font-medium">{identity?.email || displayName}</p>
                  <p className="text-muted-foreground">{identity?.role} · {identity?.scopeLevel}</p>
                </div>
                <button onClick={() => { setShowMenu(false); navigate("/settings"); }} className="w-full text-left px-3 py-2 text-sm rounded-sm hover:bg-muted">
                  Settings
                </button>
                {identity?.isOnline &&
                  (userHasPin ? (
                    <div className="border-t">
                      <p className="px-3 pt-2 pb-1 text-[11px] font-medium text-muted-foreground">
                        Offline PIN
                      </p>
                      <button
                        onClick={handleChangePin}
                        className="w-full text-left px-3 py-2 text-sm rounded-sm hover:bg-muted"
                      >
                        Change
                      </button>
                      <button
                        onClick={handleRemovePin}
                        className="w-full text-left px-3 py-2 text-sm rounded-sm hover:bg-muted text-destructive"
                      >
                        Remove
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={handleEnablePin}
                      className="w-full text-left px-3 py-2 text-sm rounded-sm hover:bg-muted"
                    >
                      Enable offline mode (Set PIN)
                    </button>
                  ))}
                <button onClick={handleSignOut} className="w-full text-left px-3 py-2 text-sm rounded-sm hover:bg-muted text-destructive">
                  Sign Out
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {pinToast && (
        <div
          className="fixed top-16 left-1/2 -translate-x-1/2 z-50 bg-primary text-primary-foreground px-4 py-2 rounded-md text-xs shadow-lg"
          role="status"
        >
          {pinToast}
        </div>
      )}

      {pinModal && identity && (
        <EnablePinModal
          email={identity.email}
          mode={pinModal}
          onClose={() => setPinModal(null)}
          onSuccess={() => {
            const m = pinModal;
            setPinModal(null);
            setUserHasPin(true);
            if (identity.userId) setOfflinePinDismissed(identity.userId, false);
            setPinToast(
              `Offline PIN ${m === "change" ? "updated" : "enabled"} for ${identity.email}`
            );
          }}
        />
      )}
    </header>
  );
}

const MIN_PIN_LENGTH = 4;

// Inline offline-PIN setup/change modal shown IN the dashboard (not the login page).
// It confirms the signed-in user's current password and a new PIN, then calls
// activateOffline directly — the Supabase session is preserved (no signOut, no
// redirect to the generic login form). Context is sourced from getCurrentIdentity().
function EnablePinModal({
  email,
  mode,
  onClose,
  onSuccess,
}: {
  email: string;
  mode: "set" | "change";
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [who, setWho] = useState<CurrentIdentity | null>(null);
  const [password, setPassword] = useState("");
  const [pin, setPin] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getCurrentIdentity()
      .then(setWho)
      .catch(() => setWho(null));
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!password) {
      setError("Enter your current password to confirm.");
      return;
    }
    if (pin.length < MIN_PIN_LENGTH) {
      setError(`PIN must be at least ${MIN_PIN_LENGTH} digits.`);
      return;
    }
    if (pin !== confirm) {
      setError("PINs do not match.");
      return;
    }
    setBusy(true);
    const res = await activateOffline({ email, password, pin });
    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    onSuccess();
  }

  const congLine = who?.congregationName
    ? `${who.congregationName}${who.congregationNumber ? ` (No: ${who.congregationNumber})` : ""}${
        who.overseershipName ? ` — Overseership: ${who.overseershipName}` : ""
      }`
    : "";

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="enable-pin-title"
    >
      <form
        onSubmit={submit}
        className="w-full max-w-sm space-y-3 rounded-md border bg-background p-4 shadow-lg"
      >
        <h2 id="enable-pin-title" className="text-sm font-semibold">
          {mode === "change" ? "Change offline PIN" : "Enable offline mode"}
        </h2>

        <div className="rounded-md border bg-muted/40 p-2 text-xs">
          <p className="font-medium">
            Setting offline PIN for: {who?.displayName ?? email} ({email})
          </p>
          {congLine && <p className="text-muted-foreground">{congLine}</p>}
        </div>

        <div className="space-y-2">
          <Label htmlFor="enable-pin-email">Email</Label>
          <Input id="enable-pin-email" type="email" value={email} disabled />
        </div>
        <div className="space-y-2">
          <Label htmlFor="enable-pin-password">Confirm current password</Label>
          <Input
            id="enable-pin-password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoFocus
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="enable-pin-new">New PIN</Label>
          <Input
            id="enable-pin-new"
            type="password"
            inputMode="numeric"
            autoComplete="new-password"
            value={pin}
            onChange={(e) => setPin(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="enable-pin-confirm">Confirm PIN</Label>
          <Input
            id="enable-pin-confirm"
            type="password"
            inputMode="numeric"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
          />
        </div>

        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" size="sm" disabled={busy}>
            {busy ? "Saving…" : mode === "change" ? "Update PIN" : "Enable"}
          </Button>
        </div>
      </form>
    </div>
  );
}
