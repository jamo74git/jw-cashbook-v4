"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { getUserAccess } from "@/lib/permissions";
import { AppHeader } from "@/components/AppHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import type { UserHierarchyAccess } from "@/lib/types";

interface Congregation { id: string; name: string; code: string; }
interface HierarchyNode { id: string; name: string; level_type: string; code: string; }

const ROLES = ["Treasurer", "Auditor", "Chairperson", "Elder", "Overseer", "Apostle", "HO", "Secretary"] as const;

// Map role to default scope level
const ROLE_SCOPE: Record<string, string> = {
  Treasurer: "Congregation", Auditor: "Congregation", Chairperson: "Congregation", Secretary: "Congregation",
  Elder: "Eldership", Overseer: "Overseership", Apostle: "Apostleship", HO: "District",
};

export default function CreateUserPage() {
  const supabase = createClient();
  const [access, setAccess] = useState<UserHierarchyAccess | null>(null);
  const [congregations, setCongregations] = useState<Congregation[]>([]);
  const [hierarchyNodes, setHierarchyNodes] = useState<HierarchyNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Form
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<string>("Treasurer");
  const [congregationId, setCongregationId] = useState("");
  const [hierarchyId, setHierarchyId] = useState("");

  const scopeLevel = ROLE_SCOPE[role] ?? "Congregation";
  const needsCongregation = ["Treasurer", "Auditor", "Chairperson", "Secretary"].includes(role);

  useEffect(() => {
    (async () => {
      const ua = await getUserAccess();
      if (!ua) { setLoading(false); return; }
      setAccess(ua);

      // Load congregations (filtered by HO's district if applicable)
      const { data: congs } = await supabase.from("congregations").select("id, name, code").order("name");
      setCongregations(congs ?? []);

      // Load hierarchy nodes for scope assignment
      const { data: nodes } = await supabase.from("hierarchy_levels").select("id, name, level_type, code").order("level_type");
      setHierarchyNodes(nodes ?? []);

      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Auto-set hierarchy_id when congregation changes
  useEffect(() => {
    if (needsCongregation && congregationId) {
      const cong = congregations.find(c => c.id === congregationId);
      if (cong) {
        // Find the congregation's hierarchy node
        const node = hierarchyNodes.find(n => n.level_type === "Congregation" && n.code === cong.code);
        if (node) setHierarchyId(node.id);
      }
    }
  }, [congregationId, needsCongregation, congregations, hierarchyNodes]);

  async function handleCreate() {
    setError(null);
    setSuccess(null);

    if (!email || !password) { setError("Email and password are required"); return; }
    if (needsCongregation && !congregationId) { setError("Please select a congregation for this role"); return; }
    if (!needsCongregation && !hierarchyId) { setError("Please select a hierarchy node for this role"); return; }

    setCreating(true);

    // Get the current session token to pass to the API route
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) {
      setError("Session expired. Please log in again.");
      setCreating(false);
      return;
    }

    const res = await fetch("/api/admin/create-user", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({
        email,
        password,
        role,
        congregation_id: needsCongregation ? congregationId : null,
        hierarchy_id: hierarchyId,
        scope_level: scopeLevel,
      }),
    });

    const data = await res.json();
    setCreating(false);

    if (!res.ok) {
      setError(data.error ?? "Failed to create user");
      return;
    }

    setSuccess(`User created: ${data.user.email} as ${data.user.role} (${data.user.scope_level})`);
    // Reset form
    setEmail("");
    setPassword("");
    setCongregationId("");
  }

  if (loading) return <><AppHeader /><div className="p-6 text-sm text-muted-foreground">Loading...</div></>;
  if (access?.role !== "HO") return <><AppHeader /><div className="p-6 text-sm text-destructive">Access denied. HO only.</div></>;

  // Filter hierarchy nodes by the selected scope level
  const filteredNodes = hierarchyNodes.filter(n => n.level_type === scopeLevel);

  return (
    <>
      <AppHeader />
      <div className="max-w-lg mx-auto px-4 py-6 space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-bold">Create User</h1>
          <Button variant="outline" size="sm" onClick={() => window.history.back()}>← Back</Button>
        </div>

        {success && <div className="rounded border border-green-300 bg-green-50 p-3 text-xs text-green-800">{success}</div>}
        {error && <div className="rounded border border-destructive/50 bg-destructive/10 p-3 text-xs text-destructive">{error}</div>}

        <Card>
          <CardHeader className="pb-3"><CardTitle className="text-sm">New User Details</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            {/* Email */}
            <div className="space-y-1">
              <Label className="text-xs">Email Address *</Label>
              <Input className="h-9 text-xs" type="email" placeholder="user@example.com" value={email} onChange={e => setEmail(e.target.value)} />
            </div>

            {/* Password */}
            <div className="space-y-1">
              <Label className="text-xs">Temporary Password *</Label>
              <Input className="h-9 text-xs" type="text" placeholder="Min 6 characters" value={password} onChange={e => setPassword(e.target.value)} />
              <p className="text-[10px] text-muted-foreground">User will use this for first login. OTP-based login planned for go-live.</p>
            </div>

            {/* Role */}
            <div className="space-y-1">
              <Label className="text-xs">Role *</Label>
              <select className="h-9 w-full rounded border border-input bg-background px-2 text-xs" value={role} onChange={e => { setRole(e.target.value); setCongregationId(""); setHierarchyId(""); }}>
                {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
              <Badge variant="outline" className="text-[9px] mt-1">Scope: {scopeLevel}</Badge>
            </div>

            {/* Congregation (for congregation-scoped roles) */}
            {needsCongregation && (
              <div className="space-y-1">
                <Label className="text-xs">Congregation *</Label>
                <select className="h-9 w-full rounded border border-input bg-background px-2 text-xs" value={congregationId} onChange={e => setCongregationId(e.target.value)}>
                  <option value="">Select congregation...</option>
                  {congregations.map(c => <option key={c.id} value={c.id}>{c.code} — {c.name}</option>)}
                </select>
              </div>
            )}

            {/* Hierarchy Node (for higher-scoped roles) */}
            {!needsCongregation && (
              <div className="space-y-1">
                <Label className="text-xs">{scopeLevel} *</Label>
                <select className="h-9 w-full rounded border border-input bg-background px-2 text-xs" value={hierarchyId} onChange={e => setHierarchyId(e.target.value)}>
                  <option value="">Select {scopeLevel.toLowerCase()}...</option>
                  {filteredNodes.map(n => <option key={n.id} value={n.id}>{n.code} — {n.name}</option>)}
                </select>
              </div>
            )}

            {/* Create Button */}
            <Button className="w-full" onClick={handleCreate} disabled={creating}>
              {creating ? "Creating..." : "Create User & Assign Access"}
            </Button>
          </CardContent>
        </Card>

        {/* Quick Info */}
        <Card>
          <CardContent className="py-3 text-[10px] text-muted-foreground space-y-1">
            <p><b>What happens:</b></p>
            <p>1. Auth account created with email + temp password</p>
            <p>2. Role + hierarchy access assigned immediately</p>
            <p>3. User can log in right away at the correct dashboard</p>
            <p className="pt-1 text-orange-600">For go-live: passwords will be replaced with OTP (email/SMS).</p>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
