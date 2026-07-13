"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { upsertPriestCensus } from "@/lib/supabase/queries";
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

interface CensusRow {
  id: string;
  congregation_id: string;
  priest_id: string;
  year: number;
  month: number;
  underdeacon_count: number;
  children_under_15: number;
  youth_under_26: number;
  youth_under_35: number;
  adults_under_60: number;
  seniors_60_plus: number;
  working_members: number;
  updated_at: string;
  locked: boolean;
}

function getStalenessColor(updatedAt: string): string {
  const months =
    (Date.now() - new Date(updatedAt).getTime()) / (1000 * 60 * 60 * 24 * 30);
  if (months < 3) return "bg-green-500";
  if (months < 6) return "bg-orange-500";
  return "bg-red-500";
}

function getStalenessLabel(updatedAt: string): string {
  const months = Math.floor(
    (Date.now() - new Date(updatedAt).getTime()) / (1000 * 60 * 60 * 24 * 30)
  );
  if (months < 3) return `${months}mo ago — Current`;
  if (months < 6) return `${months}mo ago — Review soon`;
  return `${months}mo ago — Stale`;
}

export default function CensusPage() {
  const supabase = createClient();

  const [userId, setUserId] = useState<string | null>(null);
  const [congregationId, setCongregationId] = useState<string | null>(null);
  const [priestId, setPriestId] = useState<string | null>(null);
  const [census, setCensus] = useState<CensusRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  // Form state
  const now = new Date();
  const [year] = useState(now.getFullYear());
  const [month] = useState(now.getMonth() + 1);
  const [form, setForm] = useState({
    underdeacon_count: 0,
    children_under_15: 0,
    youth_under_26: 0,
    youth_under_35: 0,
    adults_under_60: 0,
    seniors_60_plus: 0,
    working_members: 0,
  });

  useEffect(() => {
    loadUserAndCensus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadUserAndCensus() {
    setLoading(true);

    // Get current user
    const {
      data: { user },
    } = await supabase.auth.getUser();
    if (!user) {
      setLoading(false);
      return;
    }
    setUserId(user.id);

    // Get user profile to find congregation and officer id
    const { data: profile } = await supabase
      .from("profiles")
      .select("congregation_id, officer_id")
      .eq("id", user.id)
      .single();

    if (!profile) {
      setError("Profile not found. Contact your administrator.");
      setLoading(false);
      return;
    }

    setCongregationId(profile.congregation_id);
    setPriestId(profile.officer_id);

    // Fetch existing census row for this priest/year/month
    const { data: existingCensus } = await supabase
      .from("priest_census")
      .select("*")
      .eq("priest_id", profile.officer_id)
      .eq("year", year)
      .eq("month", month)
      .single();

    if (existingCensus) {
      setCensus(existingCensus);
      setForm({
        underdeacon_count: existingCensus.underdeacon_count ?? 0,
        children_under_15: existingCensus.children_under_15 ?? 0,
        youth_under_26: existingCensus.youth_under_26 ?? 0,
        youth_under_35: existingCensus.youth_under_35 ?? 0,
        adults_under_60: existingCensus.adults_under_60 ?? 0,
        seniors_60_plus: existingCensus.seniors_60_plus ?? 0,
        working_members: existingCensus.working_members ?? 0,
      });
    }

    setLoading(false);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    if (!congregationId || !priestId || !userId) return;

    setError(null);
    setSuccess(false);
    setSaving(true);

    try {
      // Build old values for audit log
      const oldValues = census
        ? {
            underdeacon_count: census.underdeacon_count,
            children_under_15: census.children_under_15,
            youth_under_26: census.youth_under_26,
            youth_under_35: census.youth_under_35,
            adults_under_60: census.adults_under_60,
            seniors_60_plus: census.seniors_60_plus,
            working_members: census.working_members,
          }
        : null;

      // Upsert census
      const result = await upsertPriestCensus({
        congregation_id: congregationId,
        priest_id: priestId,
        year,
        month,
        captured_by: userId,
        ...form,
      });

      // Insert audit log entries for changed fields
      if (oldValues && result) {
        const fields = Object.keys(form) as Array<keyof typeof form>;
        const logs = fields
          .filter((field) => oldValues[field] !== form[field])
          .map((field) => ({
            priest_census_id: result.id,
            changed_by: userId,
            changed_at: new Date().toISOString(),
            field_name: field,
            old_value: String(oldValues[field] ?? ""),
            new_value: String(form[field]),
          }));

        if (logs.length > 0) {
          await supabase.from("priest_census_log").insert(logs);
        }
      }

      setSuccess(true);
      await loadUserAndCensus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  function updateField(field: keyof typeof form, value: string) {
    setForm((prev) => ({ ...prev, [field]: parseInt(value) || 0 }));
  }

  const isLocked = census?.locked === true;

  if (loading) {
    return (
      <main className="min-h-screen bg-muted/40 px-4 py-12">
        <div className="mx-auto max-w-2xl">
          <p className="text-muted-foreground">Loading census...</p>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-muted/40 px-4 py-8">
      <div className="mx-auto max-w-2xl space-y-6">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <h1 className="text-2xl font-bold tracking-tight">
              Priest Census Portal
            </h1>
            <p className="text-sm text-muted-foreground">
              {year}/{String(month).padStart(2, "0")} Census
            </p>
          </div>
          {census?.updated_at && (
            <div className="flex items-center gap-2">
              <span
                className={`inline-block h-3 w-3 rounded-full ${getStalenessColor(census.updated_at)}`}
              />
              <span className="text-xs text-muted-foreground">
                {getStalenessLabel(census.updated_at)}
              </span>
            </div>
          )}
        </div>

        {/* Lock banner */}
        {isLocked && (
          <div className="rounded-md border border-orange-300 bg-orange-50 p-3">
            <p className="text-sm text-orange-800">
              Locked after Audit Approval. This census cannot be edited.
            </p>
          </div>
        )}

        {/* Form */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Census Data</CardTitle>
            <CardDescription>
              Enter congregation demographics for this month.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSave} className="space-y-4">
              {(
                [
                  ["underdeacon_count", "Underdeacon Count"],
                  ["children_under_15", "Children (under 15)"],
                  ["youth_under_26", "Youth (under 26)"],
                  ["youth_under_35", "Youth (under 35)"],
                  ["adults_under_60", "Adults (under 60)"],
                  ["seniors_60_plus", "Seniors (60+)"],
                  ["working_members", "Working Members"],
                ] as const
              ).map(([field, label]) => (
                <div key={field} className="space-y-1">
                  <Label htmlFor={field}>{label}</Label>
                  <Input
                    id={field}
                    type="number"
                    min="0"
                    value={form[field]}
                    onChange={(e) => updateField(field, e.target.value)}
                    disabled={isLocked}
                  />
                </div>
              ))}

              {error && (
                <p className="text-sm text-destructive">{error}</p>
              )}
              {success && (
                <p className="text-sm text-green-600">Census saved successfully.</p>
              )}

              {!isLocked && (
                <Button type="submit" className="w-full" disabled={saving}>
                  {saving ? "Saving..." : "Save Census"}
                </Button>
              )}
            </form>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
