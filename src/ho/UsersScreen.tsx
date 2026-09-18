// HO User Management (/ho/users) — list (with filters), edit role/congregation,
// activate/deactivate, and inline create (role assignment). Users list + writes go
// through the admin-write Edge Function (list_users / create_user / update_user);
// congregations & hierarchy are read directly. Ported from f6145ff1 admin/users(+create).
import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { getUserAccess, hasPermission } from "@/lib/permissions";
import { adminApi, type AdminUserRow } from "@/ho/adminApi";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import type { Role, UserHierarchyAccess } from "@/lib/types";

interface UserRow extends AdminUserRow { status: string; }
interface Congregation { id: string; name: string; code: string; overseership_id: string | null; eldership_id: string | null; }
interface HierarchyNode { id: string; name: string; level_type: string; parent_id: string | null; }

const ROLES = ["Treasurer", "Auditor", "Chairperson", "Elder", "Overseer", "Apostle", "HO", "Secretary"];
const ROLE_SCOPE: Record<string, string> = { Treasurer: "Congregation", Auditor: "Congregation", Chairperson: "Congregation", Secretary: "Congregation", Elder: "Eldership", Overseer: "Overseership", Apostle: "Apostleship", HO: "District" };
const CONG_ROLES = ["Treasurer", "Auditor", "Chairperson", "Secretary"];

export function UsersScreen() {
  const supabase = createClient();
  const [access, setAccess] = useState<UserHierarchyAccess | null>(null);
  const [users, setUsers] = useState<UserRow[]>([]);
  const [congregations, setCongregations] = useState<Congregation[]>([]);
  const [hierarchyNodes, setHierarchyNodes] = useState<HierarchyNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [filterRole, setFilterRole] = useState("");
  const [filterOverseership, setFilterOverseership] = useState("");
  const [filterCongregation, setFilterCongregation] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [showInactive, setShowInactive] = useState(false);

  const [editUser, setEditUser] = useState<UserRow | null>(null);
  const [editRole, setEditRole] = useState("");
  const [editCongId, setEditCongId] = useState("");

  // Create
  const [showCreate, setShowCreate] = useState(false);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [cRole, setCRole] = useState("Treasurer");
  const [cCongId, setCCongId] = useState("");
  const [cHierId, setCHierId] = useState("");
  const [cOverseership, setCOverseership] = useState("");
  const [cSearch, setCSearch] = useState("");

  const role = access?.role as Role | undefined;

  useEffect(() => { if (toast) { const t = setTimeout(() => setToast(null), 4000); return () => clearTimeout(t); } }, [toast]);

  async function loadData() {
    setLoading(true);
    const ua = await getUserAccess();
    setAccess(ua);
    if (!ua || ua.role !== "HO") { setLoading(false); return; }
    const [congsRes, nodesRes, usersRes] = await Promise.all([
      supabase.from("congregations").select("id, name, code, overseership_id, eldership_id").order("name"),
      supabase.from("hierarchy_levels").select("id, name, level_type, parent_id").order("name"),
      adminApi.listUsers(),
    ]);
    setCongregations((congsRes.data ?? []) as Congregation[]);
    setHierarchyNodes((nodesRes.data ?? []) as HierarchyNode[]);
    if (usersRes.ok && usersRes.data?.users) setUsers(usersRes.data.users.map((u) => ({ ...u, status: u.status ?? "active" })));
    else setError(usersRes.error ?? "Failed to load users (admin-write must be deployed).");
    setLoading(false);
  }
  useEffect(() => { void loadData(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const overseerships = useMemo(() => hierarchyNodes.filter((n) => n.level_type === "Overseership"), [hierarchyNodes]);
  const filteredCongsForFilter = useMemo(() => (filterOverseership ? congregations.filter((c) => c.overseership_id === filterOverseership) : congregations), [congregations, filterOverseership]);
  const createCongs = useMemo(() => {
    let list = congregations;
    if (cOverseership) list = list.filter((c) => c.overseership_id === cOverseership);
    if (cSearch.trim()) { const t = cSearch.toLowerCase(); list = list.filter((c) => c.name.toLowerCase().includes(t) || c.code.toLowerCase().includes(t)); }
    return list;
  }, [congregations, cOverseership, cSearch]);

  const filteredUsers = useMemo(() => {
    let list = users;
    if (!showInactive) list = list.filter((u) => u.status === "active");
    if (filterRole) list = list.filter((u) => u.role === filterRole);
    if (filterCongregation) list = list.filter((u) => u.congregation_id === filterCongregation);
    else if (filterOverseership) { const ids = filteredCongsForFilter.map((c) => c.id); list = list.filter((u) => u.congregation_id && ids.includes(u.congregation_id)); }
    if (searchTerm.trim()) { const t = searchTerm.toLowerCase(); list = list.filter((u) => u.email.toLowerCase().includes(t) || u.role.toLowerCase().includes(t)); }
    return list;
  }, [users, showInactive, filterRole, filterCongregation, filterOverseership, filteredCongsForFilter, searchTerm]);

  const congName = (id: string | null) => { if (!id) return "—"; const c = congregations.find((x) => x.id === id); return c ? `${c.code} — ${c.name}` : "—"; };

  const cScope = ROLE_SCOPE[cRole] ?? "Congregation";
  const cNeedsCong = CONG_ROLES.includes(cRole);
  const cHierNodes = useMemo(() => hierarchyNodes.filter((n) => n.level_type === cScope), [hierarchyNodes, cScope]);

  function openEdit(u: UserRow) { setEditUser(u); setEditRole(u.role); setEditCongId(u.congregation_id ?? ""); }

  async function handleSaveEdit() {
    if (!editUser) return;
    setSaving(true);
    const r = await adminApi.updateUser({ user_id: editUser.user_id, role: editRole, congregation_id: editCongId || null });
    setSaving(false);
    if (!r.ok) { setError(r.error ?? "Update failed"); return; }
    setEditUser(null); setToast("User updated"); await loadData();
  }

  async function setStatus(userId: string, status: "active" | "inactive") {
    if (status === "inactive" && !window.confirm("Deactivate this user? They will no longer be able to log in.")) return;
    setSaving(true);
    const r = await adminApi.updateUser({ user_id: userId, status });
    setSaving(false);
    if (r.ok) { setUsers((prev) => prev.map((u) => (u.user_id === userId ? { ...u, status } : u))); setToast(status === "active" ? "User activated" : "User deactivated"); }
    else setError(r.error ?? "Failed");
  }

  async function handleCreate() {
    setError(null);
    if (!email || !password) { setError("Email and password are required"); return; }
    if (cNeedsCong && !cCongId) { setError("Please select a congregation for this role"); return; }
    if (!cNeedsCong && !cHierId) { setError("Please select a hierarchy node for this role"); return; }
    setSaving(true);
    const r = await adminApi.createUser({ email, password, role: cRole, congregation_id: cNeedsCong ? cCongId : null, hierarchy_id: cNeedsCong ? null : cHierId, scope_level: cScope });
    setSaving(false);
    if (!r.ok) { setError(r.error ?? "Failed to create user"); return; }
    setToast(`User ${email} created as ${cRole}`);
    setEmail(""); setPassword(""); setCCongId(""); setCHierId(""); setShowCreate(false);
    await loadData();
  }

  if (loading) return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
  if (!role || !hasPermission(role, "admin.manage_users")) return <div className="p-6 text-sm text-destructive">Access denied. HO only.</div>;

  return (
    <div className="max-w-6xl mx-auto px-4 py-6 space-y-4">
      <div className="flex items-center justify-between">
        <div><h1 className="text-lg font-bold">User Management</h1><p className="text-xs text-muted-foreground">View, edit, assign roles, and manage all system users.</p></div>
        {!showCreate && <Button size="sm" onClick={() => setShowCreate(true)}>+ Create User</Button>}
      </div>

      {toast && <div className="rounded border border-green-300 bg-green-50 p-2 text-xs text-green-800">{toast}</div>}
      {error && <div className="rounded border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive">{error}</div>}

      {showCreate && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Create User & Assign Access</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="space-y-1"><Label className="text-xs">Email *</Label><Input className="h-8 text-xs" type="email" placeholder="user@example.com" value={email} onChange={(e) => setEmail(e.target.value)} /></div>
              <div className="space-y-1"><Label className="text-xs">Temp Password *</Label><Input className="h-8 text-xs" type="text" placeholder="Min 6 chars" value={password} onChange={(e) => setPassword(e.target.value)} /></div>
              <div className="space-y-1"><Label className="text-xs">Role *</Label><select className="h-8 w-full rounded border border-input bg-background px-2 text-xs" value={cRole} onChange={(e) => { setCRole(e.target.value); setCCongId(""); setCHierId(""); }}>{ROLES.map((r) => <option key={r} value={r}>{r}</option>)}</select><Badge variant="outline" className="text-[9px] mt-1">Scope: {cScope}</Badge></div>
            </div>
            {cNeedsCong ? (
              <div className="space-y-2 rounded border border-dashed border-muted-foreground/30 p-3">
                <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Congregation</p>
                <div className="grid grid-cols-2 gap-2">
                  <select className="h-8 w-full rounded border border-input bg-background px-2 text-xs" value={cOverseership} onChange={(e) => { setCOverseership(e.target.value); setCCongId(""); }}><option value="">All Overseerships</option>{overseerships.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select>
                  <Input className="h-8 text-xs" placeholder="Search…" value={cSearch} onChange={(e) => setCSearch(e.target.value)} />
                </div>
                <select className="h-8 w-full rounded border border-input bg-background px-2 text-xs" value={cCongId} onChange={(e) => setCCongId(e.target.value)}><option value="">Select congregation… ({createCongs.length})</option>{createCongs.map((c) => <option key={c.id} value={c.id}>{c.code} — {c.name}</option>)}</select>
              </div>
            ) : (
              <div className="space-y-1"><Label className="text-xs">{cScope} *</Label><select className="h-8 w-full rounded border border-input bg-background px-2 text-xs" value={cHierId} onChange={(e) => setCHierId(e.target.value)}><option value="">Select {cScope.toLowerCase()}…</option>{cHierNodes.map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}</select></div>
            )}
            <div className="flex gap-2"><Button size="sm" onClick={() => void handleCreate()} disabled={saving}>{saving ? "Creating…" : "Create User"}</Button><Button size="sm" variant="outline" onClick={() => setShowCreate(false)}>Cancel</Button></div>
          </CardContent>
        </Card>
      )}

      {editUser && (
        <Card className="border-primary/50">
          <CardHeader className="pb-2"><CardTitle className="text-sm">Edit: {editUser.email}</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="space-y-1"><Label className="text-xs">Role</Label><select className="h-8 w-full rounded border border-input bg-background px-2 text-xs" value={editRole} onChange={(e) => setEditRole(e.target.value)}>{ROLES.map((r) => <option key={r} value={r}>{r}</option>)}</select></div>
              <div className="space-y-1"><Label className="text-xs">Congregation</Label><select className="h-8 w-full rounded border border-input bg-background px-2 text-xs" value={editCongId} onChange={(e) => setEditCongId(e.target.value)}><option value="">None (higher scope)</option>{congregations.map((c) => <option key={c.id} value={c.id}>{c.code} — {c.name}</option>)}</select></div>
              <div className="flex items-end gap-2"><Button size="sm" onClick={() => void handleSaveEdit()} disabled={saving}>{saving ? "…" : "Save"}</Button><Button size="sm" variant="outline" onClick={() => setEditUser(null)}>Cancel</Button></div>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="py-3">
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
            <div className="space-y-0.5"><Label className="text-[10px] text-muted-foreground">Role</Label><select className="h-8 w-full rounded border border-input bg-background px-2 text-xs" value={filterRole} onChange={(e) => setFilterRole(e.target.value)}><option value="">All</option>{ROLES.map((r) => <option key={r} value={r}>{r}</option>)}</select></div>
            <div className="space-y-0.5"><Label className="text-[10px] text-muted-foreground">Overseership</Label><select className="h-8 w-full rounded border border-input bg-background px-2 text-xs" value={filterOverseership} onChange={(e) => { setFilterOverseership(e.target.value); setFilterCongregation(""); }}><option value="">All</option>{overseerships.map((o) => <option key={o.id} value={o.id}>{o.name}</option>)}</select></div>
            <div className="space-y-0.5"><Label className="text-[10px] text-muted-foreground">Congregation</Label><select className="h-8 w-full rounded border border-input bg-background px-2 text-xs" value={filterCongregation} onChange={(e) => setFilterCongregation(e.target.value)}><option value="">All</option>{filteredCongsForFilter.map((c) => <option key={c.id} value={c.id}>{c.code} — {c.name}</option>)}</select></div>
            <div className="space-y-0.5"><Label className="text-[10px] text-muted-foreground">Search</Label><Input className="h-8 text-xs" placeholder="Email…" value={searchTerm} onChange={(e) => setSearchTerm(e.target.value)} /></div>
            <div className="flex items-end"><label className="flex items-center gap-1.5 text-xs cursor-pointer"><input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} className="rounded" />Show inactive</label></div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-xs">{filteredUsers.length} User{filteredUsers.length !== 1 ? "s" : ""}</CardTitle></CardHeader>
        <CardContent className="overflow-x-auto">
          {filteredUsers.length === 0 ? <p className="text-xs text-muted-foreground">No users found.</p> : (
            <table className="w-full text-xs">
              <thead><tr className="border-b text-left text-muted-foreground"><th className="pb-2 pr-3">Email</th><th className="pb-2 pr-3">Role</th><th className="pb-2 pr-3">Scope</th><th className="pb-2 pr-3">Congregation</th><th className="pb-2 pr-3">Status</th><th className="pb-2">Actions</th></tr></thead>
              <tbody>
                {filteredUsers.map((u) => (
                  <tr key={u.user_id} className={`border-b ${u.status !== "active" ? "bg-red-50/60 opacity-70" : "hover:bg-muted/30"}`}>
                    <td className="py-2 pr-3 font-medium">{u.email}</td>
                    <td className="py-2 pr-3"><Badge variant="outline" className="text-[9px]">{u.role}</Badge></td>
                    <td className="py-2 pr-3 text-muted-foreground">{u.scope_level}</td>
                    <td className="py-2 pr-3 text-muted-foreground text-[10px]">{congName(u.congregation_id)}</td>
                    <td className="py-2 pr-3">{u.status === "active" ? <Badge className="text-[9px] bg-green-100 text-green-700 border-green-300">Active</Badge> : <Badge variant="destructive" className="text-[9px]">Inactive</Badge>}</td>
                    <td className="py-2"><div className="flex gap-1"><Button size="sm" variant="ghost" className="h-6 text-[10px] px-2" onClick={() => openEdit(u)}>Edit</Button>{u.status === "active" ? <Button size="sm" variant="ghost" className="h-6 text-[10px] px-2 text-destructive" onClick={() => void setStatus(u.user_id, "inactive")}>Deactivate</Button> : <Button size="sm" variant="ghost" className="h-6 text-[10px] px-2 text-green-700" onClick={() => void setStatus(u.user_id, "active")}>Activate</Button>}</div></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
