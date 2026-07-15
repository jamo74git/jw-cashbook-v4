"use client";

import { useEffect, useState } from "react";
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
  const [email, setEmail] = useState("");
  const [showMenu, setShowMenu] = useState(false);

  useEffect(() => {
    (async () => {
      const a = await getUserAccess();
      setAccess(a);
      const { data: { user } } = await supabase.auth.getUser();
      setEmail(user?.email ?? "");
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleSignOut() {
    await supabase.auth.signOut();
    router.push("/login");
  }

  const initials = email ? email.slice(0, 2).toUpperCase() : "??";

  return (
    <div className="min-h-screen flex flex-col">
      {/* Top Bar */}
      <header className="sticky top-0 z-50 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
        <div className="flex h-14 items-center justify-between px-4 max-w-7xl mx-auto">
          {/* Left: Logo + Title */}
          <div className="flex items-center gap-3">
            <Image src="/nac-logo.png" alt="NAC" width={32} height={32} className="rounded" />
            <span className="text-sm font-semibold tracking-tight text-primary hidden sm:inline">
              OAC Management System
            </span>
          </div>

          {/* Right: User info + Avatar dropdown */}
          <div className="relative flex items-center gap-3">
            {access && (
              <Badge variant="secondary" className="hidden sm:inline-flex">
                {access.role}
              </Badge>
            )}
            <span className="text-xs text-muted-foreground hidden md:inline">{email}</span>

            {/* Avatar button */}
            <button
              onClick={() => setShowMenu(!showMenu)}
              className="flex h-8 w-8 items-center justify-center rounded-full bg-primary text-primary-foreground text-xs font-bold hover:bg-primary/90 transition-colors"
            >
              {initials}
            </button>

            {/* Dropdown */}
            {showMenu && (
              <div className="absolute right-0 top-10 z-50 min-w-48 rounded-md border bg-background p-2 shadow-lg">
                <div className="px-3 py-2 border-b mb-1">
                  <p className="text-sm font-medium">{email}</p>
                  <p className="text-xs text-muted-foreground">{access?.role} · {access?.scope_level}</p>
                </div>
                <button
                  onClick={handleSignOut}
                  className="w-full text-left px-3 py-2 text-sm rounded-sm hover:bg-muted transition-colors text-destructive"
                >
                  Sign Out
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="flex-1">{children}</main>
    </div>
  );
}
