"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { getUserAccess } from "@/lib/permissions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { UserHierarchyAccess } from "@/lib/types";

interface UserRow {
  user_id: string;
  email: string;
  role: string;
  scope_level: string;
  congregation_ids: string[];
}

interface Congregation {
  id: string;
  name: string;
  code: string;
}

interface Assignment {
  id: string;
  user_id: string;
  congregation_id: string;
  status: string;
}

export default function AssignmentsPage() {
  const supabase = createClient();
  const [access, setAccess] = useState<UserHierarchyAccess | null>(null);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [congregations, setCongregations] = useState<Congregation[]>([]);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [selectedUser, setSelectedUser] = useState<string | null>(null);
  const [filterRole, setFilterRole] = useState<string>("All");

  useEffect(() => { if (toast) { const t = setTimeout(() => setToast(null), 4000); return () => clearTimeout(t); } }, [toast]);

  useEffect(() => {
    (async () => {
      const ua = await getUserAccess();
      if (!ua || ua.role !== "HO") { setLoading(false); return; }
      setAccess(ua);
      await loadData();
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loadData() {
    setLoading(true);

    // Load all congregations
    const { data: congs } = await supabase.from("congregations").select("id, name, code").order("name");
    setCongregations(congs ?? []);

    // Get session token for API calls
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) { setLoading(false); return; }

    // Load users with emails via admin API
    const res = await fetch("/api/admin/list-users", {
      headers: { "Authorization": `Bearer ${session.access_token}` },
    });
    const userData = await res.json();

    // Load all congregation assignments
    const { data: assignRows } = await supabase
      .from("user_congregation_assignments")
      .select("id, user_id, congregation_id, status")
      .eq("status", "active");

    setAssignments(assignRows ?? []);

    if (userData.users) {
      const userList: UserRow[] = userData.users.map((u: { user_id: string; email: string; role: string; scope_level: string }) => ({
        user_id: u.user_id,
        email: u.email,
        role: u.role,
        scope_level: u.scope_level,
        congregation_ids: (assignRows ?? []).filter(a => a.user_id === u.user_id).map(a => a.congregation_id),
      }));
      setUsers(userList);
    }

    setLoading(false);
  }

  async function toggleAssignment(userId: string, congregationId: string) {
    setSaving(true);
    const existing = assignments.find(a => a.user_id === userId && a.congregation_id === congregationId);

    if (existing) {
      // Remove assignment
      await supabase.from("user_congregation_assignments").delete().eq("id", existing.id);
      setAssignments(prev => prev.filter(a => a.id !== existing.id));
      setToast("Assignment removed");
    } else {
      // Add assignment
      const { data: { user } } = await supabase.auth.getUser();
      const { data: newRow } = await supabase
        .from("user_congregation_assignments")
        .insert({ user_id: userId, congregation_id: congregationId, assigned_by: user?.id, status: "active" })
        .select("id, user_id, congregation_id, status")
        .single();
      if (newRow) {
        setAssignments(prev => [...prev, newRow]);
        setToast("Assignment added");
      }
    }
    setSaving(false);
  }

  function isAssigned(userId: string, congregationId: string): boolean {
    return assignments.some(a => a.user_id === userId && a.congregation_id === congregationId);
  }

  if (loading) return <div className="p-6 text-sm text-muted-foreground">Loading...</div>;
  if (access?.role !== "HO") return <div className="p-6 text-sm text-destructive">Access denied. HO only.</div>;

  const roles = ["All", ...new Set(users.map(u => u.role))];
  const filteredUsers = filterRole === "All" ? users : users.filter(u => u.role === filterRole);

  const selectedUserData = users.find(u => u.user_id === selectedUser);

  return (
    <>
      <div className="max-w-6xl mx-auto px-4 py-6 space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-lg font-bold">Congregation Assignments</h1>
            <p className="text-xs text-muted-foreground">Assign users to congregations. Elders can span multiple congregations.</p>
          </div>
          <Button variant="outline" size="sm" onClick={() => window.history.back()}>← Back</Button>
        </div>

        {toast && <div className="rounded border border-green-300 bg-green-50 p-2 text-xs text-green-800">{toast}</div>}

        {/* Role filter */}
        <div className="flex gap-2 items-center">
          <span className="text-xs text-muted-foreground">Filter by role:</span>
          {roles.map(r => (
            <Button key={r} size="sm" variant={filterRole === r ? "default" : "outline"} className="h-7 text-xs" onClick={() => setFilterRole(r)}>
              {r}
            </Button>
          ))}
        </div>

        {/* Grid view: users × congregations */}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-xs">
              {selectedUser ? `Editing: ${selectedUserData?.email ?? selectedUser.slice(0, 8)} (${selectedUserData?.role})` : "Select a user to manage their assignments"}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              {/* Left: User list */}
              <div className="md:col-span-1 border-r pr-3 max-h-[500px] overflow-y-auto space-y-1">
                <p className="text-[10px] text-muted-foreground font-medium mb-2 uppercase tracking-wider">Users ({filteredUsers.length})</p>
                {filteredUsers.map(u => (
                  <button
                    key={u.user_id}
                    onClick={() => setSelectedUser(u.user_id)}
                    className={`w-full text-left px-2 py-1.5 rounded text-xs hover:bg-muted transition-colors ${selectedUser === u.user_id ? "bg-primary/10 border border-primary/30" : ""}`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-medium truncate">{u.email || u.user_id.slice(0, 8) + "..."}</span>
                      <Badge variant="outline" className="text-[9px] ml-1 shrink-0">{u.role}</Badge>
                    </div>
                    <div className="text-[10px] text-muted-foreground mt-0.5">
                      {u.congregation_ids.length} congregation{u.congregation_ids.length !== 1 ? "s" : ""} assigned
                    </div>
                  </button>
                ))}
              </div>

              {/* Right: Congregation checkboxes */}
              <div className="md:col-span-2 max-h-[500px] overflow-y-auto">
                {selectedUser ? (
                  <div className="space-y-1">
                    <p className="text-[10px] text-muted-foreground font-medium mb-2 uppercase tracking-wider">
                      Congregations — click to toggle
                    </p>
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
                      {congregations.map(c => {
                        const assigned = isAssigned(selectedUser, c.id);
                        return (
                          <button
                            key={c.id}
                            onClick={() => toggleAssignment(selectedUser, c.id)}
                            disabled={saving}
                            className={`flex items-center justify-between px-3 py-2 rounded border text-xs transition-colors ${
                              assigned ? "bg-green-50 border-green-300 text-green-800" : "bg-background border-input hover:bg-muted"
                            }`}
                          >
                            <span>
                              <span className="font-medium">{c.code}</span>
                              <span className="text-muted-foreground ml-1">— {c.name}</span>
                            </span>
                            {assigned && (
                              <svg className="w-4 h-4 text-green-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                              </svg>
                            )}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ) : (
                  <div className="flex items-center justify-center h-40 text-xs text-muted-foreground">
                    ← Select a user from the list to manage their congregation access
                  </div>
                )}
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Quick info */}
        <Card>
          <CardContent className="py-3 text-[10px] text-muted-foreground space-y-1">
            <p><b>How it works:</b></p>
            <p>• Each user sees only their assigned congregations in their dashboard</p>
            <p>• Elders can be assigned multiple congregations (multi-eldership support)</p>
            <p>• Changing assignments takes effect immediately — no restart needed</p>
            <p>• When eldership structures change, just update assignments here</p>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
