"use client";

import { useEffect, useState, useRef } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { createClient } from "@/lib/supabase/client";
import { getUserAccess } from "@/lib/permissions";
import { Badge } from "@/components/ui/badge";
import type { UserHierarchyAccess } from "@/lib/types";

export function AppHeader() {
  const supabase = createClient();
  const router = useRouter();
  const [access, setAccess] = useState<UserHierarchyAccess | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [congCount, setCongCount] = useState(0);
  const [districtName, setDistrictName] = useState("");
  const [showMenu, setShowMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    (async () => {
      const a = await getUserAccess();
      if (!a) return;
      setAccess(a);
      const { data: { user } } = await supabase.auth.getUser();
      // Display name from email prefix (hide full email)
      const name = user?.email?.split("@")[0] ?? "User";
      setDisplayName(name.charAt(0).toUpperCase() + name.slice(1));

      if (a.scope_level === "Eldership") {
        const { count } = await supabase.from("congregations").select("id", { count: "exact", head: true }).eq("eldership_id", a.hierarchy_id);
        setCongCount(count ?? 0);
      } else if (a.congregation_id) {
        setCongCount(1);
      }

      // For HO users, fetch district name
      if (a.role === "HO") {
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
    await supabase.auth.signOut();
    router.push("/login");
  }

  const initials = displayName.slice(0, 2).toUpperCase();

  return (
    <header className="sticky top-0 z-50 border-b bg-background shadow-sm">
      <div className="flex h-12 items-center justify-between px-3 max-w-[1600px] mx-auto">
        {/* Left: Logo */}
        <div className="flex items-center gap-3">
          <Image src="/nac-logo.png" alt="NAC" width={28} height={28} className="rounded" />
          <span className="text-sm font-semibold text-primary hidden sm:inline">OAC Management System</span>
        </div>

        {/* Right: Single banner line + avatar */}
        <div className="flex items-center gap-3 text-xs" ref={menuRef}>
          <div className="hidden sm:flex items-center gap-2">
            <span className="font-medium">{displayName}</span>
            <span className="text-muted-foreground">|</span>
            <span>Role: <b>{access?.role}</b></span>
            <span className="text-muted-foreground">|</span>
            {access?.role === "HO" && districtName ? (
              <span>District: <b>{districtName}</b></span>
            ) : (
              <span>Scope: <b>{congCount} Congregation{congCount !== 1 ? "s" : ""}</b></span>
            )}
          </div>
          {access && <Badge variant="secondary" className="text-[10px] sm:hidden">{access.role}</Badge>}

          {/* Avatar dropdown */}
          <div className="relative">
            <button onClick={() => setShowMenu(!showMenu)} className="flex h-7 w-7 items-center justify-center rounded-full bg-primary text-primary-foreground text-[10px] font-bold hover:bg-primary/90">
              {initials}
            </button>
            {showMenu && (
              <div className="absolute right-0 top-9 z-50 min-w-40 rounded-md border bg-background p-1 shadow-lg">
                <div className="px-3 py-2 border-b text-xs">
                  <p className="font-medium">{displayName}</p>
                  <p className="text-muted-foreground">{access?.role} · {access?.scope_level}</p>
                </div>
                <button onClick={() => { setShowMenu(false); router.push("/admin/settings"); }} className="w-full text-left px-3 py-2 text-sm rounded-sm hover:bg-muted">
                  Settings
                </button>
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
