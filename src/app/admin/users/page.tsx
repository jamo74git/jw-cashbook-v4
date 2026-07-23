"use client";

import { useEffect, useState, useMemo } from "react";
import { useRouter } from "next/navigation";
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
  hierarchy_id: string | null;
  status: string;
}

interface Congregation { id: string; name: string; code: string; overseership_id: string | null; }
interface HierarchyNode { id: string; name: string; level_type: string; parent_id: string | null; }

const ROLES = ["Treasurer", "Auditor", "Chairperson", "Elder", "Overseer", "Apostle", "HO", "Secretary"];

export default function UserManagementPage() {
  const supabase = createClient();
  const router = useRouter();
  const [access, setAccess] = useState<UserHierarchyAccess | null>(null);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [congregations, setCongregations] = useState<Congregation[]>([]);
  const [hierarchyNodes, setHierarchyNodes] = useState<HierarchyNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [filterRole, setFilterRole] = useState("");
  const [filterOverseership, setFilterOverseership] = useState("");
  const [filterCongregation, setFilterCongregation] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [showInactive, setShowInactive] = useState(false);

  // Edit
  const [editUser, setEditUser] = useState<UserRow | null>(null);
  const [editRole, setEditRole] = useState("");
  const [editCongId, setEditCongId] = useState("");

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
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) { setLoading(false); return; }

    const [congsRes, nodesRes, usersRes] = await Promise.all([
      supabase.from("congregations").select("id, name, code, overseership_id").order("name"),
      supabase.from("hierarchy_levels").select("id, name, level_type, parent_id").order("name"),
      fetch("/api/admin/list-users", { headers: { "Authorization": `Bearer ${session.access_token}` } }),
    ]);

    setCongregations(congsRes.data ?? []);
    setHierarchyNodes(nodesRes.data ?? []);

    const userData = await usersRes.json();
    if (userData.users) {
      setUsers(userData.users.map((u: UserRow) => ({ ...u, status: "active" })));
    } else {
      setError(userData.error ?? "Failed to load users");
    }
    setLoading(false);
  }

  // Derived
  const overseerships = useMemo(() => hierarchyNodes.filter(n => n.level_type === "Overseership"), [hierarchyNodes]);
  const filteredCongsForFilter = useMemo(() => filterOverseership ? congregations.filter(c => c.overseership_id === filterOverseership) : congregations, [congregations, filterOverseership]);

  const filteredUsers = useMemo(() => {
    let list = users;
    if (!showInactive) list = list.filter(u => u.status === "active");
    if (filterRole) list = list.filter(u => u.role === filterRole);
    if (filterCongregation) list = list.filter(u => u.congregation_id === filterCongregation);
    else if (filterOverseership) {
      const congIds = filteredCongsForFilter.map(c => c.id);
      list = list.filter(u => u.congregation_id && congIds.includes(u.congregation_id));
    }
    if (searchTerm.trim()) {
      const t = searchTerm.toLowerCase();
      list = list.filter(u => u.email.toLowerCase().includes(t) || u.role.toLowerCase().includes(t));
    }
    return list;
  }, [users, showInactive, filterRole, filterCongregation, filterOverseership, filteredCongsForFilter, searchTerm]);

  function getCongName(id: string | null) {
    if (!id) return "—";
    const c = congregations.find(x => x.id === id);
    return c ? `${c.code} — ${c.name}` : "—";
  }

  function openEdit(u: UserRow) {
    setEditUser(u);
    setEditRole(u.role);
    setEditCongId(u.congregation_id ?? "");
  }

  async function handleSaveEdit() {
    if (!editUser) return;
    setSaving(true);
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) { setSaving(false); return; }

    // Update user_hierarchy_access via service_role API
    const res = await fetch("/api/admin/update-user", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${session.access_token}` },
      body: JSON.stringify({ user_id: editUser.user_id, role: editRole, congregation_id: editCongId || null }),
    });
    const data = await res.json();
    setSaving(false);
    if (!res.ok) { setError(data.error ?? "Update failed"); return; }
    setEditUser(null);
    setToast("User updated");
    await loadData();
  }

  async function handleDeactivate(userId: string) {
    if (!confirm("Deactivate this user? They will no longer be able to log in.")) return;
    setSaving(true);
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) { setSaving(false); return; }

    const res = await fetch("/api/admin/update-user", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${session.access_token}` },
      body: JSON.stringify({ user_id: userId, status: "inactive" }),
    });
    setSaving(false);
    if (res.ok) {
      setUsers(prev => prev.map(u => u.user_id === userId ? { ...u, status: "inactive" } : u));
      setToast("User deactivated");
    }
  }

  async function handleActivate(userId: string) {
    setSaving(true);
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) { setSaving(false); return; }

    const res = await fetch("/api/admin/update-user", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${session.access_token}` },
      body: JSON.stringify({ user_id: userId, status: "active" }),
    });
    setSaving(false);
    if (res.ok) {
      setUsers(prev => prev.map(u => u.user_id === userId ? { ...u, status: "active" } : u));
      setToast("User activated");
    }
  }

  if (loading) return <div className="p-6 text-sm text-muted-foreground">Loading...</div>;
  if (access?.role !== "HO") return <div className="p-6 text-sm text-destructive">Access denied. HO only.</div>;

  return (
    <div className="max-w-6xl mx-auto px-4 py-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold">User Management</h1>
          <p className="text-xs text-muted-foreground">View, edit, and manage all system users.</p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" onClick={() => router.push("/admin/users/create")}>+ Create User</Button>
          <Button variant="outline" size="sm" onClick={() => router.push("/admin")}>← Back</Button>
        </div>
      </div>

      {toast && <div className="rounded border border-green-300 bg-green-50 p-2 text-xs text-green-800">{toast}</div>}
      {error && <div className="rounded border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive">{error}</div>}

      {/* Edit Panel */}
      {editUser && (
        <Card className="border-primary/50">
          <CardHeader className="pb-2"><CardTitle className="text-sm">Edit: {editUser.email}</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">Role</Label>
                <select className="h-8 w-full rounded border border-input bg-background px-2 text-xs" value={editRole} onChange={e => setEditRole(e.target.value)}>
                  {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
                </select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Congregation</Label>
                <select className="h-8 w-full rounded border border-input bg-background px-2 text-xs" value={editCongId} onChange={e => setEditCongId(e.target.value)}>
                  <option value="">None (higher scope)</option>
                  {congregations.map(c => <option key={c.id} value={c.id}>{c.code} — {c.name}</option>)}
                </select>
              </div>
              <div className="flex items-end gap-2">
                <Button size="sm" onClick={handleSaveEdit} disabled={saving}>{saving ? "..." : "Save"}</Button>
                <Button size="sm" variant="outline" onClick={() => setEditUser(null)}>Cancel</Button>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Filters */}
      <Card>
        <CardContent className="py-3">
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
            <div className="space-y-0.5"><Label className="text-[10px] text-muted-foreground">Role</Label><select className="h-8 w-full rounded border border-input bg-background px-2 text-xs" value={filterRole} onChange={e => setFilterRole(e.target.value)}><option value="">All</option>{ROLES.map(r => <option key={r} value={r}>{r}</option>)}</select></div>
            <div className="space-y-0.5"><Label className="text-[10px] text-muted-foreground">Overseership</Label><select className="h-8 w-full rounded border border-input bg-background px-2 text-xs" value={filterOverseership} onChange={e => { setFilterOverseership(e.target.value); setFilterCongregation(""); }}><option value="">All</option>{overseerships.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}</select></div>
            <div className="space-y-0.5"><Label className="text-[10px] text-muted-foreground">Congregation</Label><select className="h-8 w-full rounded border border-input bg-background px-2 text-xs" value={filterCongregation} onChange={e => setFilterCongregation(e.target.value)}><option value="">All</option>{filteredCongsForFilter.map(c => <option key={c.id} value={c.id}>{c.code} — {c.name}</option>)}</select></div>
            <div className="space-y-0.5"><Label className="text-[10px] text-muted-foreground">Search</Label><Input className="h-8 text-xs" placeholder="Email..." value={searchTerm} onChange={e => setSearchTerm(e.target.value)} /></div>
            <div className="flex items-end"><label className="flex items-center gap-1.5 text-xs cursor-pointer"><input type="checkbox" checked={showInactive} onChange={e => setShowInactive(e.target.checked)} className="rounded" />Show inactive</label></div>
          </div>
        </CardContent>
      </Card>

      {/* Users Table */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-xs">{filteredUsers.length} User{filteredUsers.length !== 1 ? "s" : ""}</CardTitle></CardHeader>
        <CardContent>
          {filteredUsers.length === 0 ? <p className="text-xs text-muted-foreground">No users found.</p> : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead><tr className="border-b text-left text-muted-foreground">
                  <th className="pb-2 pr-3">Email</th><th className="pb-2 pr-3">Role</th><th className="pb-2 pr-3">Scope</th><th className="pb-2 pr-3">Congregation</th><th className="pb-2 pr-3">Status</th><th className="pb-2">Actions</th>
                </tr></thead>
                <tbody>
                  {filteredUsers.map(u => (
                    <tr key={u.user_id} className={`border-b ${u.status !== "active" ? "bg-red-50/60 opacity-70" : "hover:bg-muted/30"}`}>
                      <td className="py-2 pr-3 font-medium">{u.email}</td>
                      <td className="py-2 pr-3"><Badge variant="outline" className="text-[9px]">{u.role}</Badge></td>
                      <td className="py-2 pr-3 text-muted-foreground">{u.scope_level}</td>
                      <td className="py-2 pr-3 text-muted-foreground text-[10px]">{getCongName(u.congregation_id)}</td>
                      <td className="py-2 pr-3">
                        {u.status === "active"
                          ? <Badge className="text-[9px] bg-green-100 text-green-700 border-green-300">Active</Badge>
                          : <Badge variant="destructive" className="text-[9px]">Inactive</Badge>}
                      </td>
                      <td className="py-2">
                        <div className="flex gap-1">
                          <Button size="sm" variant="ghost" className="h-6 text-[10px] px-2" onClick={() => openEdit(u)}>Edit</Button>
                          {u.status === "active"
                            ? <Button size="sm" variant="ghost" className="h-6 text-[10px] px-2 text-destructive" onClick={() => handleDeactivate(u.user_id)}>Deactivate</Button>
                            : <Button size="sm" variant="ghost" className="h-6 text-[10px] px-2 text-green-700" onClick={() => handleActivate(u.user_id)}>Activate</Button>}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
