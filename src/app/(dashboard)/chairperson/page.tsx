"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { getUserAccess, logSelfReviewException } from "@/lib/permissions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { UserHierarchyAccess } from "@/lib/types";

interface QueueItem { id: string; week: number; service: string; status: string; submitted_by: string | null; submitted_at: string | null; week_key: string | null; created_at: string; }
interface Settings { proof_mandatory: boolean; allow_chair_submit: boolean; theme_default: string; }

export default function ChairpersonDashboardPage() {
  const supabase = createClient();
  const router = useRouter();
  const [access, setAccess] = useState<UserHierarchyAccess | null>(null);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [settings, setSettings] = useState<Settings>({ proof_mandatory: false, allow_chair_submit: true, theme_default: "light" });
  const [loading, setLoading] = useState(true);
  const [processing, setProcessing] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const ua = await getUserAccess();
      if (!ua?.congregation_id) { setLoading(false); return; }
      setAccess(ua);

      // Fetch settings
      const { data: s } = await supabase.from("congregation_settings").select("*").eq("congregation_id", ua.congregation_id).maybeSingle();
      if (s) setSettings(s);

      // Fetch submitted periods (queue for chair review)
      const { data: periods } = await supabase.from("cashbook_period").select("id, week, service, status, submitted_by, submitted_at, week_key, created_at")
        .eq("congregation_id", ua.congregation_id).in("status", ["Submitted", "Draft"]).order("week", { ascending: false });
      setQueue(periods ?? []);
      setLoading(false);
    })();
  }, []);

  async function handleSubmitToOverseer(periodId: string) {
    if (!access) return;
    setProcessing(periodId);
    // Log SELF_REVIEW_EXCEPTION
    await logSelfReviewException({ userId: access.user_id, entityType: "cashbook_period", entityId: periodId, assumedRole: "Treasurer", comment: "Chairperson submitted to overseer" });
    await supabase.from("cashbook_period").update({ status: "SubmittedToHO", submitted_at: new Date().toISOString() }).eq("id", periodId);
    setProcessing(null);
    // Refresh
    const { data: periods } = await supabase.from("cashbook_period").select("id, week, service, status, submitted_by, submitted_at, week_key, created_at")
      .eq("congregation_id", access.congregation_id).in("status", ["Submitted", "Draft"]).order("week", { ascending: false });
    setQueue(periods ?? []);
  }

  async function handleSubmitOnBehalf(periodId: string) {
    if (!access) return;
    setProcessing(periodId);
    await logSelfReviewException({ userId: access.user_id, entityType: "cashbook_period", entityId: periodId, assumedRole: "Treasurer", comment: "Chairperson submitted on behalf of Treasurer (draft > 3 days)" });
    await supabase.from("cashbook_period").update({ status: "Submitted", submitted_by: access.user_id, submitted_at: new Date().toISOString() }).eq("id", periodId);
    setProcessing(null);
    const { data: periods } = await supabase.from("cashbook_period").select("id, week, service, status, submitted_by, submitted_at, week_key, created_at")
      .eq("congregation_id", access.congregation_id).in("status", ["Submitted", "Draft"]).order("week", { ascending: false });
    setQueue(periods ?? []);
  }

  if (loading) return <div className="p-6 text-sm text-muted-foreground">Loading...</div>;

  // Check if draft is older than 3 days
  const isStale = (createdAt: string) => (Date.now() - new Date(createdAt).getTime()) > 3 * 24 * 60 * 60 * 1000;

  return (
    <div className="max-w-3xl mx-auto px-4 py-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">Chairperson Dashboard</h1>
        <Badge variant="secondary" className="text-[10px]">{access?.role}</Badge>
      </div>

      {/* Queue */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">Submissions Queue</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {queue.length === 0 ? <p className="text-xs text-muted-foreground">No pending items.</p> : (
            queue.map(item => (
              <div key={item.id} className="flex items-center justify-between py-2 border-b last:border-0">
                <div>
                  <p className="text-sm font-medium">Week {item.week} · {item.service}</p>
                  <p className="text-[10px] text-muted-foreground">
                    {item.status === "Submitted" ? `Submitted ${item.submitted_at ? new Date(item.submitted_at).toLocaleDateString() : ""}` : `Draft (created ${new Date(item.created_at).toLocaleDateString()})`}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  <Badge variant={item.status === "Submitted" ? "secondary" : "outline"} className="text-[9px]">{item.status}</Badge>
                  {/* Submitted by Treasurer → Chair can review & submit to overseer */}
                  {item.status === "Submitted" && settings.allow_chair_submit && (
                    <Button size="sm" className="h-7 text-[10px]" onClick={() => handleSubmitToOverseer(item.id)} disabled={processing === item.id}>
                      {processing === item.id ? "..." : "Review & Submit"}
                    </Button>
                  )}
                  {/* Draft > 3 days → Chair can submit on behalf */}
                  {item.status === "Draft" && settings.allow_chair_submit && isStale(item.created_at) && (
                    <Button size="sm" variant="outline" className="h-7 text-[10px]" onClick={() => handleSubmitOnBehalf(item.id)} disabled={processing === item.id}>
                      {processing === item.id ? "..." : "Submit on Behalf"}
                    </Button>
                  )}
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      {/* Quick Actions */}
      <div className="grid grid-cols-2 gap-3">
        <Button variant="outline" onClick={() => router.push("/capture")}>Go to Capture</Button>
        <Button variant="outline" onClick={() => router.push("/audit")}>View Audits</Button>
      </div>
    </div>
  );
}
