"use client";

import { useEffect, useState, useRef } from "react";
import { useNavigate } from "react-router-dom";
import { createClient } from "@/lib/supabase/client";
import { getCurrentIdentity, type CurrentIdentity } from "@/lib/identity";
import { resolveHierarchyChain, type ChainSegment } from "@/lib/hierarchyChain";
import { setOfflinePinDismissed } from "@/lib/deviceId";
import { signOut as clearOfflineSession } from "@/services/authService";
import { Badge } from "@/components/ui/badge";

export function AppHeader() {
  const supabase = createClient();
  const navigate = useNavigate();
  const [identity, setIdentity] = useState<CurrentIdentity | null>(null);
  const [chain, setChain] = useState<ChainSegment[]>([]);
  const [districtName, setDistrictName] = useState("");
  const [showMenu, setShowMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    (async () => {
      // Online AND offline-aware; fail-closed null -> render nothing.
      const id = await getCurrentIdentity();
      if (!id) return;
      setIdentity(id);

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

  async function handleSignOut() {
    clearOfflineSession();
    await supabase.auth.signOut();
    navigate("/login");
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
                {identity?.isOnline && (
                  <button
                    onClick={() => {
                      setShowMenu(false);
                      // Clear any "don't ask again" dismissal and re-run the online
                      // sign-in so the offline-PIN setup prompt appears again.
                      if (identity.userId) setOfflinePinDismissed(identity.userId, false);
                      navigate("/login");
                    }}
                    className="w-full text-left px-3 py-2 text-sm rounded-sm hover:bg-muted"
                  >
                    Enable offline mode (Set PIN)
                  </button>
                )}
                <button onClick={handleSignOut} className="w-full text-left px-3 py-2 text-sm rounded-sm hover:bg-muted text-destructive">
                  Sign Out
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}
