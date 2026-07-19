"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { getUserAccess } from "@/lib/permissions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import type { Role, UserHierarchyAccess } from "@/lib/types";

interface Settings { id?: string; congregation_id: string; proof_mandatory: boolean; allow_chair_submit: boolean; theme_default: string; }

export default function AdminSettingsPage() {
  const supabase = createClient();
  const [access, setAccess] = useState<UserHierarchyAccess | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [success, setSuccess] = useState(false);

  const role = access?.role as Role | undefined;

  useEffect(() => {
    (async () => {
      const ua = await getUserAccess();
      if (!ua?.congregation_id) { setLoading(false); return; }
      setAccess(ua);
      const { data: s } = await supabase.from("congregation_settings").select("*").eq("congregation_id", ua.congregation_id).maybeSingle();
      setSettings(s ?? { congregation_id: ua.congregation_id, proof_mandatory: false, allow_chair_submit: true, theme_default: "light" });
      setLoading(false);
    })();
  }, []);

  async function handleSave() {
    if (!settings || !access) return;
    setSaving(true); setSuccess(false);
    const { data: { user } } = await supabase.auth.getUser();
    if (settings.id) {
      await supabase.from("congregation_settings").update({ proof_mandatory: settings.proof_mandatory, allow_chair_submit: settings.allow_chair_submit, theme_default: settings.theme_default, updated_by: user?.id, updated_at: new Date().toISOString() }).eq("id", settings.id);
    } else {
      await supabase.from("congregation_settings").insert({ ...settings, updated_by: user?.id });
    }
    setSaving(false); setSuccess(true);
  }

  if (loading) return <div className="p-6 text-sm text-muted-foreground">Loading...</div>;
  if (!role || !["Elder","Chairperson","HO"].includes(role)) return <div className="p-6 text-sm text-destructive">Access denied. Elder/Chair/HO only.</div>;

  return (
    <div className="max-w-lg mx-auto px-4 py-6 space-y-6">
      <h1 className="text-xl font-bold">Congregation Settings</h1>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-sm">Capture & Submission Rules</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          {/* Proof Mandatory */}
          <div className="flex items-center justify-between">
            <Label className="text-xs">Proof Mandatory for EFT/DD</Label>
            <button onClick={() => setSettings(s => s ? { ...s, proof_mandatory: !s.proof_mandatory } : s)}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${settings?.proof_mandatory ? "bg-primary" : "bg-muted"}`}>
              <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${settings?.proof_mandatory ? "translate-x-6" : "translate-x-1"}`} />
            </button>
          </div>

          {/* Allow Chair Submit */}
          <div className="flex items-center justify-between">
            <Label className="text-xs">Allow Chairperson to Submit on behalf of Treasurer</Label>
            <button onClick={() => setSettings(s => s ? { ...s, allow_chair_submit: !s.allow_chair_submit } : s)}
              className={`relative inline-flex h-6 w-11 items-center rounded-full transition-colors ${settings?.allow_chair_submit ? "bg-primary" : "bg-muted"}`}>
              <span className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${settings?.allow_chair_submit ? "translate-x-6" : "translate-x-1"}`} />
            </button>
          </div>

          {/* Theme Default */}
          <div className="flex items-center justify-between">
            <Label className="text-xs">Default Theme</Label>
            <select className="h-8 rounded border border-input bg-background px-2 text-xs" value={settings?.theme_default ?? "light"} onChange={e => setSettings(s => s ? { ...s, theme_default: e.target.value } : s)}>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </div>

          <Button size="sm" onClick={handleSave} disabled={saving}>{saving ? "Saving..." : "Save Settings"}</Button>
          {success && <p className="text-xs text-green-600">Settings saved.</p>}
        </CardContent>
      </Card>
    </div>
  );
}
