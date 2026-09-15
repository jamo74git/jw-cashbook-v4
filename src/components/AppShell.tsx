import { Outlet } from "react-router-dom";
import { AppHeader } from "@/components/AppHeader";

/**
 * Shared authenticated shell. Renders the app header (with sign-out) once and hosts
 * nested routes via <Outlet/>. Use as a layout route so standard authenticated pages
 * don't each re-declare the header (React Router layout-route pattern).
 *
 * Note: /login (no session), /admin (online-only full-screen when offline), and
 * /capture (offline banner) keep their own layouts because their chrome differs; they
 * still reuse the <AppHeader/> component.
 */
export function AppShell() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <AppHeader />
      <Outlet />
    </div>
  );
}
