"use client";

import { useEffect, useState, useMemo } from "react";
import { createClient } from "@/lib/supabase/client";
import { getUserAccess } from "@/lib/permissions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import type { UserHierarchyAccess } from "@/lib/types";

interface UserRow {
  user_id: string;
  email: string;
  role: string;
  scope_level: string;
  congregation_id: string | null;
  congregation_ids: string[];
}

interface Congregation { id: string; name: string; code: string; overseership_id: string | null; }
interface HierarchyNode { id: string; name: string; level_type: string; parent_id: string | null; }
interface Assignment { id: string; user_id: string; congregation_id: string; status: string; }

export default function AssignmentsPage() {
  const supabase = createClient();
  const [access, setAccess] = useState<UserHierarchyAccess | null>(null);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [congregations, setCongregations] = useState<Congregation[]>([]);
  const [hierarchyNodes, setHierarchyNodes] = useState<HierarchyNode[]>([]);
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedUser, setSelectedUser] = useState<string | null>(null);

  // Filters
  const [filterRole, setFilterRole] = useState<string>("All");
  const [filterOverseership, setFilterOverseership] = useState("");
  const [filterCongregation, setFilterCongregation] = useState("");
  const [searchTerm, setSearchTerm] = useState("");

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

    const { data: congs } = await supabase.from("congregations").select("id, name, code, overseership_id").order("name");
    setCongregations(congs ?? []);

    const { data: nodes } = await supabase.from("hierarchy_levels").select("id, name, level_type, parent_id").order("name");
    setHierarchyNodes(nodes ?? []);

    // Get session token for API calls
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) { setLoading(false); return; }

    // Load users with emails via admin API
    const res = await fetch("/api/admin/list-users", {
      headers: { "Authorization": `Bearer ${session.access_token}` },
    });
    const userData = await res.json();

    if (!res.ok || userData.error) {
      console.error("list-users API error:", userData.error ?? res.status);
      setError(`Failed to load users: ${userData.error ?? `HTTP ${res.status}`}`);
      setLoading(false);
      return;
    }

    // Load all congregation assignments
    const { data: assignRows } = await supabase
      .from("user_congregation_assignments")
      .select("id, user_id, congregation_id, status")
      .eq("status", "active");

    setAssignments(assignRows ?? []);

    if (userData.users) {
      const userList: UserRow[] = userData.users.map((u: { user_id: string; email: string; role: string; scope_level: string; congregation_id: string | null }) => ({
        user_id: u.user_id,
        email: u.email,
        role: u.role,
        scope_level: u.scope_level,
        congregation_id: u.congregation_id,
        congregation_ids: (assignRows ?? []).filter(a => a.user_id === u.user_id).map(a => a.congregation_id),
      }));
      setUsers(userList);
    } else {
      setError("No users returned from API. Check browser console for details.");
      console.error("userData:", userData);
    }

    setLoading(false);
  }

  // Derived filters
  const overseerships = useMemo(() => hierarchyNodes.filter(n => n.level_type === "Overseership"), [hierarchyNodes]);

  const filteredCongsForFilter = useMemo(() => {
    if (filterOverseership) return congregations.filter(c => c.overseership_id === filterOverseership);
    return congregations;
  }, [congregations, filterOverseership]);

  const filteredUsers = useMemo(() => {
    let list = users;
    if (filterRole !== "All") list = list.filter(u => u.role === filterRole);
    if (filterCongregation) {
      // Show users assigned to this congregation OR whose primary congregation_id matches
      list = list.filter(u => u.congregation_ids.includes(filterCongregation) || u.congregation_id === filterCongregation);
    } else if (filterOverseership) {
      const congIds = filteredCongsForFilter.map(c => c.id);
      list = list.filter(u => u.congregation_ids.some(id => congIds.includes(id)) || (u.congregation_id && congIds.includes(u.congregation_id)));
    }
    if (searchTerm.trim()) {
      const term = searchTerm.toLowerCase();
      list = list.filter(u => u.email.toLowerCase().includes(term));
    }
    return list;
  }, [users, filterRole, filterCongregation, filterOverseership, filteredCongsForFilter, searchTerm]);

  async function toggleAssignment(userId: string, congregationId: string) {
    setSaving(true);
    const existing = assignments.find(a => a.user_id === userId && a.congregation_id === congregationId);

    if (existing) {
      await supabase.from("user_congregation_assignments").delete().eq("id", existing.id);
      setAssignments(prev => prev.filter(a => a.id !== existing.id));
      setToast("Assignment removed");
    } else {
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

  const roles = ["All", ...Array.from(new Set(users.map(u => u.role)))];
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
        {error && <div className="rounded border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive">{error}</div>}

        {/* Filters */}
        <Card>
          <CardContent className="py-3">
            <div className="grid grid-cols-1 sm:grid-cols-5 gap-2">
              <div className="space-y-0.5">
                <Label className="text-[10px] text-muted-foreground">Role</Label>
                <select className="h-8 w-full rounded border border-input bg-background px-2 text-xs" value={filterRole} onChange={e => setFilterRole(e.target.value)}>
                  {roles.map(r => <option key={r} value={r}>{r}</option>)}
                </select>
              </div>
              <div className="space-y-0.5">
                <Label className="text-[10px] text-muted-foreground">Overseership</Label>
                <select className="h-8 w-full rounded border border-input bg-background px-2 text-xs" value={filterOverseership} onChange={e => { setFilterOverseership(e.target.value); setFilterCongregation(""); }}>
                  <option value="">All</option>
                  {overseerships.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
                </select>
              </div>
              <div className="space-y-0.5">
                <Label className="text-[10px] text-muted-foreground">Congregation</Label>
                <select className="h-8 w-full rounded border border-input bg-background px-2 text-xs" value={filterCongregation} onChange={e => setFilterCongregation(e.target.value)}>
                  <option value="">All</option>
                  {filteredCongsForFilter.map(c => <option key={c.id} value={c.id}>{c.code} — {c.name}</option>)}
                </select>
              </div>
              <div className="space-y-0.5">
                <Label className="text-[10px] text-muted-foreground">Search email</Label>
                <Input className="h-8 text-xs" placeholder="Type to search..." value={searchTerm} onChange={e => setSearchTerm(e.target.value)} />
              </div>
              <div className="flex items-end">
                <p className="text-xs text-muted-foreground">{filteredUsers.length} user{filteredUsers.length !== 1 ? "s" : ""}</p>
              </div>
            </div>
          </CardContent>
        </Card>

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
                {filteredUsers.length === 0 && <p className="text-xs text-muted-foreground py-4 text-center">No users match filters</p>}
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
