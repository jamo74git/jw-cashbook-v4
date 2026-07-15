"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { getUserAccess, hasPermission, getHODistrictIds } from "@/lib/permissions";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { Role, UserHierarchyAccess } from "@/lib/types";

interface District {
  id: string;
  name: string;
  code: string;
}

export default function AdminDashboard() {
  const supabase = createClient();
  const [access, setAccess] = useState<UserHierarchyAccess | null>(null);
  const [email, setEmail] = useState<string>("");
  const [districts, setDistricts] = useState<District[]>([]);
  const [loading, setLoading] = useState(true);

  const role = access?.role as Role | undefined;

  useEffect(() => {
    (async () => {
      const userAccess = await getUserAccess();
      if (!userAccess) { setLoading(false); return; }
      setAccess(userAccess);

      const { data: { user } } = await supabase.auth.getUser();
      setEmail(user?.email ?? "");

      // Fetch HO district assignments
      if (userAccess.role === "HO") {
        const districtIds = await getHODistrictIds(userAccess.user_id);
        if (districtIds.length > 0) {
          const { data } = await supabase
            .from("hierarchy_levels")
            .select("id, name, code")
            .in("id", districtIds);
          setDistricts(data ?? []);
        }
      }
      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading) {
    return <main className="min-h-screen bg-muted/40 px-4 py-12"><div className="mx-auto max-w-4xl"><p className="text-muted-foreground">Loading...</p></div></main>;
  }

  if (!role || !hasPermission(role, "admin.manage_users")) {
    return <main className="min-h-screen bg-muted/40 px-4 py-12"><div className="mx-auto max-w-4xl"><p className="text-destructive">Access denied. HO Admin only.</p></div></main>;
  }

  return (
    <main className="min-h-screen bg-muted/40 px-4 py-6">
      <div className="mx-auto max-w-4xl space-y-6">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight">Head Office Administration</h1>
          <p className="text-sm text-muted-foreground">
            Role: <span className="font-medium">{role}</span> · {email}
          </p>
          <p className="text-sm text-muted-foreground">
            Scope: District level · {districts.length} district(s) assigned
          </p>
        </div>

        {/* District Filter */}
        {districts.length > 0 && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-base">Assigned Districts</CardTitle>
              <CardDescription>Your access is scoped to these districts only.</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-2">
                {districts.map((d) => (
                  <span key={d.id} className="inline-flex items-center rounded-full bg-primary/10 px-3 py-1 text-xs font-medium text-primary">
                    {d.name} ({d.code})
                  </span>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Admin Modules */}
        <div className="grid gap-4 sm:grid-cols-2">
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">User Management</CardTitle></CardHeader>
            <CardContent><p className="text-sm text-muted-foreground">Manage user access, roles, and hierarchy assignments.</p></CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">Bulk Import</CardTitle></CardHeader>
            <CardContent><p className="text-sm text-muted-foreground">CSV import for congregations, officers, users.</p></CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">Audit Logs</CardTitle></CardHeader>
            <CardContent><p className="text-sm text-muted-foreground">View all system actions and override exceptions.</p></CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">Corrections</CardTitle></CardHeader>
            <CardContent><p className="text-sm text-muted-foreground">Unlock months and raise correction requests.</p></CardContent>
          </Card>
        </div>

        <p className="text-xs text-muted-foreground text-center">Coming Soon — Full admin functionality</p>
      </div>
    </main>
  );
}
