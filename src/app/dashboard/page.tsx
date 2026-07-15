"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { getUserAccess, hasPermission } from "@/lib/permissions";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { Role, UserHierarchyAccess } from "@/lib/types";

interface Congregation {
  id: string;
  name: string;
  code: string;
}

export default function ElderDashboard() {
  const supabase = createClient();
  const [access, setAccess] = useState<UserHierarchyAccess | null>(null);
  const [email, setEmail] = useState<string>("");
  const [hierarchyName, setHierarchyName] = useState<string>("");
  const [congregations, setCongregations] = useState<Congregation[]>([]);
  const [loading, setLoading] = useState(true);

  const role = access?.role as Role | undefined;

  useEffect(() => {
    (async () => {
      const userAccess = await getUserAccess();
      if (!userAccess) { setLoading(false); return; }
      setAccess(userAccess);

      const { data: { user } } = await supabase.auth.getUser();
      setEmail(user?.email ?? "");

      // Fetch hierarchy name (Eldership)
      const { data: hierarchy } = await supabase
        .from("hierarchy_levels")
        .select("name, level_type")
        .eq("id", userAccess.hierarchy_id)
        .single();
      if (hierarchy) setHierarchyName(`${hierarchy.level_type}: ${hierarchy.name}`);

      // Fetch congregations under this eldership
      const { data: congs } = await supabase
        .from("congregations")
        .select("id, name, code")
        .eq("eldership_id", userAccess.hierarchy_id);
      setCongregations(congs ?? []);

      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading) {
    return <main className="min-h-screen bg-muted/40 px-4 py-12"><div className="mx-auto max-w-4xl"><p className="text-muted-foreground">Loading...</p></div></main>;
  }

  if (!role || !hasPermission(role, "dashboard.home")) {
    return <main className="min-h-screen bg-muted/40 px-4 py-12"><div className="mx-auto max-w-4xl"><p className="text-destructive">Access denied.</p></div></main>;
  }

  return (
    <main className="min-h-screen bg-muted/40 px-4 py-6">
      <div className="mx-auto max-w-4xl space-y-6">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight">Elder Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            Role: <span className="font-medium">{role}</span> · {email}
          </p>
          <p className="text-sm text-muted-foreground">
            Scope: {hierarchyName} · {congregations.length} congregation(s)
          </p>
        </div>

        {/* Congregations under this Eldership */}
        {congregations.length > 0 && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">My Congregations</CardTitle>
              <CardDescription>All congregations under your Eldership.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {congregations.map((c) => (
                  <div key={c.id} className="flex items-center justify-between py-2 border-b last:border-0">
                    <span className="text-sm font-medium">{c.name}</span>
                    <span className="text-xs text-muted-foreground">{c.code}</span>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">Monthly Close</CardTitle></CardHeader>
            <CardContent><p className="text-sm text-muted-foreground">Submit approved months to Overseer for all congregations.</p></CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">Outstanding Audits</CardTitle></CardHeader>
            <CardContent><p className="text-sm text-muted-foreground">Services pending audit approval across your eldership.</p></CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">Census Health</CardTitle></CardHeader>
            <CardContent><p className="text-sm text-muted-foreground">Priestship census status with staleness flags.</p></CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">Expense Governance</CardTitle></CardHeader>
            <CardContent><p className="text-sm text-muted-foreground">Approve expenses exceeding R500 per HO governance.</p></CardContent>
          </Card>
        </div>

        <p className="text-xs text-muted-foreground text-center">Coming Soon — Full elder functionality</p>
      </div>
    </main>
  );
}
