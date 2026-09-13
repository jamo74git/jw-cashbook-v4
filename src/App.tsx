import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import {
  BrowserRouter,
  Routes,
  Route,
  Navigate,
} from "react-router-dom";
import { resolveAccess, canEnterCapture, canEnterAdmin, redirectTargetFor } from "@/lib/routeGuard";
import type { UserHierarchyAccess } from "@/lib/types";
import { ReloadPrompt } from "./pwa/ReloadPrompt";
import { LoginPage } from "@/features/auth/LoginPage";
import { CapturePage } from "@/capture/CapturePage";

// Code-split the two layout roots so an offline Capture load never pulls Admin code.
const CaptureLayout = lazy(() => import("./capture/CaptureLayout"));
const AdminLayout = lazy(() => import("./admin/AdminLayout"));

function Loading() {
  return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
}

/**
 * First-pass client route guard. Resolves the access record and enforces the
 * area's entry rule via the permission matrix. Fail-closed: no access -> /login.
 */
function Protected({ area, children }: { area: "capture" | "admin"; children: ReactNode }) {
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

  const allowed = area === "capture" ? canEnterCapture(access.role) : canEnterAdmin(access.role);
  if (!allowed) return <Navigate to={redirectTargetFor(access.role)} replace />;

  return <>{children}</>;
}

function AdminHome() {
  return <p className="text-sm text-muted-foreground">Head Office dashboard (online-only) — coming next.</p>;
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

          <Route path="*" element={<Navigate to="/login" replace />} />
        </Routes>
      </Suspense>
      <ReloadPrompt />
    </BrowserRouter>
  );
}
