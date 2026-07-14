"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { getUserAccess, hasPermission, logAuditAction } from "@/lib/permissions";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import type { Role, UserHierarchyAccess } from "@/lib/types";

interface ServiceCheck {
  id: string;
  week: number;
  service_type: string;
  status: string;
  isApproved: boolean;
}

export default function MonthlyClosePage() {
  const supabase = createClient();

  const [access, setAccess] = useState<UserHierarchyAccess | null>(null);
  const [services, setServices] = useState<ServiceCheck[]>([]);
  const [year, setYear] = useState(new Date().getFullYear());
  const [month, setMonth] = useState(new Date().getMonth() + 1);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const role = access?.role as Role | undefined;

  useEffect(() => {
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [year, month]);

  async function loadData() {
    setLoading(true);
    setError(null);
    setSuccess(false);

    const userAccess = await getUserAccess();
    if (!userAccess) { setLoading(false); return; }
    setAccess(userAccess);

    if (!userAccess.congregation_id) { setLoading(false); return; }

    const { data } = await supabase
      .from("cashbook_service")
      .select("id, week, service_type, status")
      .eq("congregation_id", userAccess.congregation_id)
      .eq("year", year)
      .eq("month", month)
      .order("week")
      .order("service_type");

    const checks: ServiceCheck[] = (data ?? []).map((s) => ({
      ...s,
      isApproved: s.status === "AuditApproved",
    }));
    setServices(checks);
    setLoading(false);
  }

  const allApproved = services.length > 0 && services.every((s) => s.isApproved);
  const canSubmit = role ? hasPermission(role, "month.submit_to_overseer") : false;

  async function handleSubmitToOverseer() {
    if (!access || !canSubmit || !allApproved) return;

    setSubmitting(true);
    setError(null);

    // Update all services for this month to SubmittedToOverseer
    const { error: updateError } = await supabase
      .from("cashbook_service")
      .update({ status: "SubmittedToOverseer" })
      .eq("congregation_id", access.congregation_id)
      .eq("year", year)
      .eq("month", month)
      .eq("status", "AuditApproved");

    if (updateError) {
      setError(updateError.message);
      setSubmitting(false);
      return;
    }

    // Audit log
    await logAuditAction({
      userId: access.user_id,
      actionType: "MONTH_SUBMIT",
      entityType: "monthly_close",
      entityId: `${access.congregation_id}_${year}_${month}`,
      comment: `Month ${year}/${String(month).padStart(2, "0")} submitted to Overseer`,
      metadata: { year, month, congregation_id: access.congregation_id },
    });

    setSubmitting(false);
    setSuccess(true);
    await loadData();
  }

  if (loading) {
    return (
      <main className="min-h-screen bg-muted/40 px-4 py-12">
        <div className="mx-auto max-w-3xl">
          <p className="text-muted-foreground">Loading monthly close...</p>
        </div>
      </main>
    );
  }

  if (!role || !hasPermission(role, "month.view")) {
    return (
      <main className="min-h-screen bg-muted/40 px-4 py-12">
        <div className="mx-auto max-w-3xl">
          <p className="text-destructive">Access denied.</p>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-muted/40 px-4 py-6">
      <div className="mx-auto max-w-3xl space-y-6">
        {/* Header */}
        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight">Monthly Close</h1>
          <p className="text-sm text-muted-foreground">
            {year}/{String(month).padStart(2, "0")} — Submit all approved services to Overseer
          </p>
        </div>

        {/* Month Selector */}
        <div className="flex gap-3 items-end">
          <div>
            <label className="text-xs text-muted-foreground">Year</label>
            <select
              className="flex h-9 w-24 rounded-md border border-input bg-background px-2 py-1 text-sm"
              value={year}
              onChange={(e) => setYear(parseInt(e.target.value))}
            >
              {[2024, 2025, 2026, 2027].map((y) => (
                <option key={y} value={y}>{y}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Month</label>
            <select
              className="flex h-9 w-24 rounded-md border border-input bg-background px-2 py-1 text-sm"
              value={month}
              onChange={(e) => setMonth(parseInt(e.target.value))}
            >
              {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                <option key={m} value={m}>{String(m).padStart(2, "0")}</option>
              ))}
            </select>
          </div>
        </div>

        {/* Service Checklist */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Service Approval Checklist</CardTitle>
            <CardDescription>
              All services must be Audit Approved before submitting the month.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {services.length === 0 ? (
              <p className="text-sm text-muted-foreground">No services found for this month.</p>
            ) : (
              <div className="space-y-2">
                {services.map((s) => (
                  <div key={s.id} className="flex items-center justify-between py-2 border-b last:border-0">
                    <span className="text-sm">
                      Week {s.week} — {s.service_type}
                    </span>
                    <div className="flex items-center gap-2">
                      <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                        s.isApproved
                          ? "bg-green-100 text-green-800"
                          : "bg-orange-100 text-orange-800"
                      }`}>
                        {s.status}
                      </span>
                      <span className={`inline-block h-3 w-3 rounded-full ${
                        s.isApproved ? "bg-green-500" : "bg-orange-400"
                      }`} />
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>

        {/* Status Summary */}
        <div className={`rounded-md border p-4 ${
          allApproved
            ? "border-green-300 bg-green-50 text-green-800"
            : "border-orange-300 bg-orange-50 text-orange-800"
        }`}>
          <p className="text-sm font-medium">
            {allApproved
              ? `All ${services.length} services approved. Ready to submit to Overseer.`
              : `${services.filter((s) => s.isApproved).length}/${services.length} services approved. All must be approved before submission.`}
          </p>
        </div>

        {/* Submit Button */}
        {canSubmit && (
          <div className="space-y-2">
            {error && <p className="text-sm text-destructive">{error}</p>}
            {success && <p className="text-sm text-green-600">Month successfully submitted to Overseer.</p>}
            <Button
              onClick={handleSubmitToOverseer}
              disabled={!allApproved || submitting}
              className="w-full sm:w-auto"
            >
              {submitting ? "Submitting..." : "Submit Month to Overseer"}
            </Button>
          </div>
        )}
      </div>
    </main>
  );
}
