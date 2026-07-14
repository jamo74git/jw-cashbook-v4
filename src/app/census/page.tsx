"use client";

import { useEffect, useState, useCallback } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  getUserAccess,
  hasPermission,
  logAuditAction,
} from "@/lib/permissions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import type { Role, UserHierarchyAccess } from "@/lib/types";

// ─── Types ──────────────────────────────────────────────────────────────────

interface CensusRow {
  id: string;
  priest_id: string;
  officer_code: string;
  priest_name: string;
  eligible_to_tithe: number;
  children: number;
  youth: number;
  adults: number;
  seniors: number;
  total_members: number;
  updated_at: string | null;
  locked: boolean;
  staleness_flag: "GREEN" | "ORANGE" | "RED";
}

interface CensusFormData {
  eligible_to_tithe: number;
  children: number;
  youth: number;
  adults: number;
  seniors: number;
}

// ─── Staleness Helpers ──────────────────────────────────────────────────────

function stalenessColor(flag: string): string {
  if (flag === "GREEN") return "bg-green-500";
  if (flag === "ORANGE") return "bg-orange-500";
  return "bg-red-500";
}

function stalenessLabel(flag: string): string {
  if (flag === "GREEN") return "Current";
  if (flag === "ORANGE") return "90+ days — Review soon";
  return "180+ days — Stale";
}

// ─── Main Component ─────────────────────────────────────────────────────────

export default function CensusPage() {
  const supabase = createClient();

  const [access, setAccess] = useState<UserHierarchyAccess | null>(null);
  const [censusRows, setCensusRows] = useState<CensusRow[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<CensusFormData>({
    eligible_to_tithe: 0, children: 0, youth: 0, adults: 0, seniors: 0,
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);

  const role = access?.role as Role | undefined;
  const now = new Date();
  const [year] = useState(now.getFullYear());
  const [month] = useState(now.getMonth() + 1);

  const loadData = useCallback(async () => {
    setLoading(true);
    setError(null);

    const userAccess = await getUserAccess();
    if (!userAccess) { setLoading(false); return; }
    setAccess(userAccess);

    const userRole = userAccess.role as Role;

    // Secretary = NO ACCESS
    if (userRole === "Secretary") {
      setError("Census access is restricted. Secretary role does not have access.");
      setLoading(false);
      return;
    }

    // Must have view permission
    if (!hasPermission(userRole, "census.view")) {
      setError("You do not have permission to view census data.");
      setLoading(false);
      return;
    }

    if (!userAccess.congregation_id) {
      setError("No congregation assigned to your profile.");
      setLoading(false);
      return;
    }

    // Fetch from v_census_health view (scoped by congregation + current year/month)
    const { data, error: fetchError } = await supabase
      .from("v_census_health")
      .select("*")
      .eq("congregation_id", userAccess.congregation_id)
      .eq("year", year)
      .eq("month", month);

    if (fetchError) {
      setError(fetchError.message);
      setLoading(false);
      return;
    }

    // If no data for current month, fetch priests and show empty forms
    if (!data || data.length === 0) {
      // Fetch officers (priests) for the congregation
      const { data: officers } = await supabase
        .from("officers")
        .select("id, officer_code, first_name, last_name")
        .eq("congregation_id", userAccess.congregation_id)
        .eq("is_active", true)
        .in("rank", ["Priest", "Underdeacon"]);

      const emptyRows: CensusRow[] = (officers ?? []).map((o) => ({
        id: "",
        priest_id: o.id,
        officer_code: o.officer_code,
        priest_name: `${o.first_name} ${o.last_name}`,
        eligible_to_tithe: 0,
        children: 0,
        youth: 0,
        adults: 0,
        seniors: 0,
        total_members: 0,
        updated_at: null,
        locked: false,
        staleness_flag: "RED" as const,
      }));
      setCensusRows(emptyRows);
    } else {
      setCensusRows(data as CensusRow[]);
    }

    setLoading(false);
  }, [supabase, year, month]);

  useEffect(() => { loadData(); }, [loadData]);

  // ── Auto-sum total_members ────────────────────────────────────────────────
  const totalMembers = form.children + form.youth + form.adults + form.seniors;

  // ── Start Edit ────────────────────────────────────────────────────────────
  function handleEdit(row: CensusRow) {
    if (!role || !hasPermission(role, "census.edit")) return;
    if (row.locked) return;

    setEditingId(row.priest_id);
    setForm({
      eligible_to_tithe: row.eligible_to_tithe,
      children: row.children,
      youth: row.youth,
      adults: row.adults,
      seniors: row.seniors,
    });
    setSuccessMsg(null);
  }

  // ── Save / Upsert ────────────────────────────────────────────────────────
  async function handleSave(priestId: string) {
    if (!access || !role) return;
    if (!hasPermission(role, "census.edit") && !hasPermission(role, "census.capture")) return;

    setSaving(true);
    setError(null);
    setSuccessMsg(null);

    const computedTotal = form.children + form.youth + form.adults + form.seniors;

    // Find existing row to detect changes for audit log
    const existingRow = censusRows.find((r) => r.priest_id === priestId);

    // Upsert
    const { data: result, error: upsertError } = await supabase
      .from("priest_census")
      .upsert(
        {
          congregation_id: access.congregation_id,
          priest_id: priestId,
          year,
          month,
          eligible_to_tithe: form.eligible_to_tithe,
          children: form.children,
          youth: form.youth,
          adults: form.adults,
          seniors: form.seniors,
          total_members: computedTotal,
          captured_by: access.user_id,
          captured_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        },
        { onConflict: "priest_id,year,month" }
      )
      .select("id")
      .single();

    if (upsertError) {
      setError(upsertError.message);
      setSaving(false);
      return;
    }

    // Log changes to priest_census_log (only if editing existing data)
    if (existingRow && existingRow.id && result) {
      const changes: Array<{ field_name: string; old_value: string; new_value: string }> = [];

      if (existingRow.eligible_to_tithe !== form.eligible_to_tithe) {
        changes.push({ field_name: "eligible_to_tithe", old_value: String(existingRow.eligible_to_tithe), new_value: String(form.eligible_to_tithe) });
      }
      if (existingRow.children !== form.children) {
        changes.push({ field_name: "children", old_value: String(existingRow.children), new_value: String(form.children) });
      }
      if (existingRow.youth !== form.youth) {
        changes.push({ field_name: "youth", old_value: String(existingRow.youth), new_value: String(form.youth) });
      }
      if (existingRow.adults !== form.adults) {
        changes.push({ field_name: "adults", old_value: String(existingRow.adults), new_value: String(form.adults) });
      }
      if (existingRow.seniors !== form.seniors) {
        changes.push({ field_name: "seniors", old_value: String(existingRow.seniors), new_value: String(form.seniors) });
      }

      if (changes.length > 0) {
        const logs = changes.map((c) => ({
          priest_census_id: result.id,
          changed_by: access.user_id,
          changed_at: new Date().toISOString(),
          ...c,
        }));
        await supabase.from("priest_census_log").insert(logs);

        // Audit log
        await logAuditAction({
          userId: access.user_id,
          actionType: "CENSUS_UPDATE",
          entityType: "priest_census",
          entityId: result.id,
          comment: `Updated ${changes.length} field(s) for priest ${priestId}`,
          metadata: { changes, year, month },
        });
      }
    }

    setSaving(false);
    setEditingId(null);
    setSuccessMsg("Census saved successfully.");
    await loadData();
  }

  // ── Cancel Edit ───────────────────────────────────────────────────────────
  function handleCancel() {
    setEditingId(null);
    setError(null);
  }

  // ── Form Field Update ─────────────────────────────────────────────────────
  function updateField(field: keyof CensusFormData, value: string) {
    setForm((prev) => ({ ...prev, [field]: parseInt(value) || 0 }));
  }

  // ── Permissions ───────────────────────────────────────────────────────────
  const canCapture = role ? hasPermission(role, "census.capture") : false;
  const canEdit = role ? hasPermission(role, "census.edit") : false;
  const canView90Flag = role ? hasPermission(role, "census.view_90_flag") : false;
  const canView180Flag = role ? hasPermission(role, "census.view_180_flag") : false;

  // ── Loading State ─────────────────────────────────────────────────────────
  if (loading) {
    return (
      <main className="min-h-screen bg-muted/40 px-4 py-12">
        <div className="mx-auto max-w-4xl">
          <p className="text-muted-foreground">Loading census...</p>
        </div>
      </main>
    );
  }

  // ── Access Denied (Secretary or no permission) ────────────────────────────
  if (error && !censusRows.length) {
    return (
      <main className="min-h-screen bg-muted/40 px-4 py-12">
        <div className="mx-auto max-w-4xl">
          <p className="text-destructive">{error}</p>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-muted/40 px-4 py-6">
      <div className="mx-auto max-w-4xl space-y-6">
        {/* Header */}
        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight">Priestship Census</h1>
          <p className="text-sm text-muted-foreground">
            {year}/{String(month).padStart(2, "0")} — Per-priest demographics for your congregation
          </p>
        </div>

        {/* Success / Error banners */}
        {successMsg && (
          <div className="rounded-md border border-green-300 bg-green-50 p-3">
            <p className="text-sm text-green-800">{successMsg}</p>
          </div>
        )}
        {error && (
          <div className="rounded-md border border-destructive/50 bg-destructive/10 p-3">
            <p className="text-sm text-destructive">{error}</p>
          </div>
        )}

        {/* Congregation Total */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-base">Congregation Total</CardTitle>
            <CardDescription>Sum of all priests&apos; total_members</CardDescription>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold">
              {censusRows.reduce((s, r) => s + (r.total_members ?? 0), 0)}
            </p>
          </CardContent>
        </Card>

        {/* Priest List */}
        <div className="space-y-4">
          {censusRows.map((row) => {
            const isEditing = editingId === row.priest_id;
            const isLocked = row.locked;

            return (
              <Card key={row.priest_id} className={isLocked ? "opacity-75" : ""}>
                <CardHeader className="pb-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <CardTitle className="text-base">{row.priest_name}</CardTitle>
                      <span className="text-xs text-muted-foreground">({row.officer_code})</span>
                    </div>
                    <div className="flex items-center gap-2">
                      {/* Staleness flag */}
                      {(canView90Flag && row.staleness_flag === "ORANGE") ||
                       (canView180Flag && row.staleness_flag === "RED") ||
                       row.staleness_flag === "GREEN" ? (
                        <div className="flex items-center gap-1">
                          <span className={`inline-block h-3 w-3 rounded-full ${stalenessColor(row.staleness_flag)}`} />
                          <span className="text-xs text-muted-foreground">{stalenessLabel(row.staleness_flag)}</span>
                        </div>
                      ) : null}
                      {isLocked && (
                        <span className="text-xs bg-orange-100 text-orange-800 px-2 py-0.5 rounded-full">Locked</span>
                      )}
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  {isEditing ? (
                    /* Edit Form */
                    <div className="space-y-3">
                      <div className="grid gap-3 sm:grid-cols-3">
                        {(
                          [
                            ["eligible_to_tithe", "Eligible to Tithe"],
                            ["children", "Children"],
                            ["youth", "Youth"],
                            ["adults", "Adults"],
                            ["seniors", "Seniors"],
                          ] as const
                        ).map(([field, label]) => (
                          <div key={field} className="space-y-1">
                            <Label htmlFor={`${row.priest_id}-${field}`} className="text-xs">{label}</Label>
                            <Input
                              id={`${row.priest_id}-${field}`}
                              type="number"
                              min="0"
                              value={form[field]}
                              onChange={(e) => updateField(field, e.target.value)}
                            />
                          </div>
                        ))}
                        {/* Auto-sum total */}
                        <div className="space-y-1">
                          <Label className="text-xs">Total Members (auto)</Label>
                          <div className="flex h-10 w-full items-center rounded-md border border-input bg-muted px-3 text-sm font-semibold">
                            {totalMembers}
                          </div>
                        </div>
                      </div>
                      <div className="flex gap-2">
                        <Button size="sm" onClick={() => handleSave(row.priest_id)} disabled={saving}>
                          {saving ? "Saving..." : "Save"}
                        </Button>
                        <Button size="sm" variant="outline" onClick={handleCancel}>
                          Cancel
                        </Button>
                      </div>
                    </div>
                  ) : (
                    /* Read-only View */
                    <div className="flex items-center justify-between">
                      <div className="grid gap-x-6 gap-y-1 sm:grid-cols-6 text-sm">
                        <div><span className="text-xs text-muted-foreground">Eligible</span><br/>{row.eligible_to_tithe}</div>
                        <div><span className="text-xs text-muted-foreground">Children</span><br/>{row.children}</div>
                        <div><span className="text-xs text-muted-foreground">Youth</span><br/>{row.youth}</div>
                        <div><span className="text-xs text-muted-foreground">Adults</span><br/>{row.adults}</div>
                        <div><span className="text-xs text-muted-foreground">Seniors</span><br/>{row.seniors}</div>
                        <div><span className="text-xs text-muted-foreground font-medium">Total</span><br/><span className="font-semibold">{row.total_members}</span></div>
                      </div>
                      {(canCapture || canEdit) && !isLocked && (
                        <Button size="sm" variant="outline" onClick={() => handleEdit(row)}>
                          Edit
                        </Button>
                      )}
                    </div>
                  )}

                  {/* Lock message */}
                  {isLocked && (
                    <p className="text-xs text-orange-700 mt-2">
                      Locked after Overseer Approval. Cannot be edited until month is reopened.
                    </p>
                  )}
                </CardContent>
              </Card>
            );
          })}
        </div>
      </div>
    </main>
  );
}
