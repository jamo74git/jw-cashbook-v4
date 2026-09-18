// ─────────────────────────────────────────────────────────────────────────────
// HO ADMIN LAYOUT (online-only). Collapsible hamburger sidebar + main content area.
// Sidebar: Dashboard (governance rollup) + User / Officer / Congregation / Hierarchy
// management. Open on desktop, collapsed on mobile. Nested routes render via <Outlet/>.
// Page gate: ho.view (HO/Apostle). Sits inside AppShell (which provides the top header).
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { getUserAccess, hasPermission } from "@/lib/permissions";
import { useOnlineStatus } from "@/lib/useOnlineStatus";
import type { Role, UserHierarchyAccess } from "@/lib/types";

const NAV: { to: string; label: string; end?: boolean }[] = [
  { to: "/ho", label: "Dashboard", end: true },
  { to: "/ho/users", label: "User Management" },
  { to: "/ho/officers", label: "Officer Management" },
  { to: "/ho/congregations", label: "Congregations" },
  { to: "/ho/hierarchy", label: "Hierarchy / Apostleships" },
];

export function HOAdminLayout() {
  const online = useOnlineStatus();
  const [access, setAccess] = useState<UserHierarchyAccess | null>(null);
  const [loading, setLoading] = useState(true);
  const [open, setOpen] = useState(() => typeof window !== "undefined" && window.innerWidth >= 768);

  useEffect(() => {
    let active = true;
    getUserAccess().then((a) => { if (active) { setAccess(a); setLoading(false); } });
    return () => { active = false; };
  }, []);

  const role = access?.role as Role | undefined;

  if (!online) return <p className="p-6 text-sm text-amber-700">Offline Unavailable — connect to a stable network to manage Head Office data.</p>;
  if (loading) return <p className="p-6 text-sm text-muted-foreground">Loading…</p>;
  if (!role || !hasPermission(role, "ho.view")) {
    return <p className="p-6 text-sm text-destructive">Access denied. Head Office role required.</p>;
  }

  return (
    <div className="flex min-h-[calc(100vh-3rem)]">
      <aside className={`${open ? "w-56" : "w-0"} shrink-0 overflow-hidden border-r bg-muted/30 transition-[width] duration-200`}>
        <nav className="w-56 p-2 space-y-1">
          <p className="px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-muted-foreground">Head Office</p>
          {NAV.map((n) => (
            <NavLink
              key={n.to}
              to={n.to}
              end={n.end}
              onClick={() => { if (typeof window !== "undefined" && window.innerWidth < 768) setOpen(false); }}
              className={({ isActive }) => `block rounded-md px-3 py-2 text-sm transition-colors ${isActive ? "bg-primary text-primary-foreground font-medium" : "hover:bg-muted"}`}
            >
              {n.label}
            </NavLink>
          ))}
        </nav>
      </aside>

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 border-b px-3 py-2 bg-background">
          <button
            onClick={() => setOpen((v) => !v)}
            aria-label={open ? "Collapse menu" : "Open menu"}
            aria-expanded={open}
            className="rounded-md border px-2.5 py-1 text-sm hover:bg-muted"
          >
            ☰
          </button>
          <span className="text-sm font-semibold">Head Office Admin</span>
        </div>
        <Outlet />
      </div>
    </div>
  );
}
