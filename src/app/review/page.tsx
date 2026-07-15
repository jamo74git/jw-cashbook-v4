"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { getUserAccess, hasPermission } from "@/lib/permissions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { Role, UserHierarchyAccess } from "@/lib/types";

export default function ReviewDashboard() {
  const supabase = createClient();
  const [access, setAccess] = useState<UserHierarchyAccess | null>(null);
  const [email, setEmail] = useState<string>("");
  const [hierarchyName, setHierarchyName] = useState<string>("");
  const [loading, setLoading] = useState(true);

  const role = access?.role as Role | undefined;

  useEffect(() => {
    (async () => {
      const userAccess = await getUserAccess();
      if (!userAccess) { setLoading(false); return; }
      setAccess(userAccess);

      const { data: { user } } = await supabase.auth.getUser();
      setEmail(user?.email ?? "");

      // Fetch hierarchy name for display (Apostleship or Overseership)
      const { data: hierarchy } = await supabase
        .from("hierarchy_levels")
        .select("name, level_type")
        .eq("id", userAccess.hierarchy_id)
        .single();
      if (hierarchy) setHierarchyName(`${hierarchy.level_type}: ${hierarchy.name}`);

      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading) {
    return <main className="min-h-screen bg-muted/40 px-4 py-12"><div className="mx-auto max-w-4xl"><p className="text-muted-foreground">Loading...</p></div></main>;
  }

  if (!role || (!hasPermission(role, "month.overseer_approve") && !hasPermission(role, "month.view"))) {
    return <main className="min-h-screen bg-muted/40 px-4 py-12"><div className="mx-auto max-w-4xl"><p className="text-destructive">Access denied.</p></div></main>;
  }

  return (
    <main className="min-h-screen bg-muted/40 px-4 py-6">
      <div className="mx-auto max-w-4xl space-y-6">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight">
            {role === "Apostle" ? "Apostle" : "Overseer"} Review Dashboard
          </h1>
          <p className="text-sm text-muted-foreground">
            Role: <span className="font-medium">{role}</span> · {email}
          </p>
          <p className="text-sm text-muted-foreground">
            Scope: {hierarchyName || access?.scope_level}
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">Months Pending Review</CardTitle></CardHeader>
            <CardContent><p className="text-sm text-muted-foreground">Congregations submitted for your approval across your {access?.scope_level?.toLowerCase()}.</p></CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">Congregation Performance</CardTitle></CardHeader>
            <CardContent><p className="text-sm text-muted-foreground">Income, banking, and audit status across all congregations in scope.</p></CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">Census Health</CardTitle></CardHeader>
            <CardContent><p className="text-sm text-muted-foreground">Priestship census staleness flags for your overseership/apostleship.</p></CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">Exception Reports</CardTitle></CardHeader>
            <CardContent><p className="text-sm text-muted-foreground">Banking exceptions, expense overruns, and correction requests.</p></CardContent>
          </Card>
        </div>

        <p className="text-xs text-muted-foreground text-center">Coming Soon — Full review functionality</p>
      </div>
    </main>
  );
}
