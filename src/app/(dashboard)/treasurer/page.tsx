"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { getUserAccess } from "@/lib/permissions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { UserHierarchyAccess } from "@/lib/types";

interface PeriodSummary { id: string; status: string; week: number; service: string; week_key: string | null; }
interface Totals { eft: number; dd: number; cash: number; eftCount: number; ddCount: number; cashCount: number; }

export default function TreasurerDashboardPage() {
  const supabase = createClient();
  const router = useRouter();
  const [access, setAccess] = useState<UserHierarchyAccess | null>(null);
  const [period, setPeriod] = useState<PeriodSummary | null>(null);
  const [totals, setTotals] = useState<Totals>({ eft: 0, dd: 0, cash: 0, eftCount: 0, ddCount: 0, cashCount: 0 });
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      const ua = await getUserAccess();
      if (!ua?.congregation_id) { setLoading(false); return; }
      setAccess(ua);

      // Get latest period for this congregation
      const { data: p } = await supabase.from("cashbook_period").select("id, status, week, service, week_key")
        .eq("congregation_id", ua.congregation_id).order("year", { ascending: false }).order("month", { ascending: false }).order("week", { ascending: false }).limit(1).maybeSingle();
      setPeriod(p);

      if (p) {
        const { data: items } = await supabase.from("cashbook_line_item").select("item_type, amount").eq("period_id", p.id);
        const li = items ?? [];
        setTotals({
          eft: li.filter(i => i.item_type === "EFT").reduce((s, i) => s + Number(i.amount), 0),
          dd: li.filter(i => i.item_type === "DirectDeposit").reduce((s, i) => s + Number(i.amount), 0),
          cash: li.filter(i => ["Cash", "CashPending", "CashBanked"].includes(i.item_type)).reduce((s, i) => s + Number(i.amount), 0),
          eftCount: li.filter(i => i.item_type === "EFT").length,
          ddCount: li.filter(i => i.item_type === "DirectDeposit").length,
          cashCount: li.filter(i => ["Cash", "CashPending", "CashBanked"].includes(i.item_type)).length,
        });
      }
      setLoading(false);
    })();
  }, []);

  if (loading) return <div className="p-6 text-sm text-muted-foreground">Loading...</div>;

  const isDraft = period?.status === "Draft";
  const isSubmitted = period?.status === "Submitted";

  return (
    <div className="max-w-3xl mx-auto px-4 py-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold">Treasurer Dashboard</h1>
        <Badge variant="secondary" className="text-[10px]">{access?.role}</Badge>
      </div>

      {/* Status Card */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">Current Period</CardTitle></CardHeader>
        <CardContent className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">Week {period?.week ?? "—"} · {period?.service ?? "AM"}</span>
            <Badge variant={isDraft ? "outline" : isSubmitted ? "secondary" : "default"} className="text-[10px]">{period?.status ?? "No period"}</Badge>
          </div>
          {isDraft && <Button size="sm" onClick={() => router.push("/capture")}>Continue Capturing</Button>}
          {isSubmitted && <p className="text-xs text-muted-foreground">Submitted for Audit. Awaiting Chair/Auditor review.</p>}
          {!period && <p className="text-xs text-muted-foreground">No capture started. Go to Capture to begin.</p>}
        </CardContent>
      </Card>

      {/* Stat Cards */}
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
            <p className="text-[10px] uppercase text-blue-600 font-medium">Direct Deposit</p>
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

      {/* To-Do */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">To-Do</CardTitle></CardHeader>
        <CardContent className="space-y-2 text-xs">
          <div className="flex items-center justify-between py-1 border-b"><span>Capture AM</span>{isDraft ? <Badge variant="outline" className="text-[9px]">In Progress</Badge> : <span className="text-green-600">✓</span>}</div>
          <div className="flex items-center justify-between py-1 border-b"><span>Capture PM</span><Badge variant="outline" className="text-[9px]">Pending</Badge></div>
          {totals.cash > 0 && <div className="flex items-center justify-between py-1"><span>Bank Cash R{totals.cash.toFixed(2)}</span><Badge variant="outline" className="text-[9px]">Upload Slip</Badge></div>}
        </CardContent>
      </Card>

      {/* Go to Capture */}
      <Button className="w-full" onClick={() => router.push("/capture")}>Go to Capture</Button>
    </div>
  );
}
