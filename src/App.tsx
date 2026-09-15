import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import {
  BrowserRouter,
  Routes,
  Route,
  Navigate,
  Link,
} from "react-router-dom";
import { resolveAccess, canEnterCapture, canEnterAdmin, redirectTargetFor } from "@/lib/routeGuard";
import type { UserHierarchyAccess } from "@/lib/types";
import { ReloadPrompt } from "./pwa/ReloadPrompt";
import { LoginPage } from "@/features/auth/LoginPage";
import { CapturePage } from "@/capture/CapturePage";
import { AppShell } from "@/components/AppShell";

// Code-split the two layout roots so an offline Capture load never pulls Admin code.
const CaptureLayout = lazy(() => import("./capture/CaptureLayout"));
const AdminLayout = lazy(() => import("./admin/AdminLayout"));

// Role dashboards not yet rebuilt in the Vite app; routed to a placeholder so users
// land somewhere with a header + sign-out instead of bouncing back to /login.
const ROLE_DASHBOARDS = ["/dashboard", "/treasurer", "/elder", "/chairperson", "/review", "/audit", "/reports"];

function Loading() {
  return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
}

/**
 * First-pass client route guard. Resolves the access record and enforces the area's
 * entry rule via the permission matrix. area "any" = any authenticated active user.
 * Fail-closed: no access -> /login.
 */
function Protected({ area, children }: { area: "capture" | "admin" | "any"; children: ReactNode }) {
  const [loading, setLoading] = useState(true);
  const [access, setAccess] = useState<UserHierarchyAccess | null>(null);

  useEffect(() => {
    let active = true;
    resolveAccess().then((a) => {
      if (active) {
        setAccess(a);
        setLoading(false);
      }
    });
    return () => {
      active = false;
    };
  }, []);

  if (loading) return <Loading />;
  if (!access) return <Navigate to="/login" replace />;

  const allowed =
    area === "capture" ? canEnterCapture(access.role) : area === "admin" ? canEnterAdmin(access.role) : true;
  if (!allowed) return <Navigate to={redirectTargetFor(access.role)} replace />;

  return <>{children}</>;
}

function AdminHome() {
  return <p className="text-sm text-muted-foreground">Head Office dashboard (online-only) — coming next.</p>;
}

/** Content-only placeholder for role dashboards not yet ported. The header comes from
 * the shared AppShell layout route, so this renders just the page body. */
function RoleHome() {
  return (
    <main className="max-w-3xl mx-auto p-6 space-y-3">
      <h1 className="text-lg font-bold">Dashboard</h1>
      <p className="text-sm text-muted-foreground">
        This role dashboard hasn't been rebuilt in the new app yet. Offline field
        capture is available.
      </p>
      <Link to="/capture" className="inline-block text-sm text-primary underline">
        Open Capture →
      </Link>
    </main>
  );
}

export function App() {
  return (
    <BrowserRouter>
      <Suspense fallback={<Loading />}>
        <Routes>
          <Route path="/" element={<Navigate to="/login" replace />} />
          <Route path="/login" element={<LoginPage />} />

          <Route
            path="/capture"
            element={
              <Protected area="capture">
                <CaptureLayout />
              </Protected>
            }
          >
            <Route index element={<CapturePage />} />
          </Route>

          <Route
            path="/admin"
            element={
              <Protected area="admin">
                <AdminLayout />
              </Protected>
            }
          >
            <Route index element={<AdminHome />} />
          </Route>

          {/* Shared authenticated shell (header declared ONCE) hosts the not-yet-ported
              role dashboards. Each path renders inside the shell's <Outlet/>. */}
          <Route
            element={
              <Protected area="any">
                <AppShell />
              </Protected>
            }
          >
            {ROLE_DASHBOARDS.map((path) => (
              <Route key={path} path={path} element={<RoleHome />} />
            ))}
          </Route>

          <Route path="*" element={<Navigate to="/login" replace />} />
        </Routes>
      </Suspense>
      <ReloadPrompt />
    </BrowserRouter>
  );
}
