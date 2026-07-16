"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { getUserAccess } from "@/lib/permissions";
import { AppHeader } from "@/components/AppHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { UserHierarchyAccess } from "@/lib/types";

interface CongRow { id: string; name: string; code: string; periodStatus: string | null; pendingCount: number; periodId: string | null; }
interface Settings { expense_approval_threshold: number; }

export default function ElderPage() {
  const supabase = createClient();
  const [access, setAccess] = useState<UserHierarchyAccess | null>(null);
  const [congregations, setCongregations] = useState<CongRow[]>([]);
  const [settings, setSettings] = useState<Settings>({ expense_approval_threshold: 500 });
  const [expensesPending, setExpensesPending] = useState(0);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const ua = await getUserAccess();
      if (!ua) { setLoading(false); return; }
      setAccess(ua);

      // Get congregations under this Eldership
      const { data: congs } = await supabase.from("congregations").select("id, name, code").eq("eldership_id", ua.hierarchy_id);
      const congList = congs ?? [];
      const congIds = congList.map(c => c.id);

      // Get latest period per congregation
      const rows: CongRow[] = [];
      for (const c of congList) {
        const { data: period } = await supabase.from("cashbook_period").select("id, status")
          .eq("congregation_id", c.id).order("year", { ascending: false }).order("month", { ascending: false }).order("week", { ascending: false }).limit(1).maybeSingle();
        // Count pending items (submitted periods needing review)
        const { count } = await supabase.from("cashbook_period").select("id", { count: "exact", head: true })
          .eq("congregation_id", c.id).eq("status", "Submitted");
        rows.push({ id: c.id, name: c.name, code: c.code, periodStatus: period?.status ?? null, pendingCount: count ?? 0, periodId: period?.id ?? null });
      }
      setCongregations(rows);

      // Get settings (use first congregation's settings)
      if (congIds.length > 0) {
        const { data: s } = await supabase.from("congregation_settings").select("expense_approval_threshold").eq("congregation_id", congIds[0]).maybeSingle();
        if (s) setSettings(s);
      }

      // Count expenses above threshold awaiting approval
      if (congIds.length > 0) {
        const { count: expCount } = await supabase.from("cashbook_line_item").select("id", { count: "exact", head: true })
          .eq("item_type", "Expense").eq("approved", false).gt("amount", settings.expense_approval_threshold).in("period_id",
            (await supabase.from("cashbook_period").select("id").in("congregation_id", congIds)).data?.map((p: { id: string }) => p.id) ?? []
          );
        setExpensesPending(expCount ?? 0);
      }

      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Submit all approved to Overseer
  async function handleSubmitToOverseer() {
    if (!access) return;
    setSubmitting(true);
    const congIds = congregations.map(c => c.id);
    // Update all Submitted periods to SubmittedToHO
    await supabase.from("cashbook_period").update({ status: "SubmittedToHO" })
      .in("congregation_id", congIds).eq("status", "Submitted");
    setSuccess("All approved congregations submitted to Overseer.");
    setSubmitting(false);
    // Refresh
    window.location.reload();
  }

  const readyCount = congregations.filter(c => c.periodStatus !== "Draft" && c.periodStatus !== null).length;
  const allReady = readyCount === congregations.length && congregations.length > 0;

  if (loading) return <><AppHeader /><div className="p-6 text-sm text-muted-foreground">Loading...</div></>;

  return (
    <>
      <AppHeader />
      <div className="max-w-4xl mx-auto px-4 py-6 space-y-6">
        <h1 className="text-xl font-bold">Elder Dashboard</h1>

        {success && <div className="rounded border border-green-300 bg-green-50 p-2 text-xs text-green-800">{success}</div>}

        {/* My Congregations */}
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">My Congregations</CardTitle></CardHeader>
          <CardContent>
            <table className="w-full text-xs">
              <thead><tr className="border-b text-left text-muted-foreground">
                <th className="pb-2">Congregation</th><th className="pb-2">Code</th><th className="pb-2">Status</th><th className="pb-2">Pending</th><th className="pb-2">Action</th>
              </tr></thead>
              <tbody>
                {congregations.map(c => (
                  <tr key={c.id} className="border-b last:border-0">
                    <td className="py-2 font-medium">{c.name}</td>
                    <td className="py-2">{c.code}</td>
                    <td className="py-2"><Badge variant={c.periodStatus === "Draft" ? "outline" : c.periodStatus === "Submitted" ? "secondary" : "default"} className="text-[9px]">{c.periodStatus ?? "None"}</Badge></td>
                    <td className="py-2">{c.pendingCount > 0 ? <span className="text-orange-600 font-medium">{c.pendingCount}</span> : "0"}</td>
                    <td className="py-2">
                      {c.periodStatus === "Draft" && <Button size="sm" className="h-6 text-[10px]" onClick={async () => {
                        if (!c.periodId) return;
                        await supabase.from("cashbook_period").update({ status: "Submitted", submitted_at: new Date().toISOString() }).eq("id", c.periodId);
                        window.location.reload();
                      }}>Submit for Audit</Button>}
                      {c.periodStatus === "Submitted" && <Button size="sm" variant="outline" className="h-6 text-[10px]">View Details</Button>}
                      {c.periodStatus === "AuditApproved" && <Badge variant="default" className="text-[9px]">Done</Badge>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>

        {/* Monthly Close */}
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Monthly Close</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs text-muted-foreground">{readyCount} of {congregations.length} congregations ready to submit</p>
            <Button size="sm" onClick={handleSubmitToOverseer} disabled={!allReady || submitting}>
              {submitting ? "Submitting..." : "Submit All Approved to Overseer"}
            </Button>
            {!allReady && <p className="text-[10px] text-muted-foreground">All congregations must be past Draft status before submitting to Overseer.</p>}
          </CardContent>
        </Card>

        {/* Expense Governance */}
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Expense Governance</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <p className="text-xs">
              <span className="font-medium text-orange-600">{expensesPending}</span> expenses &gt; R{settings.expense_approval_threshold} awaiting approval
            </p>
            {expensesPending > 0 && <Button size="sm" variant="outline">Review Expenses</Button>}
            {expensesPending === 0 && <p className="text-[10px] text-muted-foreground">No expenses requiring approval.</p>}
          </CardContent>
        </Card>

        {/* Outstanding Audits */}
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Outstanding Audits</CardTitle></CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground">
              {congregations.reduce((s, c) => s + c.pendingCount, 0)} services pending audit across your eldership.
            </p>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
