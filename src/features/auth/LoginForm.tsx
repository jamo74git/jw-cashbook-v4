"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { getDashboardRoute } from "@/lib/permissions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Turnstile } from "@/components/Turnstile";
import type { Role } from "@/lib/types";

export function LoginForm() {
  const router = useRouter();
  const supabase = createClient();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    // Step 0: Verify Turnstile (if configured)
    if (process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY && !turnstileToken) {
      setLoading(false);
      setError("Please complete the security verification.");
      return;
    }

    if (turnstileToken) {
      const verifyRes = await fetch("/api/auth/verify-turnstile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: turnstileToken }),
      });
      const verifyData = await verifyRes.json();
      if (!verifyData.success) {
        setLoading(false);
        setError("Security verification failed. Please try again.");
        return;
      }
    }

    // Step 1: Authenticate with Supabase
    const { data, error: authError } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });

    if (authError || !data.user) {
      setLoading(false);
      setError("Invalid email or password");
      return;
    }

    // Step 2: Check user_hierarchy_access
    const { data: access, error: accessError } = await supabase
      .from("user_hierarchy_access")
      .select("id, role, hierarchy_id, congregation_id, scope_level, status, start_date, end_date")
      .eq("user_id", data.user.id)
      .eq("status", "active")
      .limit(1)
      .maybeSingle();

    if (accessError || !access) {
      await supabase.auth.signOut();
      setLoading(false);
      setError("Access is restricted to registered congregation members.");
      return;
    }

    // Step 3: Validate date range
    const now = new Date().toISOString();
    if (access.start_date && access.start_date > now) {
      await supabase.auth.signOut();
      setLoading(false);
      setError("Your access has not yet started. Contact your administrator.");
      return;
    }
    if (access.end_date && access.end_date < now) {
      await supabase.auth.signOut();
      setLoading(false);
      setError("Your access has expired. Contact your administrator.");
      return;
    }

    // Step 4: For HO users, verify district assignments
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

    // Step 5: Route to role-specific dashboard
    const dashboardRoute = getDashboardRoute(access.role as Role);
    setLoading(false);
    router.push(dashboardRoute);
    router.refresh();
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

      {/* Turnstile widget — only renders if NEXT_PUBLIC_TURNSTILE_SITE_KEY is set */}
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
