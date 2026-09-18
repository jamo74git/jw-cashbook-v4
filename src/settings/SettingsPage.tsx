// ─────────────────────────────────────────────────────────────────────────────
// SETTINGS (mounted at /settings under AppShell). Theme toggle (light/dark/system),
// user profile display (role · scope · email), and Sign Out as a secondary action.
// Reachable by any authenticated role. The header/sign-out chrome comes from AppShell.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { createClient } from "@/lib/supabase/client";
import { getUserAccess, getDashboardRoute } from "@/lib/permissions";
import { signOut as clearOfflineSession } from "@/services/authService";
import { useTheme, type Theme } from "@/lib/useTheme";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import type { Role, UserHierarchyAccess } from "@/lib/types";

const THEME_OPTIONS: { key: Theme; label: string; hint: string }[] = [
  { key: "light", label: "Light", hint: "Always light" },
  { key: "dark", label: "Dark", hint: "Always dark" },
  { key: "system", label: "System", hint: "Match device" },
];

export function SettingsPage() {
  const supabase = createClient();
  const navigate = useNavigate();
  const { theme, setTheme } = useTheme();

  const [access, setAccess] = useState<UserHierarchyAccess | null>(null);
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(true);

  const role = access?.role as Role | undefined;

  useEffect(() => {
    let active = true;
    (async () => {
      const ua = await getUserAccess();
      if (!active) return;
      setAccess(ua);
      const { data: { user } } = await supabase.auth.getUser();
      if (!active) return;
      setEmail(user?.email ?? "");
      setLoading(false);
    })();
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleBack() {
    // Prefer real history; fall back to the role's dashboard, else the root.
    if (window.history.length > 1) {
      navigate(-1);
      return;
    }
    navigate(role ? getDashboardRoute(role) : "/");
  }

  async function handleSignOut() {
    clearOfflineSession();
    await supabase.auth.signOut();
    navigate("/login");
  }

  return (
    <main className="mx-auto max-w-2xl p-6 space-y-4">
      <button
        onClick={handleBack}
        className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        aria-label="Go back"
      >
        <span aria-hidden="true">←</span> Back
      </button>

      <div className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight">Settings</h1>
        <p className="text-sm text-muted-foreground">Appearance and account.</p>
      </div>

      {/* Appearance */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Appearance</CardTitle></CardHeader>
        <CardContent>
          <p className="text-xs text-muted-foreground mb-2">Theme</p>
          <div className="grid grid-cols-3 gap-2">
            {THEME_OPTIONS.map((opt) => {
              const activeOpt = theme === opt.key;
              return (
                <button
                  key={opt.key}
                  onClick={() => setTheme(opt.key)}
                  aria-pressed={activeOpt}
                  className={`rounded-md border p-3 text-center transition-colors ${activeOpt ? "border-primary bg-primary/10" : "hover:bg-muted"}`}
                >
                  <p className={`text-sm font-medium ${activeOpt ? "text-primary" : ""}`}>{opt.label}</p>
                  <p className="text-[10px] text-muted-foreground">{opt.hint}</p>
                </button>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {/* Profile */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Profile</CardTitle></CardHeader>
        <CardContent className="text-sm space-y-1">
          {loading ? (
            <p className="text-muted-foreground">Loading…</p>
          ) : (
            <>
              <div className="flex justify-between"><span className="text-muted-foreground">Role</span><span className="font-medium">{role ?? "—"}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Scope</span><span className="font-medium">{access?.scope_level ?? "—"}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">Email</span><span className="font-medium">{email || "—"}</span></div>
            </>
          )}
        </CardContent>
      </Card>

      {/* Account — Sign Out as a secondary action */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-base">Account</CardTitle></CardHeader>
        <CardContent>
          <Button variant="outline" className="text-destructive border-destructive/40 hover:bg-destructive/10" onClick={() => void handleSignOut()}>
            Sign Out
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}
