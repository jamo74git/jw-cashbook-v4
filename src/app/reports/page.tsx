"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { getUserAccess, hasPermission } from "@/lib/permissions";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import type { Role, UserHierarchyAccess, VCashbookMonth, VCensusHealth } from "@/lib/types";

export default function ReportsPage() {
  const supabase = createClient();

  const [access, setAccess] = useState<UserHierarchyAccess | null>(null);
  const [monthData, setMonthData] = useState<VCashbookMonth[]>([]);
  const [censusData, setCensusData] = useState<VCensusHealth[]>([]);
  const [loading, setLoading] = useState(true);
  const [year, setYear] = useState(new Date().getFullYear());

  const role = access?.role as Role | undefined;

  useEffect(() => { loadData(); }, [year]);

  async function loadData() {
    setLoading(true);
    const userAccess = await getUserAccess();
    if (!userAccess) { setLoading(false); return; }
    setAccess(userAccess);

    // Fetch monthly cashbook view
    const { data: months } = await supabase
      .from("v_cashbook_month")
      .select("*")
      .eq("year", year)
      .order("month");
    setMonthData((months as VCashbookMonth[]) ?? []);

    // Fetch census health
    const { data: census } = await supabase
      .from("v_census_health")
      .select("*")
      .eq("year", year);
    setCensusData((census as VCensusHealth[]) ?? []);

    setLoading(false);
  }

  // ── Export Helpers ─────────────────────────────────────────────────────────
  function exportPDF() {
    // PDF export — all roles with reports.export_pdf permission
    const content = monthData.map((m) =>
      `${m.congregation_name} (${m.congregation_code}) — ${m.year}/${String(m.month).padStart(2, "0")}: Income R${m.month_income.toFixed(2)}, Expenses R${m.month_expenses.toFixed(2)}, Services: ${m.service_count}`
    ).join("\n");

    const blob = new Blob([`OAC Management System — Report ${year}\n\n${content}`], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `oac_report_${year}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function exportCSV() {
    const header = "Congregation,Code,Year,Month,Income,Expenses,Members,Officers,Services,Approved";
    const rows = monthData.map((m) =>
      `"${m.congregation_name}","${m.congregation_code}",${m.year},${m.month},${m.month_income},${m.month_expenses},${m.month_members},${m.month_officers},${m.service_count},${m.approved_count}`
    );
    const csv = [header, ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `oac_report_${year}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function exportExcel() {
    // For now, export as CSV with .xls extension (proper xlsx would need a lib)
    const header = "Congregation\tCode\tYear\tMonth\tIncome\tExpenses\tMembers\tOfficers";
    const rows = monthData.map((m) =>
      `${m.congregation_name}\t${m.congregation_code}\t${m.year}\t${m.month}\t${m.month_income}\t${m.month_expenses}\t${m.month_members}\t${m.month_officers}`
    );
    const tsv = [header, ...rows].join("\n");
    const blob = new Blob([tsv], { type: "application/vnd.ms-excel" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `oac_report_${year}.xls`;
    a.click();
    URL.revokeObjectURL(url);
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <main className="min-h-screen bg-muted/40 px-4 py-12">
        <div className="mx-auto max-w-4xl"><p className="text-muted-foreground">Loading reports...</p></div>
      </main>
    );
  }

  if (!role) {
    return (
      <main className="min-h-screen bg-muted/40 px-4 py-12">
        <div className="mx-auto max-w-4xl"><p className="text-destructive">Access denied.</p></div>
      </main>
    );
  }

  const canExportPDF = hasPermission(role, "reports.export_pdf");
  const canExportExcel = hasPermission(role, "reports.export_excel");
  const canExportCSV = hasPermission(role, "reports.export_csv");

  return (
    <main className="min-h-screen bg-muted/40 px-4 py-6">
      <div className="mx-auto max-w-4xl space-y-6">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight">Reports & Analytics</h1>
          <p className="text-sm text-muted-foreground">Role: {role} · Year: {year}</p>
        </div>

        {/* Year Selector */}
        <div>
          <Label className="text-xs">Year</Label>
          <select
            className="flex h-9 w-24 rounded-md border border-input bg-background px-2 py-1 text-sm"
            value={year} onChange={(e) => setYear(parseInt(e.target.value))}
          >
            {[2024, 2025, 2026, 2027].map((y) => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>

        {/* Export Buttons — gated by permission */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Export Options</CardTitle>
            <CardDescription>
              {role === "Secretary"
                ? "Secretary access: PDF export only per governance rules."
                : "Export data in your preferred format."}
            </CardDescription>
          </CardHeader>
          <CardContent className="flex gap-3 flex-wrap">
            {canExportPDF && (
              <Button variant="outline" size="sm" onClick={exportPDF}>Export PDF</Button>
            )}
            {canExportExcel && (
              <Button variant="outline" size="sm" onClick={exportExcel}>Export Excel</Button>
            )}
            {canExportCSV && (
              <Button variant="outline" size="sm" onClick={exportCSV}>Export CSV</Button>
            )}
            {!canExportPDF && !canExportExcel && !canExportCSV && (
              <p className="text-sm text-muted-foreground">No export permissions for your role.</p>
            )}
          </CardContent>
        </Card>

        {/* Monthly Summary Table */}
        <Card>
          <CardHeader><CardTitle className="text-base">Monthly Cashbook Summary</CardTitle></CardHeader>
          <CardContent>
            {monthData.length === 0 ? (
              <p className="text-sm text-muted-foreground">No data for {year}.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b text-left text-xs text-muted-foreground">
                      <th className="pb-2">Congregation</th>
                      <th className="pb-2">Month</th>
                      <th className="pb-2 text-right">Income</th>
                      <th className="pb-2 text-right">Expenses</th>
                      <th className="pb-2 text-right">Services</th>
                      <th className="pb-2 text-center">All Approved</th>
                    </tr>
                  </thead>
                  <tbody>
                    {monthData.map((m, i) => (
                      <tr key={i} className="border-b last:border-0">
                        <td className="py-2">{m.congregation_name}</td>
                        <td className="py-2">{String(m.month).padStart(2, "0")}</td>
                        <td className="py-2 text-right">R{m.month_income.toFixed(2)}</td>
                        <td className="py-2 text-right">R{m.month_expenses.toFixed(2)}</td>
                        <td className="py-2 text-right">{m.service_count}</td>
                        <td className="py-2 text-center">
                          <span className={`inline-block h-2.5 w-2.5 rounded-full ${m.all_approved ? "bg-green-500" : "bg-orange-400"}`} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Census Health Summary */}
        <Card>
          <CardHeader><CardTitle className="text-base">Census Health</CardTitle></CardHeader>
          <CardContent>
            {censusData.length === 0 ? (
              <p className="text-sm text-muted-foreground">No census data for {year}.</p>
            ) : (
              <div className="space-y-2 max-h-64 overflow-y-auto">
                {censusData.map((c, i) => (
                  <div key={i} className="flex items-center justify-between py-1 border-b last:border-0 text-sm">
                    <div>
                      <span className="font-medium">{c.priest_name}</span>
                      <span className="ml-2 text-xs text-muted-foreground">{c.congregation_name}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs">{c.total_members} members</span>
                      <span className={`inline-block h-2.5 w-2.5 rounded-full ${
                        c.staleness_flag === "GREEN" ? "bg-green-500" :
                        c.staleness_flag === "ORANGE" ? "bg-orange-500" : "bg-red-500"
                      }`} />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
