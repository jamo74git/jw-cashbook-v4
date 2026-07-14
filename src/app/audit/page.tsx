"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { getUserAccess, hasPermission } from "@/lib/permissions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import type { Role, UserHierarchyAccess } from "@/lib/types";

interface AuditQueueItem {
  id: string;
  congregation_id: string;
  year: number;
  month: number;
  week: number;
  service_type: string;
  service_date: string;
  status: string;
  submitted_at: string | null;
}

export default function AuditQueuePage() {
  const router = useRouter();
  const supabase = createClient();

  const [access, setAccess] = useState<UserHierarchyAccess | null>(null);
  const [queue, setQueue] = useState<AuditQueueItem[]>([]);
  const [loading, setLoading] = useState(true);

  const role = access?.role as Role | undefined;

  useEffect(() => {
    loadQueue();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadQueue() {
    setLoading(true);

    const userAccess = await getUserAccess();
    if (!userAccess) { setLoading(false); return; }
    setAccess(userAccess);

    // Permission gate
    if (!hasPermission(userAccess.role as Role, "audit.view_queue")) {
      setLoading(false);
      return;
    }

    // Fetch PendingAudit services for user's congregation
    let query = supabase
      .from("cashbook_service")
      .select("id, congregation_id, year, month, week, service_type, service_date, status, submitted_at")
      .eq("status", "PendingAudit")
      .order("submitted_at", { ascending: true });

    // Scope to congregation for Auditor/Chairperson/Elder
    if (userAccess.congregation_id) {
      query = query.eq("congregation_id", userAccess.congregation_id);
    }

    const { data } = await query;
    setQueue(data ?? []);
    setLoading(false);
  }

  if (loading) {
    return (
      <main className="min-h-screen bg-muted/40 px-4 py-12">
        <div className="mx-auto max-w-3xl">
          <p className="text-muted-foreground">Loading audit queue...</p>
        </div>
      </main>
    );
  }

  if (!role || !hasPermission(role, "audit.view_queue")) {
    return (
      <main className="min-h-screen bg-muted/40 px-4 py-12">
        <div className="mx-auto max-w-3xl">
          <p className="text-destructive">You do not have access to the audit queue.</p>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-muted/40 px-4 py-6">
      <div className="mx-auto max-w-3xl space-y-6">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight">Audit Queue</h1>
          <p className="text-sm text-muted-foreground">
            {queue.length} service(s) pending audit review
          </p>
        </div>

        {queue.length === 0 ? (
          <Card>
            <CardContent className="py-8 text-center">
              <p className="text-muted-foreground">No services pending audit.</p>
            </CardContent>
          </Card>
        ) : (
          <div className="space-y-3">
            {queue.map((item) => (
              <Card key={item.id} className="cursor-pointer hover:border-primary/50 transition-colors">
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <CardTitle className="text-base">
                      Week {item.week} — {item.service_type}
                    </CardTitle>
                    <span className="text-xs bg-orange-100 text-orange-800 px-2 py-1 rounded-full font-medium">
                      Pending Audit
                    </span>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="flex items-center justify-between">
                    <div className="space-y-1">
                      <p className="text-sm">
                        {item.service_date} · {item.year}/{String(item.month).padStart(2, "0")}
                      </p>
                      {item.submitted_at && (
                        <p className="text-xs text-muted-foreground">
                          Submitted: {new Date(item.submitted_at).toLocaleDateString()}
                        </p>
                      )}
                    </div>
                    <Button
                      size="sm"
                      onClick={() => router.push(`/audit/${item.id}`)}
                    >
                      Review
                    </Button>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </main>
  );
}
