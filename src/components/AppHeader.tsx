"use client";

import { useEffect, useState } from "react";
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
  const [email, setEmail] = useState("");
  const [scopeName, setScopeName] = useState("");
  const [congCount, setCongCount] = useState(0);
  const [showMenu, setShowMenu] = useState(false);

  useEffect(() => {
    (async () => {
      const a = await getUserAccess();
      if (!a) return;
      setAccess(a);

      const { data: { user } } = await supabase.auth.getUser();
      setEmail(user?.email ?? "");

      // Get scope name from hierarchy
      const { data: h } = await supabase.from("hierarchy_levels").select("name, level_type").eq("id", a.hierarchy_id).single();
      if (h) setScopeName(`${h.level_type} ${h.name}`);

      // Count congregations in scope
      if (a.scope_level === "Eldership") {
        const { count } = await supabase.from("congregations").select("id", { count: "exact", head: true }).eq("eldership_id", a.hierarchy_id);
        setCongCount(count ?? 0);
      } else if (a.congregation_id) {
        setCongCount(1);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSignOut() { await supabase.auth.signOut(); router.push("/login"); }

  const initials = email ? email.slice(0, 2).toUpperCase() : "??";

  return (
    <>
      {/* Main Header */}
      <header className="sticky top-0 z-50 border-b bg-background shadow-sm">
        <div className="flex h-12 items-center justify-between px-3 max-w-[1600px] mx-auto">
          <div className="flex items-center gap-3">
            <Image src="/nac-logo.png" alt="NAC" width={28} height={28} className="rounded" />
            <span className="text-sm font-semibold text-primary hidden sm:inline">OAC Management System</span>
          </div>
          <div className="relative flex items-center gap-2">
            {access && <Badge variant="secondary" className="text-[10px] hidden sm:inline-flex">{access.role}</Badge>}
            <span className="text-xs text-muted-foreground hidden md:inline">{scopeName}</span>
            <button onClick={() => setShowMenu(!showMenu)} className="flex h-7 w-7 items-center justify-center rounded-full bg-primary text-primary-foreground text-[10px] font-bold hover:bg-primary/90">
              {initials}
            </button>
            {showMenu && (
              <div className="absolute right-0 top-9 z-50 min-w-44 rounded-md border bg-background p-1 shadow-lg">
                <div className="px-3 py-2 border-b text-xs">
                  <p className="font-medium">{email}</p>
                  <p className="text-muted-foreground">{access?.role} · {access?.scope_level}</p>
                </div>
                <button onClick={handleSignOut} className="w-full text-left px-3 py-2 text-sm rounded-sm hover:bg-muted text-destructive">Sign Out</button>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* User Banner */}
      <div className="bg-muted/50 border-b px-3 py-1.5">
        <div className="max-w-[1600px] mx-auto flex items-center gap-2 text-[11px] text-muted-foreground">
          <span>Signed in as <b className="text-foreground">{email}</b></span>
          <span>|</span>
          <span>Role: <b className="text-foreground">{access?.role}</b></span>
          <span>|</span>
          <span>Scope: <b className="text-foreground">{scopeName}</b>{congCount > 0 ? `: ${congCount} congregation(s)` : ""}</span>
        </div>
      </div>
    </>
  );
}
