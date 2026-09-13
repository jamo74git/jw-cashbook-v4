import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { createClient } from "@/lib/supabase/client";
import { getDashboardRoute } from "@/lib/permissions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Turnstile } from "@/components/Turnstile";
import type { Role } from "@/lib/types";

export interface AuthenticatedContext {
  email: string;
  password: string;
  role: Role;
  turnstileToken: string | null;
}

interface LoginFormProps {
  /**
   * If provided, called on successful online authentication instead of navigating,
   * so the parent can offer offline-PIN setup. Password is passed transiently in
   * memory so activateOffline can re-authenticate; it is not persisted.
   */
  onAuthenticated?: (ctx: AuthenticatedContext) => void;
}

export function LoginForm({ onAuthenticated }: LoginFormProps) {
  const navigate = useNavigate();
  const supabase = createClient();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);

  const siteKey = import.meta.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    // Step 0: Turnstile (if configured) — verified server-side via Edge Function.
    if (siteKey && !turnstileToken) {
      setLoading(false);
      setError("Please complete the security verification.");
      return;
    }
    if (turnstileToken) {
      const { data, error: verifyErr } = await supabase.functions.invoke("verify-turnstile", {
        body: { token: turnstileToken },
      });
      if (verifyErr || !data?.success) {
        setLoading(false);
        setError("Security verification failed. Please try again.");
        return;
      }
    }

    // Step 1: authenticate.
    const { data, error: authError } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    if (authError || !data.user) {
      setLoading(false);
      setError("Invalid email or password");
      return;
    }

    // Step 2: active access record.
    const { data: access, error: accessError } = await supabase
      .from("user_hierarchy_access")
      .select("role, status, start_date, end_date")
      .eq("user_id", data.user.id)
      .eq("status", "active")
      .order("created_at", { ascending: true })
      .limit(1)
      .maybeSingle();

    if (accessError || !access) {
      await supabase.auth.signOut();
      setLoading(false);
      setError("Access is restricted to registered congregation members.");
      return;
    }

    // Step 3: date window.
    const nowIso = new Date().toISOString();
    if (access.start_date && access.start_date > nowIso) {
      await supabase.auth.signOut();
      setLoading(false);
      setError("Your access has not yet started. Contact your administrator.");
      return;
    }
    if (access.end_date && access.end_date < nowIso) {
      await supabase.auth.signOut();
      setLoading(false);
      setError("Your access has expired. Contact your administrator.");
      return;
    }

    // Step 4: HO users must have >= 1 district assignment.
    if (access.role === "HO") {
      const { data: districts } = await supabase
        .from("ho_district_assignments")
        .select("district_id")
        .eq("user_id", data.user.id)
        .limit(1);
      if (!districts || districts.length === 0) {
        await supabase.auth.signOut();
        setLoading(false);
        setError("No district assignment found. Contact Head Office.");
        return;
      }
    }

    setLoading(false);
    const role = access.role as Role;

    // Hand off to the parent for optional PIN setup, or route to the dashboard.
    if (onAuthenticated) {
      onAuthenticated({ email: email.trim(), password, role, turnstileToken });
    } else {
      navigate(getDashboardRoute(role));
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="email">Email address</Label>
        <Input
          id="email"
          type="email"
          placeholder="you@example.com"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          autoComplete="email"
          aria-describedby={error ? "login-error" : undefined}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="password">Password</Label>
        <Input
          id="password"
          type="password"
          placeholder="Enter your password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          autoComplete="current-password"
        />
      </div>

      {/* Renders only if NEXT_PUBLIC_TURNSTILE_SITE_KEY is set */}
      <Turnstile
        onVerify={(token) => setTurnstileToken(token)}
        onError={() => setError("Security verification failed. Please refresh.")}
      />

      {error && (
        <p id="login-error" role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}

      <Button type="submit" className="w-full" disabled={loading}>
        {loading ? "Signing in..." : "Sign In"}
      </Button>
    </form>
  );
}
