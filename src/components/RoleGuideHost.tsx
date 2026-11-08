// ─────────────────────────────────────────────────────────────────────────────
// ROLE GUIDE HOST (PRIORITY 3)
// Mounted once inside the router. Resolves the signed-in user's role via the route
// guard / permission matrix (no role-string checks here), auto-shows the dismissible
// guide ONCE per session when permitted (not compulsory), and re-opens on demand from
// the Help entry point. Fail-closed: no access (or a public route) renders nothing.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from "react";
import { useLocation } from "react-router-dom";
import { resolveAccess } from "@/lib/routeGuard";
import {
  ROLE_GUIDE_OPEN_EVENT,
  isRoleGuideDontShow,
  isRoleGuideSessionDismissed,
  setRoleGuideDontShow,
  setRoleGuideSessionDismissed,
  shouldAutoShowGuide,
} from "@/lib/roleGuidePrefs";
import type { Role } from "@/lib/types";
import { RoleGuideCard } from "@/components/RoleGuideCard";

// Public routes carry no signed-in guide.
const PUBLIC_PATHS = new Set(["/", "/login"]);

export function RoleGuideHost() {
  const location = useLocation();
  const [role, setRole] = useState<Role | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);

  // Resolve access as the user moves around the signed-in app (covers both the online
  // Supabase path and an offline unlock, which the route guard already handles).
  useEffect(() => {
    if (PUBLIC_PATHS.has(location.pathname)) {
      setRole(null);
      setUserId(null);
      setOpen(false);
      return;
    }
    let active = true;
    resolveAccess().then((a) => {
      if (!active) return;
      setRole(a?.role ?? null);
      setUserId(a?.user_id ?? null);
    });
    return () => {
      active = false;
    };
  }, [location.pathname]);

  // Auto-show once per user: runs when the resolved user changes, never on every
  // navigation. Suppressed by a prior session-dismiss or "Don't show again".
  useEffect(() => {
    if (!userId) return;
    if (
      shouldAutoShowGuide({
        dontShowAgain: isRoleGuideDontShow(userId),
        sessionDismissed: isRoleGuideSessionDismissed(userId),
      })
    ) {
      setOpen(true);
    }
  }, [userId]);

  // Help entry point: always re-openable regardless of either dismissal.
  useEffect(() => {
    function onOpen() {
      setOpen(true);
    }
    window.addEventListener(ROLE_GUIDE_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(ROLE_GUIDE_OPEN_EVENT, onOpen);
  }, []);

  if (!open || !role || !userId) return null;

  return (
    <RoleGuideCard
      role={role}
      onDismissSession={() => {
        setRoleGuideSessionDismissed(userId);
        setOpen(false);
      }}
      onDontShowAgain={() => {
        setRoleGuideDontShow(userId, true);
        setRoleGuideSessionDismissed(userId);
        setOpen(false);
      }}
    />
  );
}
