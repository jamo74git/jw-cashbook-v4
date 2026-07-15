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

export default function CaptureDashboard() {
  const supabase = createClient();
  const [access, setAccess] = useState<UserHierarchyAccess | null>(null);
  const [email, setEmail] = useState<string>("");
  const [congregation, setCongregation] = useState<Congregation | null>(null);
  const [loading, setLoading] = useState(true);

  const role = access?.role as Role | undefined;

  useEffect(() => {
    (async () => {
      const userAccess = await getUserAccess();
      if (!userAccess) { setLoading(false); return; }
      setAccess(userAccess);

      const { data: { user } } = await supabase.auth.getUser();
      setEmail(user?.email ?? "");

      // Fetch congregation for Treasurer/Chairperson (congregation_id is set)
      if (userAccess.congregation_id) {
        const { data: cong } = await supabase
          .from("congregations")
          .select("id, name, code")
          .eq("id", userAccess.congregation_id)
          .single();
        if (cong) setCongregation(cong);
      }
      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading) {
    return <main className="min-h-screen bg-muted/40 px-4 py-12"><div className="mx-auto max-w-4xl"><p className="text-muted-foreground">Loading...</p></div></main>;
  }

  if (!role || !hasPermission(role, "capture.create")) {
    return <main className="min-h-screen bg-muted/40 px-4 py-12"><div className="mx-auto max-w-4xl"><p className="text-destructive">Access denied. Treasurer or Chairperson role required.</p></div></main>;
  }

  return (
    <main className="min-h-screen bg-muted/40 px-4 py-6">
      <div className="mx-auto max-w-4xl space-y-6">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight">Capture Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            Role: <span className="font-medium">{role}</span> · {email}
          </p>
          {congregation && (
            <p className="text-sm text-muted-foreground">
              Congregation: <span className="font-medium">{congregation.name}</span> ({congregation.code})
            </p>
          )}
        </div>

        {/* Single Congregation — Direct Action Cards */}
        <div className="grid gap-4 sm:grid-cols-2">
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">New Service Capture</CardTitle></CardHeader>
            <CardContent>
              <CardDescription>Start capturing AM or PM service for the current week.</CardDescription>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">Draft Services</CardTitle></CardHeader>
            <CardContent>
              <CardDescription>Continue editing services saved as Draft.</CardDescription>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">Pending Audit</CardTitle></CardHeader>
            <CardContent>
              <CardDescription>Services you submitted that are awaiting auditor review.</CardDescription>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">Census</CardTitle></CardHeader>
            <CardContent>
              <CardDescription>Update priest census demographics for this month.</CardDescription>
            </CardContent>
          </Card>
        </div>

        <p className="text-xs text-muted-foreground text-center">Coming Soon — Service selection and capture flow</p>
      </div>
    </main>
  );
}
