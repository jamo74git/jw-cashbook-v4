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
import { AuditDashboard } from "@/audit/AuditDashboard";
import { AuditReviewPage } from "@/audit/AuditReviewPage";
import { ElderDashboard } from "@/elder/ElderDashboard";
import { ChairpersonDashboard } from "@/chairperson/ChairpersonDashboard";
import { OverseerReview } from "@/review/OverseerReview";
import { HOReview } from "@/review/HOReview";
import { HOAdminLayout } from "@/ho/HOAdminLayout";
import { UsersScreen } from "@/ho/UsersScreen";
import { OfficersScreen } from "@/ho/OfficersScreen";
import { CongregationsScreen } from "@/ho/CongregationsScreen";
import { HierarchyScreen } from "@/ho/HierarchyScreen";
import { SecretaryReview } from "@/secretary/SecretaryReview";
import { SettingsPage } from "@/settings/SettingsPage";

// Code-split the two layout roots so an offline Capture load never pulls Admin code.
const CaptureLayout = lazy(() => import("./capture/CaptureLayout"));
const AdminLayout = lazy(() => import("./admin/AdminLayout"));

// Role dashboards not yet rebuilt in the Vite app; routed to a placeholder so users
// land somewhere with a header + sign-out instead of bouncing back to /login.
const ROLE_DASHBOARDS = ["/dashboard", "/treasurer", "/reports"];

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

/** /admin is superseded by the HO review portal at /ho. Redirect so the old
 * placeholder never shows and any lingering /admin links land on the real screen. */
function AdminHome() {
  return <Navigate to="/ho" replace />;
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
            {/* Auditor portal (online-only; in-page audit.view_queue gate). */}
            <Route path="/audit" element={<AuditDashboard />} />
            <Route path="/audit/:periodId" element={<AuditReviewPage />} />
            {/* Elder portal (online-only; in-page month.submit_to_overseer gate). */}
            <Route path="/elder" element={<ElderDashboard />} />
            {/* Chairperson portal (online-only; fallback submitter, same gate). */}
            <Route path="/chairperson" element={<ChairpersonDashboard />} />
            {/* Overseer/Apostle review (online-only; in-page overseer.view gate).
                Canonical /review (getDashboardRoute target) + /overseer alias. */}
            <Route path="/review" element={<OverseerReview />} />
            <Route path="/overseer" element={<OverseerReview />} />
            {/* HO Admin: hamburger-sidebar layout. Dashboard (governance rollup) is the
                index; User/Officer/Congregation/Hierarchy management are sidebar routes. */}
            <Route path="/ho" element={<HOAdminLayout />}>
              <Route index element={<HOReview />} />
              <Route path="dashboard" element={<Navigate to="/ho" replace />} />
              <Route path="users" element={<UsersScreen />} />
              <Route path="officers" element={<OfficersScreen />} />
              <Route path="congregations" element={<CongregationsScreen />} />
              <Route path="hierarchy" element={<HierarchyScreen />} />
            </Route>
            {/* Secretary congregational finance (online-only; in-page secretary.view gate). */}
            <Route path="/secretary" element={<SecretaryReview />} />
            {/* Settings (any authenticated user) — theme + profile + sign out. */}
            <Route path="/settings" element={<SettingsPage />} />
          </Route>

          <Route path="*" element={<Navigate to="/login" replace />} />
        </Routes>
      </Suspense>
      <ReloadPrompt />
    </BrowserRouter>
  );
}
