"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { getUserAccess, hasPermission, logAuditAction } from "@/lib/permissions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Role, UserHierarchyAccess } from "@/lib/types";
import { ROLES, HIERARCHY_LEVELS } from "@/lib/types";

interface AccessRow {
  id: string;
  user_id: string;
  role: string;
  scope_level: string;
  congregation_id: string | null;
  status: string;
}

export default function AdminUsersPage() {
  const supabase = createClient();
  const [access, setAccess] = useState<UserHierarchyAccess | null>(null);
  const [users, setUsers] = useState<AccessRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  // New assignment form
  const [newUserId, setNewUserId] = useState("");
  const [newRole, setNewRole] = useState<string>("Treasurer");
  const [newHierarchyId, setNewHierarchyId] = useState("");
  const [newCongId, setNewCongId] = useState("");
  const [newScope, setNewScope] = useState<string>("Congregation");
  const [formError, setFormError] = useState<string | null>(null);
  const [formSuccess, setFormSuccess] = useState<string | null>(null);

  const role = access?.role as Role | undefined;

  useEffect(() => { loadData(); }, []);

  async function loadData() {
    setLoading(true);
    const userAccess = await getUserAccess();
    if (!userAccess) { setLoading(false); return; }
    setAccess(userAccess);

    const { data } = await supabase
      .from("user_hierarchy_access")
      .select("id, user_id, role, scope_level, congregation_id, status")
      .eq("status", "active")
      .order("role");

    setUsers(data ?? []);
    setLoading(false);
  }

  async function handleAssign() {
    if (!access || !newUserId || !newHierarchyId) {
      setFormError("User ID and Hierarchy ID are required.");
      return;
    }

    setSaving(true);
    setFormError(null);
    setFormSuccess(null);

    const { error } = await supabase.from("user_hierarchy_access").insert({
      user_id: newUserId,
      role: newRole,
      hierarchy_id: newHierarchyId,
      congregation_id: newCongId || null,
      scope_level: newScope,
      status: "active",
    });

    if (error) { setFormError(error.message); setSaving(false); return; }

    await logAuditAction({
      userId: access.user_id,
      actionType: "BULK_IMPORT",
      entityType: "user_hierarchy_access",
      entityId: newUserId,
      comment: `Assigned ${newRole} at ${newScope} level`,
      metadata: { assigned_user: newUserId, role: newRole, scope: newScope },
    });

    setFormSuccess(`User assigned as ${newRole} successfully.`);
    setNewUserId(""); setNewHierarchyId(""); setNewCongId("");
    setSaving(false);
    await loadData();
  }

  if (loading) {
    return (
      <main className="min-h-screen bg-muted/40 px-4 py-12">
        <div className="mx-auto max-w-4xl"><p className="text-muted-foreground">Loading...</p></div>
      </main>
    );
  }

  if (!role || !hasPermission(role, "admin.manage_users")) {
    return (
      <main className="min-h-screen bg-muted/40 px-4 py-12">
        <div className="mx-auto max-w-4xl"><p className="text-destructive">Access denied.</p></div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-muted/40 px-4 py-6">
      <div className="mx-auto max-w-4xl space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold tracking-tight">User Access Management</h1>
          <Button variant="outline" size="sm" onClick={() => window.location.href = "/admin"}>← Admin</Button>
        </div>

        {/* Assign New User */}
        <Card>
          <CardHeader><CardTitle className="text-base">Assign User to Role</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label>User ID (UUID)</Label>
                <Input value={newUserId} onChange={(e) => setNewUserId(e.target.value)} placeholder="auth.users UUID" />
              </div>
              <div className="space-y-1">
                <Label>Role</Label>
                <select className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={newRole} onChange={(e) => setNewRole(e.target.value)}>
                  {ROLES.map((r) => <option key={r} value={r}>{r}</option>)}
                </select>
              </div>
              <div className="space-y-1">
                <Label>Hierarchy ID (UUID)</Label>
                <Input value={newHierarchyId} onChange={(e) => setNewHierarchyId(e.target.value)} placeholder="hierarchy_levels.id" />
              </div>
              <div className="space-y-1">
                <Label>Congregation ID (optional)</Label>
                <Input value={newCongId} onChange={(e) => setNewCongId(e.target.value)} placeholder="congregations.id" />
              </div>
              <div className="space-y-1">
                <Label>Scope Level</Label>
                <select className="flex h-10 w-full rounded-md border border-input bg-background px-3 py-2 text-sm" value={newScope} onChange={(e) => setNewScope(e.target.value)}>
                  {HIERARCHY_LEVELS.map((l) => <option key={l} value={l}>{l}</option>)}
                </select>
              </div>
            </div>
            {formError && <p className="text-sm text-destructive">{formError}</p>}
            {formSuccess && <p className="text-sm text-green-600">{formSuccess}</p>}
            <Button onClick={handleAssign} disabled={saving}>{saving ? "Saving..." : "Assign Access"}</Button>
          </CardContent>
        </Card>

        {/* Existing Users Table */}
        <Card>
          <CardHeader><CardTitle className="text-base">Active Access Records ({users.length})</CardTitle></CardHeader>
          <CardContent>
            <div className="space-y-2 max-h-96 overflow-y-auto">
              {users.map((u) => (
                <div key={u.id} className="flex items-center justify-between py-2 border-b last:border-0 text-sm">
                  <div>
                    <span className="font-mono text-xs">{u.user_id.slice(0, 8)}...</span>
                    <span className="ml-2 font-medium">{u.role}</span>
                    <span className="ml-2 text-muted-foreground text-xs">{u.scope_level}</span>
                  </div>
                  <span className="text-xs bg-green-100 text-green-800 px-2 py-0.5 rounded-full">{u.status}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
