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

interface Officer { id: string; officer_code: string; first_name: string; last_name: string | null; rank: string; congregation_id: string; is_active: boolean; service_status: string | null; }
interface Congregation { id: string; name: string; code: string; overseership_id: string | null; }
interface HierarchyNode { id: string; name: string; level_type: string; parent_id: string | null; }

// Sort sequence as requested
const RANKS = ["Underdeacon", "Priest", "Elder", "Evangelist", "Overseer", "Prophet", "Apostle"] as const;
const RANK_ORDER: Record<string, number> = { Underdeacon: 0, Priest: 1, Elder: 2, Evangelist: 3, Overseer: 4, Prophet: 5, Apostle: 6 };
const SERVICE_STATUSES = ["serving", "resting", "freedom_of_city"] as const;

function serviceLabel(s: string | null) {
  if (!s || s === "serving") return "Serving";
  if (s === "resting") return "Resting";
  if (s === "freedom_of_city") return "Freedom of the City";
  return s;
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
  const [createFilterOverseership, setCreateFilterOverseership] = useState("");
  const [createSearchCong, setCreateSearchCong] = useState("");

  // Edit
  const [editId, setEditId] = useState<string | null>(null);
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

  // Derived
  const overseerships = useMemo(() => hierarchyNodes.filter(n => n.level_type === "Overseership"), [hierarchyNodes]);

  const filteredCongs = useMemo(() => {
    if (filterOverseership) return congregations.filter(c => c.overseership_id === filterOverseership);
    return congregations;
  }, [congregations, filterOverseership]);

  // Create form: congregations filtered by overseership + search
  const createCongs = useMemo(() => {
    let list = congregations;
    if (createFilterOverseership) list = list.filter(c => c.overseership_id === createFilterOverseership);
    if (createSearchCong.trim()) {
      const term = createSearchCong.toLowerCase();
      list = list.filter(c => c.name.toLowerCase().includes(term) || c.code.toLowerCase().includes(term));
    }
    return list;
  }, [congregations, createFilterOverseership, createSearchCong]);

  const filteredOfficers = useMemo(() => {
    let list = officers;
    if (!showInactive) list = list.filter(o => o.is_active);
    if (filterRank) list = list.filter(o => o.rank === filterRank);
    if (filterCongregation) list = list.filter(o => o.congregation_id === filterCongregation);
    else if (filterOverseership) {
      const congIds = filteredCongs.map(c => c.id);
      list = list.filter(o => congIds.includes(o.congregation_id));
    }
    if (searchTerm.trim()) {
      const term = searchTerm.toLowerCase();
      list = list.filter(o =>
        o.officer_code.toLowerCase().includes(term) ||
        o.first_name.toLowerCase().includes(term) ||
        (o.last_name?.toLowerCase().includes(term) ?? false)
      );
    }
    // Sort by rank order then officer_code
    list = [...list].sort((a, b) => {
      const ra = RANK_ORDER[a.rank] ?? 99;
      const rb = RANK_ORDER[b.rank] ?? 99;
      if (ra !== rb) return ra - rb;
      return a.officer_code.localeCompare(b.officer_code);
    });
    return list;
  }, [officers, showInactive, filterRank, filterCongregation, filterOverseership, filteredCongs, searchTerm]);

  function getCongName(congId: string) {
    const c = congregations.find(x => x.id === congId);
    return c ? `${c.code} — ${c.name}` : "Unknown";
  }

  async function handleCreate() {
    setError(null);
    if (!newCode.trim() || !newFirst.trim() || !newCongId) {
      setError("Officer code, first name, and congregation are required");
      return;
    }
    setSaving(true);

    // Use session token to call an API that uses service_role (bypass RLS)
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) { setError("Session expired"); setSaving(false); return; }

    const res = await fetch("/api/admin/create-officer", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${session.access_token}` },
      body: JSON.stringify({
        officer_code: newCode.trim(),
        first_name: newFirst.trim(),
        last_name: newLast.trim() || null,
        rank: newRank,
        congregation_id: newCongId,
        service_status: newServiceStatus,
      }),
    });
    const data = await res.json();
    setSaving(false);
    if (!res.ok) { setError(data.error ?? "Failed to create officer"); return; }

    setToast(`Officer ${newCode.trim()} created`);
    setNewCode(""); setNewFirst(""); setNewLast(""); setNewCongId(""); setNewServiceStatus("serving");
    setCreateFilterOverseership(""); setCreateSearchCong("");
    setShowCreate(false);
    await loadData();
  }

  async function handleReassign(officerId: string) {
    if (!editCongId) return;
    setSaving(true);
    await supabase.from("officers").update({ congregation_id: editCongId }).eq("id", officerId);
    setSaving(false);
    setEditId(null); setEditCongId("");
    setToast("Officer reassigned");
    await loadData();
  }

  async function toggleActive(officer: Officer) {
    setSaving(true);
    await supabase.from("officers").update({ is_active: !officer.is_active }).eq("id", officer.id);
    setSaving(false);
    setToast(officer.is_active ? "Officer deactivated" : "Officer activated");
    await loadData();
  }

  if (loading) return <div className="p-6 text-sm text-muted-foreground">Loading...</div>;
  if (access?.role !== "HO") return <div className="p-6 text-sm text-destructive">Access denied. HO only.</div>;

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold">Officer Management</h1>
          <p className="text-xs text-muted-foreground">Create, reassign, and manage all officers across the organisation.</p>
        </div>
        <div className="flex gap-2">
          {!showCreate && <Button size="sm" onClick={() => setShowCreate(true)}>+ New Officer</Button>}
          <Button variant="outline" size="sm" onClick={() => window.history.back()}>← Back</Button>
        </div>
      </div>

      {toast && <div className="rounded border border-green-300 bg-green-50 p-2 text-xs text-green-800">{toast}</div>}
      {error && <div className="rounded border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive">{error}</div>}

      {/* Create Officer Form */}
      {showCreate && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">New Officer</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">Officer Code *</Label>
                <Input className="h-8 text-xs" placeholder="e.g. P001" value={newCode} onChange={e => setNewCode(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Rank *</Label>
                <select className="h-8 w-full rounded border border-input bg-background px-2 text-xs" value={newRank} onChange={e => setNewRank(e.target.value)}>
                  {RANKS.map(r => <option key={r} value={r}>{r}</option>)}
                </select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">First Name *</Label>
                <Input className="h-8 text-xs" value={newFirst} onChange={e => setNewFirst(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Last Name</Label>
                <Input className="h-8 text-xs" value={newLast} onChange={e => setNewLast(e.target.value)} />
              </div>
            </div>
            {/* Congregation selection with filter */}
            <div className="space-y-2 rounded border border-dashed border-muted-foreground/30 p-3">
              <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Find Congregation</p>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-0.5">
                  <Label className="text-[10px] text-muted-foreground">Overseership</Label>
                  <select className="h-8 w-full rounded border border-input bg-background px-2 text-xs" value={createFilterOverseership} onChange={e => { setCreateFilterOverseership(e.target.value); setNewCongId(""); }}>
                    <option value="">All</option>
                    {overseerships.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
                  </select>
                </div>
                <div className="space-y-0.5">
                  <Label className="text-[10px] text-muted-foreground">Search</Label>
                  <Input className="h-8 text-xs" placeholder="Name or code..." value={createSearchCong} onChange={e => setCreateSearchCong(e.target.value)} />
                </div>
              </div>
              <div className="space-y-0.5">
                <Label className="text-xs">Congregation * <span className="text-muted-foreground font-normal">({createCongs.length} available)</span></Label>
                <select className="h-8 w-full rounded border border-input bg-background px-2 text-xs" value={newCongId} onChange={e => setNewCongId(e.target.value)}>
                  <option value="">Select congregation...</option>
                  {createCongs.map(c => <option key={c.id} value={c.id}>{c.code} — {c.name}</option>)}
                </select>
              </div>
            </div>
            <div className="space-y-1">
              <Label className="text-xs">Service Status</Label>
              <select className="h-8 w-full rounded border border-input bg-background px-2 text-xs" value={newServiceStatus} onChange={e => setNewServiceStatus(e.target.value)}>
                {SERVICE_STATUSES.map(s => <option key={s} value={s}>{serviceLabel(s)}</option>)}
              </select>
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={handleCreate} disabled={saving}>{saving ? "Creating..." : "Create Officer"}</Button>
              <Button size="sm" variant="outline" onClick={() => setShowCreate(false)}>Cancel</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Filters */}
      <Card>
        <CardContent className="py-3">
          <div className="grid grid-cols-1 sm:grid-cols-5 gap-2">
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
                {filteredCongs.map(c => <option key={c.id} value={c.id}>{c.code} — {c.name}</option>)}
              </select>
            </div>
            <div className="space-y-0.5">
              <Label className="text-[10px] text-muted-foreground">Rank</Label>
              <select className="h-8 w-full rounded border border-input bg-background px-2 text-xs" value={filterRank} onChange={e => setFilterRank(e.target.value)}>
                <option value="">All</option>
                {RANKS.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
            </div>
            <div className="space-y-0.5">
              <Label className="text-[10px] text-muted-foreground">Search</Label>
              <Input className="h-8 text-xs" placeholder="Code, name..." value={searchTerm} onChange={e => setSearchTerm(e.target.value)} />
            </div>
            <div className="flex items-end">
              <label className="flex items-center gap-1.5 text-xs cursor-pointer">
                <input type="checkbox" checked={showInactive} onChange={e => setShowInactive(e.target.checked)} className="rounded" />
                Show inactive
              </label>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Officers Table */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-xs">{filteredOfficers.length} Officer{filteredOfficers.length !== 1 ? "s" : ""}</CardTitle>
        </CardHeader>
        <CardContent>
          {filteredOfficers.length === 0 ? (
            <p className="text-xs text-muted-foreground">No officers found.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th className="pb-2 pr-3">Code</th>
                    <th className="pb-2 pr-3">Name</th>
                    <th className="pb-2 pr-3">Rank</th>
                    <th className="pb-2 pr-3">Service</th>
                    <th className="pb-2 pr-3">Congregation</th>
                    <th className="pb-2 pr-3">Status</th>
                    <th className="pb-2">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredOfficers.map(o => (
                    <tr key={o.id} className={`border-b last:border-0 ${!o.is_active ? "bg-red-50/50" : "hover:bg-muted/30"}`}>
                      <td className="py-2 pr-3 font-mono font-medium">{o.officer_code}</td>
                      <td className="py-2 pr-3">{o.first_name} {o.last_name ?? ""}</td>
                      <td className="py-2 pr-3"><Badge variant="outline" className="text-[9px]">{o.rank}</Badge></td>
                      <td className="py-2 pr-3">
                        <Badge
                          variant="outline"
                          className={`text-[9px] ${
                            o.service_status === "serving" ? "bg-green-50 text-green-700 border-green-300" :
                            o.service_status === "resting" ? "bg-amber-50 text-amber-700 border-amber-300" :
                            o.service_status === "freedom_of_city" ? "bg-blue-50 text-blue-700 border-blue-300" : ""
                          }`}
                        >
                          {serviceLabel(o.service_status)}
                        </Badge>
                      </td>
                      <td className="py-2 pr-3 text-muted-foreground">
                        {editId === o.id ? (
                          <div className="flex gap-1 items-center">
                            <select className="h-7 rounded border border-input bg-background px-1 text-[10px] w-40" value={editCongId} onChange={e => setEditCongId(e.target.value)}>
                              <option value="">Select...</option>
                              {congregations.map(c => <option key={c.id} value={c.id}>{c.code} — {c.name}</option>)}
                            </select>
                            <Button size="sm" className="h-6 text-[10px] px-2" onClick={() => handleReassign(o.id)} disabled={saving || !editCongId}>Save</Button>
                            <Button size="sm" variant="ghost" className="h-6 text-[10px] px-1" onClick={() => setEditId(null)}>✕</Button>
                          </div>
                        ) : getCongName(o.congregation_id)}
                      </td>
                      <td className="py-2 pr-3">
                        <Badge variant={o.is_active ? "default" : "destructive"} className={`text-[9px] ${!o.is_active ? "bg-red-100 text-red-700 border-red-300" : ""}`}>
                          {o.is_active ? "Active" : "Inactive"}
                        </Badge>
                      </td>
                      <td className="py-2">
                        <div className="flex gap-1">
                          {editId !== o.id && (
                            <Button size="sm" variant="ghost" className="h-6 text-[10px] px-2" onClick={() => { setEditId(o.id); setEditCongId(o.congregation_id); }}>
                              Reassign
                            </Button>
                          )}
                          <Button size="sm" variant="ghost" className="h-6 text-[10px] px-2" onClick={() => toggleActive(o)} disabled={saving}>
                            {o.is_active ? "Deactivate" : "Activate"}
                          </Button>
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
