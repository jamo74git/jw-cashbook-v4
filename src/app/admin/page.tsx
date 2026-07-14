"use client";

import { useEffect, useState, useRef } from "react";
import { createClient } from "@/lib/supabase/client";
import {
  getUserAccess,
  hasPermission,
  getHODistrictIds,
  logAuditAction,
} from "@/lib/permissions";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Role, UserHierarchyAccess } from "@/lib/types";

type ImportType = "congregations" | "officers" | "users";

interface ImportResult {
  success: number;
  failed: number;
  errors: string[];
}

export default function AdminPage() {
  const supabase = createClient();
  const fileRef = useRef<HTMLInputElement>(null);

  const [access, setAccess] = useState<UserHierarchyAccess | null>(null);
  const [districtIds, setDistrictIds] = useState<string[]>([]);
  const [importType, setImportType] = useState<ImportType>("congregations");
  const [importing, setImporting] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const role = access?.role as Role | undefined;

  useEffect(() => {
    loadAccess();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadAccess() {
    setLoading(true);
    const userAccess = await getUserAccess();
    if (!userAccess) { setLoading(false); return; }
    setAccess(userAccess);

    if (userAccess.role === "HO") {
      const ids = await getHODistrictIds(userAccess.user_id);
      setDistrictIds(ids);
    }
    setLoading(false);
  }

  // ── CSV Parser ──────────────────────────────────────────────────────────────
  function parseCSV(text: string): Record<string, string>[] {
    const lines = text.trim().split("\n");
    if (lines.length < 2) return [];
    const headers = lines[0].split(",").map((h) => h.trim().toLowerCase());
    return lines.slice(1).map((line) => {
      const values = line.split(",").map((v) => v.trim());
      const row: Record<string, string> = {};
      headers.forEach((h, i) => { row[h] = values[i] ?? ""; });
      return row;
    });
  }

  // ── Import Congregations ────────────────────────────────────────────────────
  async function importCongregations(rows: Record<string, string>[]): Promise<ImportResult> {
    let success = 0;
    const errors: string[] = [];

    for (const row of rows) {
      const { name, code, eldership_id, overseership_id, district_id } = row;
      if (!name || !code) { errors.push(`Missing name or code: ${JSON.stringify(row)}`); continue; }

      // Validate district is in HO's assigned districts
      if (district_id && !districtIds.includes(district_id)) {
        errors.push(`District ${district_id} not in your assignment for: ${name}`);
        continue;
      }

      const { error: insertError } = await supabase.from("congregations").insert({
        name, code,
        hierarchy_id: eldership_id || null,
        eldership_id: eldership_id || null,
        overseership_id: overseership_id || null,
        district_id: district_id || null,
      });

      if (insertError) { errors.push(`${name}: ${insertError.message}`); }
      else { success++; }
    }
    return { success, failed: errors.length, errors };
  }

  // ── Import Officers ─────────────────────────────────────────────────────────
  async function importOfficers(rows: Record<string, string>[]): Promise<ImportResult> {
    let success = 0;
    const errors: string[] = [];

    for (const row of rows) {
      const { congregation_id, officer_code, first_name, last_name, rank } = row;
      if (!congregation_id || !officer_code || !first_name || !last_name || !rank) {
        errors.push(`Missing fields: ${JSON.stringify(row)}`); continue;
      }

      const { error: insertError } = await supabase.from("officers").insert({
        congregation_id, officer_code, first_name, last_name, rank, is_active: true,
      });

      if (insertError) { errors.push(`${officer_code}: ${insertError.message}`); }
      else { success++; }
    }
    return { success, failed: errors.length, errors };
  }

  // ── Import Users (user_hierarchy_access) ────────────────────────────────────
  async function importUsers(rows: Record<string, string>[]): Promise<ImportResult> {
    let success = 0;
    const errors: string[] = [];

    for (const row of rows) {
      const { user_id, role: userRole, hierarchy_id, congregation_id, scope_level } = row;
      if (!user_id || !userRole || !hierarchy_id || !scope_level) {
        errors.push(`Missing fields: ${JSON.stringify(row)}`); continue;
      }

      const { error: insertError } = await supabase.from("user_hierarchy_access").insert({
        user_id, role: userRole, hierarchy_id,
        congregation_id: congregation_id || null,
        scope_level, status: "active",
      });

      if (insertError) { errors.push(`${user_id}: ${insertError.message}`); }
      else { success++; }
    }
    return { success, failed: errors.length, errors };
  }

  // ── Handle File Upload ──────────────────────────────────────────────────────
  async function handleImport() {
    const file = fileRef.current?.files?.[0];
    if (!file || !access) return;

    setImporting(true);
    setResult(null);
    setError(null);

    const text = await file.text();
    const rows = parseCSV(text);

    if (rows.length === 0) {
      setError("CSV file is empty or invalid format.");
      setImporting(false);
      return;
    }

    let importResult: ImportResult;
    switch (importType) {
      case "congregations":
        importResult = await importCongregations(rows);
        break;
      case "officers":
        importResult = await importOfficers(rows);
        break;
      case "users":
        importResult = await importUsers(rows);
        break;
    }

    // Audit log the bulk action
    await logAuditAction({
      userId: access.user_id,
      actionType: "BULK_IMPORT",
      entityType: importType,
      entityId: `bulk_${importType}_${Date.now()}`,
      comment: `Imported ${importResult.success} ${importType}, ${importResult.failed} failed`,
      metadata: { type: importType, success: importResult.success, failed: importResult.failed },
    });

    setResult(importResult);
    setImporting(false);
    if (fileRef.current) fileRef.current.value = "";
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  if (loading) {
    return (
      <main className="min-h-screen bg-muted/40 px-4 py-12">
        <div className="mx-auto max-w-4xl"><p className="text-muted-foreground">Loading...</p></div>
      </main>
    );
  }

  if (!role || !hasPermission(role, "admin.bulk_import")) {
    return (
      <main className="min-h-screen bg-muted/40 px-4 py-12">
        <div className="mx-auto max-w-4xl"><p className="text-destructive">Access denied. HO Admin only.</p></div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-muted/40 px-4 py-6">
      <div className="mx-auto max-w-4xl space-y-6">
        {/* Header */}
        <div className="space-y-1">
          <h1 className="text-2xl font-bold tracking-tight">Head Office Administration</h1>
          <p className="text-sm text-muted-foreground">
            Bulk import and manage congregations, officers, and user access.
            {districtIds.length > 0 && ` (${districtIds.length} district(s) assigned)`}
          </p>
        </div>

        {/* Quick Links */}
        <div className="grid gap-4 sm:grid-cols-3">
          <Card className="cursor-pointer hover:border-primary/50" onClick={() => setImportType("congregations")}>
            <CardHeader className="pb-2"><CardTitle className="text-base">Congregations</CardTitle></CardHeader>
            <CardContent><p className="text-xs text-muted-foreground">Import/manage congregation records</p></CardContent>
          </Card>
          <Card className="cursor-pointer hover:border-primary/50" onClick={() => setImportType("officers")}>
            <CardHeader className="pb-2"><CardTitle className="text-base">Officers</CardTitle></CardHeader>
            <CardContent><p className="text-xs text-muted-foreground">Import officers with codes and ranks</p></CardContent>
          </Card>
          <Card className="cursor-pointer hover:border-primary/50" onClick={() => setImportType("users")}>
            <CardHeader className="pb-2"><CardTitle className="text-base">Users & Access</CardTitle></CardHeader>
            <CardContent><p className="text-xs text-muted-foreground">Assign roles and hierarchy access</p></CardContent>
          </Card>
        </div>

        {/* CSV Import Section */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">CSV Bulk Import — {importType}</CardTitle>
            <CardDescription>
              {importType === "congregations" && "Columns: name, code, eldership_id, overseership_id, district_id"}
              {importType === "officers" && "Columns: congregation_id, officer_code, first_name, last_name, rank"}
              {importType === "users" && "Columns: user_id, role, hierarchy_id, congregation_id, scope_level"}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="csv-file">Select CSV File</Label>
              <Input id="csv-file" type="file" accept=".csv" ref={fileRef} />
            </div>

            <div className="space-y-2">
              <Label>Import Type</Label>
              <select
                className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
                value={importType}
                onChange={(e) => setImportType(e.target.value as ImportType)}
              >
                <option value="congregations">Congregations</option>
                <option value="officers">Officers</option>
                <option value="users">Users & Access</option>
              </select>
            </div>

            <Button onClick={handleImport} disabled={importing}>
              {importing ? "Importing..." : `Import ${importType}`}
            </Button>

            {error && <p className="text-sm text-destructive">{error}</p>}

            {result && (
              <div className="rounded-md border p-4 space-y-2">
                <p className="text-sm">
                  <span className="text-green-700 font-medium">{result.success} imported</span>
                  {result.failed > 0 && (
                    <span className="text-destructive font-medium"> · {result.failed} failed</span>
                  )}
                </p>
                {result.errors.length > 0 && (
                  <div className="max-h-32 overflow-y-auto text-xs text-destructive space-y-1">
                    {result.errors.map((err, i) => <p key={i}>{err}</p>)}
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>

        {/* User Management Link */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">User Access Management</CardTitle>
            <CardDescription>Assign users to roles and hierarchy scopes individually.</CardDescription>
          </CardHeader>
          <CardContent>
            <Button variant="outline" onClick={() => window.location.href = "/admin/users"}>
              Manage Users →
            </Button>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
