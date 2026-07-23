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

interface Officer {
  id: string; officer_code: string; first_name: string; last_name: string | null;
  initials: string | null; rank: string; congregation_id: string; is_active: boolean;
  service_status: string | null; mobile_number: string | null;
  start_date: string | null; end_date: string | null;
}
interface Congregation { id: string; name: string; code: string; overseership_id: string | null; }
interface HierarchyNode { id: string; name: string; level_type: string; parent_id: string | null; }

const RANKS = ["Underdeacon", "Priest", "Elder", "Evangelist", "Overseer", "Prophet", "Apostle"] as const;
const RANK_ORDER: Record<string, number> = { Underdeacon: 0, Priest: 1, Elder: 2, Evangelist: 3, Overseer: 4, Prophet: 5, Apostle: 6 };
const SERVICE_STATUSES = ["serving", "resting", "freedom_of_city"] as const;

function serviceLabel(s: string | null) {
  if (!s || s === "serving") return "Serving";
  if (s === "resting") return "Resting";
  if (s === "freedom_of_city") return "Freedom of the City";
  return s;
}

function autoInitials(first: string, last: string | null): string {
  const f = first.trim() ? first.trim()[0].toUpperCase() + "." : "";
  const l = last?.trim() ? last.trim()[0].toUpperCase() + "." : "";
  return f + l;
}

export default function OfficersPage() {
  const supabase = createClient();
  const [access, setAccess] = useState<UserHierarchyAccess | null>(null);
  const [officers, setOfficers] = useState<Officer[]>([]);
  const [congregations, setCongregations] = useState<Congregation[]>([]);
  const [hierarchyNodes, setHierarchyNodes] = useState<HierarchyNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [filterOverseership, setFilterOverseership] = useState("");
  const [filterCongregation, setFilterCongregation] = useState("");
  const [filterRank, setFilterRank] = useState("");
  const [searchTerm, setSearchTerm] = useState("");
  const [showInactive, setShowInactive] = useState(false);

  // Create form
  const [showCreate, setShowCreate] = useState(false);
  const [newCode, setNewCode] = useState("");
  const [newFirst, setNewFirst] = useState("");
  const [newLast, setNewLast] = useState("");
  const [newRank, setNewRank] = useState<string>("Priest");
  const [newCongId, setNewCongId] = useState("");
  const [newServiceStatus, setNewServiceStatus] = useState<string>("serving");
  const [newMobile, setNewMobile] = useState("");
  const [createFilterOverseership, setCreateFilterOverseership] = useState("");
  const [createSearchCong, setCreateSearchCong] = useState("");

  // Edit
  const [editOfficer, setEditOfficer] = useState<Officer | null>(null);
  const [editForm, setEditForm] = useState({ first_name: "", last_name: "", mobile_number: "", congregation_id: "", service_status: "serving", end_date: "" });

  // Deactivate
  const [deactivateId, setDeactivateId] = useState<string | null>(null);
  const [deactivateDate, setDeactivateDate] = useState(new Date().toISOString().split("T")[0]);

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
    const [{ data: offs }, { data: congs }, { data: nodes }] = await Promise.all([
      supabase.from("officers").select("*").order("officer_code"),
      supabase.from("congregations").select("id, name, code, overseership_id").order("name"),
      supabase.from("hierarchy_levels").select("id, name, level_type, parent_id").order("name"),
    ]);
    setOfficers(offs ?? []);
    setCongregations(congs ?? []);
    setHierarchyNodes(nodes ?? []);
    setLoading(false);
  }

  async function apiUpdate(id: string, fields: Record<string, unknown>) {
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) return false;
    const res = await fetch("/api/admin/update-officer", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${session.access_token}` },
      body: JSON.stringify({ id, ...fields }),
    });
    return res.ok;
  }

  // Derived
  const overseerships = useMemo(() => hierarchyNodes.filter(n => n.level_type === "Overseership"), [hierarchyNodes]);
  const filteredCongs = useMemo(() => filterOverseership ? congregations.filter(c => c.overseership_id === filterOverseership) : congregations, [congregations, filterOverseership]);
  const createCongs = useMemo(() => {
    let list = congregations;
    if (createFilterOverseership) list = list.filter(c => c.overseership_id === createFilterOverseership);
    if (createSearchCong.trim()) { const t = createSearchCong.toLowerCase(); list = list.filter(c => c.name.toLowerCase().includes(t) || c.code.toLowerCase().includes(t)); }
    return list;
  }, [congregations, createFilterOverseership, createSearchCong]);

  const filteredOfficers = useMemo(() => {
    let list = officers;
    if (!showInactive) list = list.filter(o => o.is_active);
    if (filterRank) list = list.filter(o => o.rank === filterRank);
    if (filterCongregation) list = list.filter(o => o.congregation_id === filterCongregation);
    else if (filterOverseership) { const ids = filteredCongs.map(c => c.id); list = list.filter(o => ids.includes(o.congregation_id)); }
    if (searchTerm.trim()) { const t = searchTerm.toLowerCase(); list = list.filter(o => o.officer_code.toLowerCase().includes(t) || o.first_name.toLowerCase().includes(t) || (o.last_name?.toLowerCase().includes(t) ?? false) || (o.initials?.toLowerCase().includes(t) ?? false)); }
    return [...list].sort((a, b) => { const ra = RANK_ORDER[a.rank] ?? 99, rb = RANK_ORDER[b.rank] ?? 99; return ra !== rb ? ra - rb : a.officer_code.localeCompare(b.officer_code); });
  }, [officers, showInactive, filterRank, filterCongregation, filterOverseership, filteredCongs, searchTerm]);

  function getCongName(id: string) { const c = congregations.find(x => x.id === id); return c ? `${c.code} — ${c.name}` : "—"; }

  async function handleCreate() {
    setError(null);
    if (!newCode.trim() || !newLast.trim() || !newCongId) { setError("Officer code, surname, and congregation are required"); return; }
    setSaving(true);
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) { setError("Session expired"); setSaving(false); return; }
    const initials = autoInitials(newFirst, newLast);
    const res = await fetch("/api/admin/create-officer", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${session.access_token}` },
      body: JSON.stringify({ officer_code: newCode.trim(), first_name: newFirst.trim() || newLast.trim(), last_name: newLast.trim(), initials, rank: newRank, congregation_id: newCongId, service_status: newServiceStatus, mobile_number: newMobile.trim() || null }),
    });
    const data = await res.json();
    setSaving(false);
    if (!res.ok) { setError(data.error ?? "Failed"); return; }
    setToast(`Officer ${newCode.trim()} created`);
    setNewCode(""); setNewFirst(""); setNewLast(""); setNewCongId(""); setNewServiceStatus("serving"); setNewMobile("");
    setCreateFilterOverseership(""); setCreateSearchCong(""); setShowCreate(false);
    await loadData();
  }

  function openEdit(o: Officer) {
    setEditOfficer(o);
    setEditForm({ first_name: o.first_name, last_name: o.last_name ?? "", mobile_number: o.mobile_number ?? "", congregation_id: o.congregation_id, service_status: o.service_status ?? "serving", end_date: o.end_date ?? "" });
  }

  async function handleSaveEdit() {
    if (!editOfficer) return;
    setSaving(true);
    const initials = autoInitials(editForm.first_name, editForm.last_name);
    await apiUpdate(editOfficer.id, { first_name: editForm.first_name, last_name: editForm.last_name || null, initials, mobile_number: editForm.mobile_number || null, congregation_id: editForm.congregation_id, service_status: editForm.service_status });
    setSaving(false);
    setEditOfficer(null);
    setToast("Officer updated");
    await loadData();
  }

  async function handleDeactivate() {
    if (!deactivateId) return;
    setSaving(true);
    await apiUpdate(deactivateId, { is_active: false, end_date: deactivateDate });
    setSaving(false);
    setDeactivateId(null);
    setToast("Officer deactivated");
    await loadData();
  }

  async function handleActivate(id: string) {
    setSaving(true);
    await apiUpdate(id, { is_active: true, end_date: null });
    setSaving(false);
    setToast("Officer activated");
    await loadData();
  }

  if (loading) return <div className="p-6 text-sm text-muted-foreground">Loading...</div>;
  if (access?.role !== "HO") return <div className="p-6 text-sm text-destructive">Access denied. HO only.</div>;

  return (
    <div className="max-w-6xl mx-auto px-4 py-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold">Officer Management</h1>
          <p className="text-xs text-muted-foreground">Create, edit, and manage all officers.</p>
        </div>
        <div className="flex gap-2">
          {!showCreate && <Button size="sm" onClick={() => setShowCreate(true)}>+ New Officer</Button>}
          <Button variant="outline" size="sm" onClick={() => window.history.back()}>← Back</Button>
        </div>
      </div>

      {toast && <div className="rounded border border-green-300 bg-green-50 p-2 text-xs text-green-800">{toast}</div>}
      {error && <div className="rounded border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive">{error}</div>}

      {/* Create Form */}
      {showCreate && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">New Officer</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="space-y-1"><Label className="text-xs">Code *</Label><Input className="h-8 text-xs" placeholder="P001" value={newCode} onChange={e => setNewCode(e.target.value)} /></div>
              <div className="space-y-1"><Label className="text-xs">Rank *</Label><select className="h-8 w-full rounded border border-input bg-background px-2 text-xs" value={newRank} onChange={e => setNewRank(e.target.value)}>{RANKS.map(r => <option key={r} value={r}>{r}</option>)}</select></div>
              <div className="space-y-1"><Label className="text-xs">Surname *</Label><Input className="h-8 text-xs" value={newLast} onChange={e => setNewLast(e.target.value)} /></div>
              <div className="space-y-1"><Label className="text-xs">First Name</Label><Input className="h-8 text-xs" value={newFirst} onChange={e => setNewFirst(e.target.value)} /></div>
              <div className="space-y-1"><Label className="text-xs">Mobile</Label><Input className="h-8 text-xs" placeholder="071..." value={newMobile} onChange={e => setNewMobile(e.target.value)} /></div>
              <div className="space-y-1"><Label className="text-xs">Service Status</Label><select className="h-8 w-full rounded border border-input bg-background px-2 text-xs" value={newServiceStatus} onChange={e => setNewServiceStatus(e.target.value)}>{SERVICE_STATUSES.map(s => <option key={s} value={s}>{serviceLabel(s)}</option>)}</select></div>
              <div className="space-y-1"><Label className="text-xs">Initials (auto)</Label><Input className="h-8 text-xs" value={autoInitials(newFirst, newLast)} disabled /></div>
            </div>
            <div className="space-y-2 rounded border border-dashed border-muted-foreground/30 p-3">
              <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Congregation</p>
              <div className="grid grid-cols-2 gap-2">
                <select className="h-8 w-full rounded border border-input bg-background px-2 text-xs" value={createFilterOverseership} onChange={e => { setCreateFilterOverseership(e.target.value); setNewCongId(""); }}><option value="">All Overseerships</option>{overseerships.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}</select>
                <Input className="h-8 text-xs" placeholder="Search..." value={createSearchCong} onChange={e => setCreateSearchCong(e.target.value)} />
              </div>
              <select className="h-8 w-full rounded border border-input bg-background px-2 text-xs" value={newCongId} onChange={e => setNewCongId(e.target.value)}><option value="">Select congregation... ({createCongs.length})</option>{createCongs.map(c => <option key={c.id} value={c.id}>{c.code} — {c.name}</option>)}</select>
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={handleCreate} disabled={saving}>{saving ? "Creating..." : "Create Officer"}</Button>
              <Button size="sm" variant="outline" onClick={() => setShowCreate(false)}>Cancel</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Edit Panel */}
      {editOfficer && (
        <Card className="border-primary/50">
          <CardHeader className="pb-2"><CardTitle className="text-sm">Edit: {editOfficer.officer_code} — {editOfficer.last_name}</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="space-y-1"><Label className="text-xs">Surname *</Label><Input className="h-8 text-xs" value={editForm.last_name} onChange={e => setEditForm(f => ({ ...f, last_name: e.target.value }))} /></div>
              <div className="space-y-1"><Label className="text-xs">First Name</Label><Input className="h-8 text-xs" value={editForm.first_name} onChange={e => setEditForm(f => ({ ...f, first_name: e.target.value }))} /></div>
              <div className="space-y-1"><Label className="text-xs">Mobile</Label><Input className="h-8 text-xs" value={editForm.mobile_number} onChange={e => setEditForm(f => ({ ...f, mobile_number: e.target.value }))} /></div>
              <div className="space-y-1"><Label className="text-xs">Service Status</Label><select className="h-8 w-full rounded border border-input bg-background px-2 text-xs" value={editForm.service_status} onChange={e => setEditForm(f => ({ ...f, service_status: e.target.value }))}>{SERVICE_STATUSES.map(s => <option key={s} value={s}>{serviceLabel(s)}</option>)}</select></div>
              <div className="space-y-1 col-span-2"><Label className="text-xs">Congregation</Label><select className="h-8 w-full rounded border border-input bg-background px-2 text-xs" value={editForm.congregation_id} onChange={e => setEditForm(f => ({ ...f, congregation_id: e.target.value }))}>{congregations.map(c => <option key={c.id} value={c.id}>{c.code} — {c.name}</option>)}</select></div>
              <div className="space-y-1"><Label className="text-xs">Initials (auto)</Label><Input className="h-8 text-xs" value={autoInitials(editForm.first_name, editForm.last_name)} disabled /></div>
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={handleSaveEdit} disabled={saving}>{saving ? "Saving..." : "Save"}</Button>
              <Button size="sm" variant="outline" onClick={() => setEditOfficer(null)}>Cancel</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Deactivate Modal */}
      {deactivateId && (
        <Card className="border-destructive/50">
          <CardContent className="py-4 space-y-3">
            <p className="text-sm font-medium">Confirm Deactivation</p>
            <div className="space-y-1">
              <Label className="text-xs">End Date</Label>
              <Input type="date" className="h-8 text-xs w-48" value={deactivateDate} onChange={e => setDeactivateDate(e.target.value)} />
            </div>
            <div className="flex gap-2">
              <Button size="sm" variant="destructive" onClick={handleDeactivate} disabled={saving}>Deactivate</Button>
              <Button size="sm" variant="outline" onClick={() => setDeactivateId(null)}>Cancel</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Filters */}
      <Card>
        <CardContent className="py-3">
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
            <div className="space-y-0.5"><Label className="text-[10px] text-muted-foreground">Overseership</Label><select className="h-8 w-full rounded border border-input bg-background px-2 text-xs" value={filterOverseership} onChange={e => { setFilterOverseership(e.target.value); setFilterCongregation(""); }}><option value="">All</option>{overseerships.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}</select></div>
            <div className="space-y-0.5"><Label className="text-[10px] text-muted-foreground">Congregation</Label><select className="h-8 w-full rounded border border-input bg-background px-2 text-xs" value={filterCongregation} onChange={e => setFilterCongregation(e.target.value)}><option value="">All</option>{filteredCongs.map(c => <option key={c.id} value={c.id}>{c.code} — {c.name}</option>)}</select></div>
            <div className="space-y-0.5"><Label className="text-[10px] text-muted-foreground">Rank</Label><select className="h-8 w-full rounded border border-input bg-background px-2 text-xs" value={filterRank} onChange={e => setFilterRank(e.target.value)}><option value="">All</option>{RANKS.map(r => <option key={r} value={r}>{r}</option>)}</select></div>
            <div className="space-y-0.5"><Label className="text-[10px] text-muted-foreground">Search</Label><Input className="h-8 text-xs" placeholder="Code, name..." value={searchTerm} onChange={e => setSearchTerm(e.target.value)} /></div>
            <div className="flex items-end"><label className="flex items-center gap-1.5 text-xs cursor-pointer"><input type="checkbox" checked={showInactive} onChange={e => setShowInactive(e.target.checked)} className="rounded" />Show inactive</label></div>
          </div>
        </CardContent>
      </Card>

      {/* Officers Table */}
      <Card>
        <CardHeader className="pb-2"><CardTitle className="text-xs">{filteredOfficers.length} Officer{filteredOfficers.length !== 1 ? "s" : ""}</CardTitle></CardHeader>
        <CardContent>
          {filteredOfficers.length === 0 ? <p className="text-xs text-muted-foreground">No officers found.</p> : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead><tr className="border-b text-left text-muted-foreground">
                  <th className="pb-2 pr-2">Code</th><th className="pb-2 pr-2">Initials</th><th className="pb-2 pr-2">Surname</th><th className="pb-2 pr-2">Rank</th><th className="pb-2 pr-2">Service</th><th className="pb-2 pr-2">Congregation</th><th className="pb-2 pr-2">Status</th><th className="pb-2">Actions</th>
                </tr></thead>
                <tbody>
                  {filteredOfficers.map(o => (
                    <tr key={o.id} className={`border-b ${!o.is_active ? "bg-red-50/60 opacity-70" : "hover:bg-muted/30"}`}>
                      <td className="py-2 pr-2 font-mono font-medium">{o.officer_code}</td>
                      <td className="py-2 pr-2 text-muted-foreground">{o.initials ?? autoInitials(o.first_name, o.last_name)}</td>
                      <td className="py-2 pr-2">{o.last_name ?? o.first_name}</td>
                      <td className="py-2 pr-2"><Badge variant="outline" className="text-[9px]">{o.rank}</Badge></td>
                      <td className="py-2 pr-2">
                        <Badge variant="outline" className={`text-[9px] ${o.service_status === "serving" ? "bg-green-50 text-green-700 border-green-300" : o.service_status === "resting" ? "bg-amber-50 text-amber-700 border-amber-300" : "bg-blue-50 text-blue-700 border-blue-300"}`}>
                          {serviceLabel(o.service_status)}
                        </Badge>
                      </td>
                      <td className="py-2 pr-2 text-muted-foreground text-[10px]">{getCongName(o.congregation_id)}</td>
                      <td className="py-2 pr-2">
                        {o.is_active
                          ? <Badge className="text-[9px] bg-green-100 text-green-700 border-green-300">Active</Badge>
                          : <Badge variant="destructive" className="text-[9px]">Inactive{o.end_date ? ` (${o.end_date})` : ""}</Badge>}
                      </td>
                      <td className="py-2">
                        <div className="flex gap-1">
                          <Button size="sm" variant="ghost" className="h-6 text-[10px] px-2" onClick={() => openEdit(o)}>Edit</Button>
                          {o.is_active
                            ? <Button size="sm" variant="ghost" className="h-6 text-[10px] px-2 text-destructive" onClick={() => { setDeactivateId(o.id); setDeactivateDate(new Date().toISOString().split("T")[0]); }}>Deactivate</Button>
                            : <Button size="sm" variant="ghost" className="h-6 text-[10px] px-2 text-green-700" onClick={() => handleActivate(o.id)}>Activate</Button>}
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
