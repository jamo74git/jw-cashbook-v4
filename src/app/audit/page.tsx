"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { getUserAccess, hasPermission } from "@/lib/permissions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { Role, UserHierarchyAccess } from "@/lib/types";

interface Period {
  id: string;
  congregation_id: string;
  year: number;
  month: number;
  week: number;
  service: string;
  status: string;
  week_key: string | null;
  submitted_at: string | null;
  created_at: string;
}

interface Congregation { id: string; name: string; code: string; }

export default function AuditDashboard() {
  const supabase = createClient();
  const router = useRouter();
  const [access, setAccess] = useState<UserHierarchyAccess | null>(null);
  const [email, setEmail] = useState<string>("");
  const [congregation, setCongregation] = useState<Congregation | null>(null);
  const [pendingPeriods, setPendingPeriods] = useState<Period[]>([]);
  const [approvedPeriods, setApprovedPeriods] = useState<Period[]>([]);
  const [loading, setLoading] = useState(true);

  const role = access?.role as Role | undefined;

  useEffect(() => {
    (async () => {
      const userAccess = await getUserAccess();
      if (!userAccess) { setLoading(false); return; }
      setAccess(userAccess);

      const { data: { user } } = await supabase.auth.getUser();
      setEmail(user?.email ?? "");

      // Fetch congregation
      if (userAccess.congregation_id) {
        const { data: cong } = await supabase
          .from("congregations")
          .select("id, name, code")
          .eq("id", userAccess.congregation_id)
          .single();
        if (cong) setCongregation(cong);

        // Fetch periods submitted for audit (status = "Submitted")
        const { data: pending } = await supabase
          .from("cashbook_period")
          .select("id, congregation_id, year, month, week, service, status, week_key, submitted_at, created_at")
          .eq("congregation_id", userAccess.congregation_id)
          .eq("status", "Submitted")
          .order("year", { ascending: false })
          .order("month", { ascending: false })
          .order("week", { ascending: false });
        setPendingPeriods(pending ?? []);

        // Fetch recently audited (approved/rejected)
        const { data: audited } = await supabase
          .from("cashbook_period")
          .select("id, congregation_id, year, month, week, service, status, week_key, submitted_at, created_at")
          .eq("congregation_id", userAccess.congregation_id)
          .in("status", ["AuditApproved", "Rejected"])
          .order("year", { ascending: false })
          .order("month", { ascending: false })
          .limit(10);
        setApprovedPeriods(audited ?? []);
      }
      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading) {
    return <main className="min-h-screen bg-muted/40 px-4 py-12"><div className="mx-auto max-w-4xl"><p className="text-muted-foreground">Loading...</p></div></main>;
  }

  if (!role || !hasPermission(role, "audit.view_queue")) {
    return <main className="min-h-screen bg-muted/40 px-4 py-12"><div className="mx-auto max-w-4xl"><p className="text-destructive">Access denied. Auditor role required.</p></div></main>;
  }

  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

  function periodLabel(p: Period) {
    return `${months[p.month - 1]} ${p.year} — Week ${p.week} (${p.service})`;
  }

  return (
    <main className="min-h-screen bg-muted/40 px-4 py-6">
      <div className="mx-auto max-w-4xl space-y-6">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight">Auditor Dashboard</h1>
          <p className="text-sm text-muted-foreground">
            Role: <span className="font-medium">{role}</span> · {email}
          </p>
          {congregation && (
            <p className="text-sm text-muted-foreground">
              Congregation: <span className="font-medium">{congregation.name}</span> ({congregation.code})
            </p>
          )}
        </div>

        {/* Pending Audit Banner */}
        <Card className={pendingPeriods.length > 0 ? "border-orange-300 bg-orange-50/30" : ""}>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Pending Audit Queue</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold">{pendingPeriods.length}</p>
            <p className="text-sm text-muted-foreground">
              {pendingPeriods.length === 0 ? "No services waiting for review." : "service(s) waiting for your review."}
            </p>
          </CardContent>
        </Card>

        {/* Pending Review List */}
        {pendingPeriods.length > 0 && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm">Services Awaiting Review</CardTitle>
            </CardHeader>
            <CardContent className="space-y-1">
              {pendingPeriods.map(p => (
                <button
                  key={p.id}
                  onClick={() => router.push(`/audit/${p.id}`)}
                  className="w-full flex items-center justify-between px-3 py-2 rounded border text-xs hover:bg-muted transition-colors text-left"
                >
                  <div>
                    <span className="font-medium">{periodLabel(p)}</span>
                    {p.submitted_at && <span className="text-muted-foreground ml-2">submitted {new Date(p.submitted_at).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}</span>}
                  </div>
                  <Badge variant="outline" className="text-[9px] bg-orange-50 text-orange-700 border-orange-300">Pending</Badge>
                </button>
              ))}
            </CardContent>
          </Card>
        )}

        {/* Audit History */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Recent Audit History</CardTitle>
          </CardHeader>
          <CardContent>
            {approvedPeriods.length === 0 ? (
              <p className="text-xs text-muted-foreground">No audit history yet.</p>
            ) : (
              <div className="space-y-1">
                {approvedPeriods.map(p => (
                  <button
                    key={p.id}
                    onClick={() => router.push(`/audit/${p.id}`)}
                    className="w-full flex items-center justify-between px-3 py-2 rounded border text-xs hover:bg-muted transition-colors text-left"
                  >
                    <span className="font-medium">{periodLabel(p)}</span>
                    <Badge
                      variant="outline"
                      className={`text-[9px] ${p.status === "AuditApproved" ? "bg-green-50 text-green-700 border-green-300" : "bg-red-50 text-red-700 border-red-300"}`}
                    >
                      {p.status === "AuditApproved" ? "Approved" : "Rejected"}
                    </Badge>
                  </button>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
