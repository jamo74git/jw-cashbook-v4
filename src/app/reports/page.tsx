"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { getUserAccess, hasPermission, isTotalsOnly } from "@/lib/permissions";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import type { Role, UserHierarchyAccess } from "@/lib/types";

export default function ReportsDashboard() {
  const supabase = createClient();
  const [access, setAccess] = useState<UserHierarchyAccess | null>(null);
  const [email, setEmail] = useState<string>("");
  const [loading, setLoading] = useState(true);

  const role = access?.role as Role | undefined;

  useEffect(() => {
    (async () => {
      const userAccess = await getUserAccess();
      if (!userAccess) { setLoading(false); return; }
      setAccess(userAccess);

      const { data: { user } } = await supabase.auth.getUser();
      setEmail(user?.email ?? "");
      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (loading) {
    return <main className="min-h-screen bg-muted/40 px-4 py-12"><div className="mx-auto max-w-4xl"><p className="text-muted-foreground">Loading...</p></div></main>;
  }

  if (!role) {
    return <main className="min-h-screen bg-muted/40 px-4 py-12"><div className="mx-auto max-w-4xl"><p className="text-destructive">Access denied.</p></div></main>;
  }

  const isSecretary = role === "Secretary";
  const totalsOnly = isSecretary && isTotalsOnly(role, "capture.view");
  const canExportPDF = hasPermission(role, "reports.export_pdf");
  const canExportExcel = hasPermission(role, "reports.export_excel");
  const canExportCSV = hasPermission(role, "reports.export_csv");

  return (
    <main className="min-h-screen bg-muted/40 px-4 py-6">
      <div className="mx-auto max-w-4xl space-y-6">
        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight">
            {isSecretary ? "Secretary Reports" : "Reports & Analytics"}
          </h1>
          <p className="text-sm text-muted-foreground">
            Role: <span className="font-medium">{role}</span> · {email}
          </p>
          {totalsOnly && (
            <p className="text-xs text-orange-700">
              View access: Totals only. Line item detail and proof images are restricted.
            </p>
          )}
        </div>

        {/* Secretary restriction notice */}
        {isSecretary && (
          <Card className="border-blue-200 bg-blue-50">
            <CardContent className="py-4">
              <p className="text-sm text-blue-800">
                Secretary access: PDF export only. Excel and CSV exports are restricted per governance rules.
                No access to proof images or line item detail.
              </p>
            </CardContent>
          </Card>
        )}

        {/* Export Options */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Available Exports</CardTitle>
            <CardDescription>Export congregation reports for meetings and records.</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-3">
              {canExportPDF && (
                <span className="inline-flex items-center rounded-full bg-green-100 px-3 py-1 text-xs font-medium text-green-800">
                  PDF Export
                </span>
              )}
              {canExportExcel && (
                <span className="inline-flex items-center rounded-full bg-green-100 px-3 py-1 text-xs font-medium text-green-800">
                  Excel Export
                </span>
              )}
              {canExportCSV && (
                <span className="inline-flex items-center rounded-full bg-green-100 px-3 py-1 text-xs font-medium text-green-800">
                  CSV Export
                </span>
              )}
              {!canExportPDF && !canExportExcel && !canExportCSV && (
                <p className="text-sm text-muted-foreground">No export permissions available.</p>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Report Types */}
        <div className="grid gap-4 sm:grid-cols-2">
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">Monthly Cashbook Summary</CardTitle></CardHeader>
            <CardContent><CardDescription>Congregation-level totals: income, expenses, banking by month.</CardDescription></CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-base">Audit Status Report</CardTitle></CardHeader>
            <CardContent><CardDescription>Approval status of all services for the period.</CardDescription></CardContent>
          </Card>
          {!isSecretary && (
            <>
              <Card>
                <CardHeader className="pb-2"><CardTitle className="text-base">Expense Detail</CardTitle></CardHeader>
                <CardContent><CardDescription>Full expense breakdown with receipts and governance flags.</CardDescription></CardContent>
              </Card>
              <Card>
                <CardHeader className="pb-2"><CardTitle className="text-base">Census Report</CardTitle></CardHeader>
                <CardContent><CardDescription>Priestship health with staleness indicators.</CardDescription></CardContent>
              </Card>
            </>
          )}
        </div>

        <p className="text-xs text-muted-foreground text-center">Coming Soon — Report generation and export</p>
      </div>
    </main>
  );
}
