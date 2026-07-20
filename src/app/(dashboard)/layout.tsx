"use client";

import { useEffect, useState, useRef } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { createClient } from "@/lib/supabase/client";
import { getUserAccess } from "@/lib/permissions";
import { Badge } from "@/components/ui/badge";
import type { UserHierarchyAccess } from "@/lib/types";

export default function DashboardLayout({ children }: { children: React.ReactNode }) {
  const supabase = createClient();
  const router = useRouter();
  const [access, setAccess] = useState<UserHierarchyAccess | null>(null);
  const [congName, setCongName] = useState("");
  const [congCode, setCongCode] = useState("");
  const [elderName, setElderName] = useState("");
  const [overseerName, setOverseerName] = useState("");
  const [showMenu, setShowMenu] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    (async () => {
      const a = await getUserAccess();
      if (!a) return;
      setAccess(a);
      if (a.congregation_id) {
        const { data: cong } = await supabase.from("congregations").select("name, code, eldership_id, overseership_id").eq("id", a.congregation_id).single();
        if (cong) {
          setCongName(cong.name); setCongCode(cong.code);
          if (cong.eldership_id) { const { data: e } = await supabase.from("hierarchy_levels").select("name").eq("id", cong.eldership_id).single(); if (e) setElderName(e.name); }
          if (cong.overseership_id) { const { data: o } = await supabase.from("hierarchy_levels").select("name").eq("id", cong.overseership_id).single(); if (o) setOverseerName(o.name); }
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

  async function handleSignOut() { await supabase.auth.signOut(); router.push("/login"); }

  return (
    <div className="min-h-screen flex flex-col bg-muted/30">
      {/* Top Bar */}
      <header className="sticky top-0 z-50 border-b bg-background shadow-sm">
        <div className="flex h-12 items-center justify-between px-3 max-w-[1600px] mx-auto">
          {/* Left: Logo + Cong Info */}
          <div className="flex items-center gap-4">
            <Image src="/nac-logo.png" alt="NAC" width={28} height={28} className="rounded" />
            <div className="hidden sm:flex items-center gap-4 text-xs">
              <span className="font-semibold text-primary">OAC Management System</span>
              <span className="text-muted-foreground">|</span>
              <span><b>{congCode}</b> {congName}</span>
              {elderName && <><span className="text-muted-foreground">|</span><span>Elder: {elderName}</span></>}
              {overseerName && <><span className="text-muted-foreground">|</span><span>Overseer: {overseerName}</span></>}
            </div>
          </div>
          {/* Right: Role + Avatar */}
          <div className="relative flex items-center gap-2" ref={menuRef}>
            {access && <Badge variant="secondary" className="text-[10px]">{access.role}</Badge>}
            <button onClick={() => setShowMenu(!showMenu)} className="flex h-7 w-7 items-center justify-center rounded-full bg-primary text-primary-foreground text-[10px] font-bold hover:bg-primary/90">
              {access?.role?.slice(0, 2).toUpperCase() ?? "??"}
            </button>
            {showMenu && (
              <div className="absolute right-0 top-9 z-50 min-w-40 rounded-md border bg-background p-1 shadow-lg">
                <div className="px-3 py-2 border-b text-xs">
                  <p className="font-medium">{access?.role}</p>
                  <p className="text-muted-foreground text-[10px]">{congCode} {congName}</p>
                </div>
                <button onClick={() => { setShowMenu(false); router.push("/settings"); }} className="w-full text-left px-3 py-2 text-sm rounded-sm hover:bg-muted">Settings</button>
                <button onClick={handleSignOut} className="w-full text-left px-3 py-2 text-sm rounded-sm hover:bg-muted text-destructive">Sign Out</button>
              </div>
            )}
          </div>
        </div>
      </header>
      <main className="flex-1">{children}</main>
    </div>
  );
}
