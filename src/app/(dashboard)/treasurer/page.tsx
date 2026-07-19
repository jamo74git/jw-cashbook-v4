"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { getUserAccess } from "@/lib/permissions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { UserHierarchyAccess } from "@/lib/types";

interface PeriodSummary { id: string; status: string; week: number; service: string; year: number; month: number; week_key: string | null; }
interface Totals { eft: number; dd: number; cash: number; eftCount: number; ddCount: number; cashCount: number; }

export default function TreasurerDashboardPage() {
  const supabase = createClient();
  const router = useRouter();
  const [access, setAccess] = useState<UserHierarchyAccess | null>(null);
  const [periods, setPeriods] = useState<PeriodSummary[]>([]);
  const [totals, setTotals] = useState<Totals>({ eft: 0, dd: 0, cash: 0, eftCount: 0, ddCount: 0, cashCount: 0 });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const ua = await getUserAccess();
      if (!ua?.congregation_id) { setLoading(false); return; }
      setAccess(ua);

      // Get recent periods for this congregation (last 10)
      const { data: ps } = await supabase.from("cashbook_period")
        .select("id, status, week, service, year, month, week_key")
        .eq("congregation_id", ua.congregation_id)
        .order("year", { ascending: false })
        .order("month", { ascending: false })
        .order("week", { ascending: false })
        .limit(10);
      setPeriods(ps ?? []);

      // Calculate totals from the latest period
      const latest = ps?.[0];
      if (latest) {
        const { data: items } = await supabase.from("cashbook_line_item").select("item_type, amount").eq("period_id", latest.id);
        const li = items ?? [];
        setTotals({
          eft: li.filter(i => i.item_type === "EFT").reduce((s, i) => s + Number(i.amount), 0),
          dd: li.filter(i => i.item_type === "DirectDebit").reduce((s, i) => s + Number(i.amount), 0),
          cash: li.filter(i => ["Cash", "CashPending", "CashBanked"].includes(i.item_type)).reduce((s, i) => s + Number(i.amount), 0),
          eftCount: li.filter(i => i.item_type === "EFT").length,
          ddCount: li.filter(i => i.item_type === "DirectDebit").length,
          cashCount: li.filter(i => ["Cash", "CashPending", "CashBanked"].includes(i.item_type)).length,
        });
      }
      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading) return <div className="p-6 text-sm text-muted-foreground">Loading...</div>;

  const latest = periods[0] ?? null;
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

  function statusBadge(status: string) {
    switch (status) {
      case "Draft": return <Badge variant="outline" className="text-[9px]">Draft</Badge>;
      case "Submitted": return <Badge className="text-[9px] bg-orange-100 text-orange-700 border-orange-300">Pending Audit</Badge>;
      case "AuditApproved": return <Badge className="text-[9px] bg-green-100 text-green-700 border-green-300">Approved</Badge>;
      case "Rejected": return <Badge className="text-[9px] bg-red-100 text-red-700 border-red-300">Rejected</Badge>;
      case "SubmittedToOverseer": return <Badge className="text-[9px] bg-blue-100 text-blue-700 border-blue-300">Submitted to Overseer</Badge>;
      default: return <Badge variant="secondary" className="text-[9px]">{status}</Badge>;
    }
  }

  return (
    <div className="max-w-3xl mx-auto px-4 py-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">Treasurer Dashboard</h1>
        <Badge variant="secondary" className="text-[10px]">{access?.role}</Badge>
      </div>

      {/* Current Period Status */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">Latest Period</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          {latest ? (
            <>
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">{months[(latest.month ?? 1) - 1]} {latest.year} — Week {latest.week} · {latest.service}</span>
                {statusBadge(latest.status)}
              </div>
              {latest.status === "Draft" && <Button size="sm" onClick={() => router.push("/capture")}>Continue Capturing</Button>}
              {latest.status === "Submitted" && <p className="text-xs text-muted-foreground">Submitted for audit. Awaiting auditor review.</p>}
              {latest.status === "AuditApproved" && <p className="text-xs text-green-700 font-medium">This period has been approved by the auditor. You can start capturing the next service.</p>}
              {latest.status === "Rejected" && (
                <div className="space-y-1">
                  <p className="text-xs text-red-700 font-medium">Rejected by auditor. Please review comments and correct.</p>
                  <Button size="sm" variant="destructive" onClick={() => router.push("/capture")}>Review & Correct</Button>
                </div>
              )}
            </>
          ) : (
            <p className="text-xs text-muted-foreground">No capture started. Go to Capture to begin.</p>
          )}
        </CardContent>
      </Card>

      {/* Stat Cards for latest period */}
      {latest && (
        <div className="grid grid-cols-3 gap-3">
          <Card className="bg-blue-50 border-blue-200">
            <CardContent className="py-3 text-center">
              <p className="text-[10px] uppercase text-blue-600 font-medium">EFT</p>
              <p className="text-lg font-bold text-blue-900">R{totals.eft.toFixed(2)}</p>
              <p className="text-[10px] text-blue-500">{totals.eftCount} entries</p>
            </CardContent>
          </Card>
          <Card className="bg-blue-50 border-blue-200">
            <CardContent className="py-3 text-center">
              <p className="text-[10px] uppercase text-blue-600 font-medium">Direct Debit</p>
              <p className="text-lg font-bold text-blue-900">R{totals.dd.toFixed(2)}</p>
              <p className="text-[10px] text-blue-500">{totals.ddCount} entries</p>
            </CardContent>
          </Card>
          <Card className="bg-blue-50 border-blue-200">
            <CardContent className="py-3 text-center">
              <p className="text-[10px] uppercase text-blue-600 font-medium">Cash</p>
              <p className="text-lg font-bold text-blue-900">R{totals.cash.toFixed(2)}</p>
              <p className="text-[10px] text-blue-500">{totals.cashCount} entries</p>
            </CardContent>
          </Card>
        </div>
      )}

      {/* Recent Periods */}
      {periods.length > 1 && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Recent Services</CardTitle></CardHeader>
          <CardContent className="space-y-1">
            {periods.slice(0, 8).map(p => (
              <div key={p.id} className="flex items-center justify-between py-1.5 border-b last:border-0 text-xs">
                <span>{months[(p.month ?? 1) - 1]} {p.year} — Wk {p.week} ({p.service})</span>
                {statusBadge(p.status)}
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Go to Capture */}
      <Button className="w-full" onClick={() => router.push("/capture")}>Go to Capture</Button>
    </div>
  );
}
