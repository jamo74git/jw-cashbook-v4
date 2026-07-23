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

interface Congregation {
  id: string;
  name: string;
  code: string;
  eldership_id: string | null;
  overseership_id: string | null;
  property_status: string | null;
  water_meter_number: string | null;
  electricity_meter_number: string | null;
  admin_elder_id: string | null;
  physical_address: string | null;
  contact_number: string | null;
  gps_location: string | null;
}

interface HierarchyNode { id: string; name: string; level_type: string; parent_id: string | null; }
interface Officer { id: string; officer_code: string; first_name: string; last_name: string | null; rank: string; congregation_id: string; }

export default function CongregationsPage() {
  const supabase = createClient();
  const [access, setAccess] = useState<UserHierarchyAccess | null>(null);
  const [congregations, setCongregations] = useState<Congregation[]>([]);
  const [hierarchyNodes, setHierarchyNodes] = useState<HierarchyNode[]>([]);
  const [officers, setOfficers] = useState<Officer[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [filterOverseership, setFilterOverseership] = useState("");
  const [searchTerm, setSearchTerm] = useState("");

  // Create form
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newCode, setNewCode] = useState("");
  const [newOverseership, setNewOverseership] = useState("");
  const [newAddress, setNewAddress] = useState("");
  const [newGps, setNewGps] = useState("");
  const [newContact, setNewContact] = useState("");
  const [newPropertyStatus, setNewPropertyStatus] = useState("unknown");

  // Edit panel
  const [editCong, setEditCong] = useState<Congregation | null>(null);
  const [editForm, setEditForm] = useState({
    property_status: "unknown",
    water_meter_number: "",
    electricity_meter_number: "",
    admin_elder_id: "",
    physical_address: "",
    contact_number: "",
    gps_location: "",
  });

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
    const [{ data: congs }, { data: nodes }, { data: offs }] = await Promise.all([
      supabase.from("congregations").select("*").order("name"),
      supabase.from("hierarchy_levels").select("id, name, level_type, parent_id").order("name"),
      supabase.from("officers").select("id, officer_code, first_name, last_name, rank, congregation_id").eq("is_active", true).order("officer_code"),
    ]);
    setCongregations((congs ?? []).map(c => ({
      id: c.id, name: c.name, code: c.code,
      eldership_id: c.eldership_id ?? null,
      overseership_id: c.overseership_id ?? null,
      property_status: c.property_status ?? null,
      water_meter_number: c.water_meter_number ?? null,
      electricity_meter_number: c.electricity_meter_number ?? null,
      admin_elder_id: c.admin_elder_id ?? null,
      physical_address: c.physical_address ?? null,
      contact_number: c.contact_number ?? null,
      gps_location: c.gps_location ?? null,
    })));
    setHierarchyNodes(nodes ?? []);
    setOfficers(offs ?? []);
    setLoading(false);
  }

  const overseerships = useMemo(() => hierarchyNodes.filter(n => n.level_type === "Overseership"), [hierarchyNodes]);

  const filteredCongs = useMemo(() => {
    let list = congregations;
    if (filterOverseership) list = list.filter(c => c.overseership_id === filterOverseership);
    if (searchTerm.trim()) {
      const term = searchTerm.toLowerCase();
      list = list.filter(c => c.name.toLowerCase().includes(term) || c.code.toLowerCase().includes(term));
    }
    return list;
  }, [congregations, filterOverseership, searchTerm]);

  function getHierarchyName(id: string | null) {
    if (!id) return "—";
    const n = hierarchyNodes.find(x => x.id === id);
    return n ? n.name : "—";
  }

  function getOfficerName(id: string | null) {
    if (!id) return "Not assigned";
    const o = officers.find(x => x.id === id);
    return o ? `${o.officer_code} — ${o.first_name} ${o.last_name ?? ""}`.trim() : "Unknown";
  }

  // Get eligible Elders for admin assignment (only officers with rank Elder in the overseership)
  function getEligibleElders(cong: Congregation) {
    const elders = officers.filter(o => o.rank === "Elder");
    if (!cong.overseership_id) return elders;
    const congIds = congregations.filter(c => c.overseership_id === cong.overseership_id).map(c => c.id);
    return elders.filter(o => congIds.includes(o.congregation_id));
  }

  function openEdit(cong: Congregation) {
    setEditCong(cong);
    setEditForm({
      property_status: cong.property_status ?? "unknown",
      water_meter_number: cong.water_meter_number ?? "",
      electricity_meter_number: cong.electricity_meter_number ?? "",
      admin_elder_id: cong.admin_elder_id ?? "",
      physical_address: cong.physical_address ?? "",
      contact_number: cong.contact_number ?? "",
      gps_location: cong.gps_location ?? "",
    });
  }

  async function handleSave() {
    if (!editCong) return;
    setSaving(true);
    const { data: { user } } = await supabase.auth.getUser();
    await supabase.from("congregations").update({
      property_status: editForm.property_status,
      water_meter_number: editForm.water_meter_number || null,
      electricity_meter_number: editForm.electricity_meter_number || null,
      admin_elder_id: editForm.admin_elder_id || null,
      physical_address: editForm.physical_address || null,
      contact_number: editForm.contact_number || null,
      gps_location: editForm.gps_location || null,
      updated_at: new Date().toISOString(),
      updated_by: user?.id,
    }).eq("id", editCong.id);
    setSaving(false);
    setToast(`${editCong.name} updated`);
    setEditCong(null);
    await loadData();
  }

  async function handleCreate() {
    setError(null);
    if (!newName.trim() || !newCode.trim()) {
      setError("Congregation name and code are required");
      return;
    }
    if (!newOverseership) {
      setError("Please select an overseership");
      return;
    }
    setSaving(true);
    const { error: insertErr } = await supabase.from("congregations").insert({
      name: newName.trim(),
      code: newCode.trim(),
      overseership_id: newOverseership,
      physical_address: newAddress.trim() || null,
      gps_location: newGps.trim() || null,
      contact_number: newContact.trim() || null,
      property_status: newPropertyStatus,
    });
    setSaving(false);
    if (insertErr) { setError(insertErr.message); return; }
    setToast(`Congregation "${newName.trim()}" created`);
    setNewName(""); setNewCode(""); setNewOverseership("");
    setNewAddress(""); setNewGps(""); setNewContact(""); setNewPropertyStatus("unknown");
    setShowCreate(false);
    await loadData();
  }

  if (loading) return <div className="p-6 text-sm text-muted-foreground">Loading...</div>;
  if (access?.role !== "HO") return <div className="p-6 text-sm text-destructive">Access denied. HO only.</div>;

  return (
    <div className="max-w-6xl mx-auto px-4 py-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold">Congregation Management</h1>
          <p className="text-xs text-muted-foreground">Create, edit, and manage congregation details.</p>
        </div>
        <div className="flex gap-2">
          <Button size="sm" onClick={() => setShowCreate(!showCreate)}>{showCreate ? "Cancel" : "+ New Congregation"}</Button>
          <Button variant="outline" size="sm" onClick={() => window.history.back()}>← Back</Button>
        </div>
      </div>

      {toast && <div className="rounded border border-green-300 bg-green-50 p-2 text-xs text-green-800">{toast}</div>}
      {error && <div className="rounded border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive">{error}</div>}

      {/* Create Congregation Form */}
      {showCreate && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">New Congregation</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">Congregation Name *</Label>
                <Input className="h-8 text-xs" placeholder="e.g. Bosmont" value={newName} onChange={e => setNewName(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Code *</Label>
                <Input className="h-8 text-xs" placeholder="e.g. 020700" value={newCode} onChange={e => setNewCode(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Overseership *</Label>
                <select className="h-8 w-full rounded border border-input bg-background px-2 text-xs" value={newOverseership} onChange={e => setNewOverseership(e.target.value)}>
                  <option value="">Select overseership...</option>
                  {overseerships.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
                </select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Property Status</Label>
                <select className="h-8 w-full rounded border border-input bg-background px-2 text-xs" value={newPropertyStatus} onChange={e => setNewPropertyStatus(e.target.value)}>
                  <option value="unknown">Unknown</option>
                  <option value="owned">Owned</option>
                  <option value="leased">Leased / Rented</option>
                </select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Contact Number</Label>
                <Input className="h-8 text-xs" placeholder="011..." value={newContact} onChange={e => setNewContact(e.target.value)} />
              </div>
              <div className="space-y-1 sm:col-span-2">
                <Label className="text-xs">Physical Address</Label>
                <Input className="h-8 text-xs" placeholder="Street, suburb, city" value={newAddress} onChange={e => setNewAddress(e.target.value)} />
              </div>
              <div className="space-y-1 sm:col-span-2">
                <Label className="text-xs">GPS Location <span className="text-muted-foreground font-normal">(e.g. -26.1753, 28.0145)</span></Label>
                <Input className="h-8 text-xs" placeholder="-26.xxxx, 28.xxxx" value={newGps} onChange={e => setNewGps(e.target.value)} />
              </div>
            </div>
            <Button size="sm" onClick={handleCreate} disabled={saving}>{saving ? "Creating..." : "Create Congregation"}</Button>
          </CardContent>
        </Card>
      )}

      {/* Filters */}
      <Card>
        <CardContent className="py-3">
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            <div className="space-y-0.5">
              <Label className="text-[10px] text-muted-foreground">Overseership</Label>
              <select className="h-8 w-full rounded border border-input bg-background px-2 text-xs" value={filterOverseership} onChange={e => setFilterOverseership(e.target.value)}>
                <option value="">All</option>
                {overseerships.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
              </select>
            </div>
            <div className="space-y-0.5">
              <Label className="text-[10px] text-muted-foreground">Search</Label>
              <Input className="h-8 text-xs" placeholder="Name or code..." value={searchTerm} onChange={e => setSearchTerm(e.target.value)} />
            </div>
            <div className="flex items-end">
              <p className="text-xs text-muted-foreground">{filteredCongs.length} congregation{filteredCongs.length !== 1 ? "s" : ""}</p>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Edit Panel */}
      {editCong && (
        <Card className="border-primary/50">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Edit: {editCong.code} — {editCong.name}</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">Property Status</Label>
                <select className="h-8 w-full rounded border border-input bg-background px-2 text-xs" value={editForm.property_status} onChange={e => setEditForm(f => ({ ...f, property_status: e.target.value }))}>
                  <option value="unknown">Unknown</option>
                  <option value="owned">Owned</option>
                  <option value="leased">Leased / Rented</option>
                </select>
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Administrative Elder</Label>
                <select className="h-8 w-full rounded border border-input bg-background px-2 text-xs" value={editForm.admin_elder_id} onChange={e => setEditForm(f => ({ ...f, admin_elder_id: e.target.value }))}>
                  <option value="">Not assigned</option>
                  {getEligibleElders(editCong).map(o => <option key={o.id} value={o.id}>{o.officer_code} — {o.first_name} {o.last_name ?? ""}</option>)}
                </select>
              </div>
              {editForm.property_status === "owned" && (
                <>
                  <div className="space-y-1">
                    <Label className="text-xs">Water Meter Number</Label>
                    <Input className="h-8 text-xs" value={editForm.water_meter_number} onChange={e => setEditForm(f => ({ ...f, water_meter_number: e.target.value }))} />
                  </div>
                  <div className="space-y-1">
                    <Label className="text-xs">Electricity Meter Number</Label>
                    <Input className="h-8 text-xs" value={editForm.electricity_meter_number} onChange={e => setEditForm(f => ({ ...f, electricity_meter_number: e.target.value }))} />
                  </div>
                </>
              )}
              <div className="space-y-1">
                <Label className="text-xs">Physical Address</Label>
                <Input className="h-8 text-xs" value={editForm.physical_address} onChange={e => setEditForm(f => ({ ...f, physical_address: e.target.value }))} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Contact Number</Label>
                <Input className="h-8 text-xs" value={editForm.contact_number} onChange={e => setEditForm(f => ({ ...f, contact_number: e.target.value }))} />
              </div>
              <div className="space-y-1 sm:col-span-2">
                <Label className="text-xs">GPS Location <span className="text-muted-foreground font-normal">(e.g. -26.1753, 28.0145)</span></Label>
                <div className="flex gap-2">
                  <Input className="h-8 text-xs flex-1" placeholder="-26.xxxx, 28.xxxx" value={editForm.gps_location} onChange={e => setEditForm(f => ({ ...f, gps_location: e.target.value }))} />
                  {editForm.gps_location && (
                    <a href={`https://www.google.com/maps?q=${editForm.gps_location}`} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 px-2 h-8 rounded border border-input text-xs text-blue-600 hover:bg-blue-50">
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z" /><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 11a3 3 0 11-6 0 3 3 0 016 0z" /></svg>
                      Map
                    </a>
                  )}
                </div>
              </div>
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={handleSave} disabled={saving}>{saving ? "Saving..." : "Save Changes"}</Button>
              <Button size="sm" variant="outline" onClick={() => setEditCong(null)}>Cancel</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Congregations Table */}
      <Card>
        <CardContent className="pt-4">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b text-left text-muted-foreground">
                  <th className="pb-2 pr-3">Code</th>
                  <th className="pb-2 pr-3">Name</th>
                  <th className="pb-2 pr-3">Overseership</th>
                  <th className="pb-2 pr-3">Property</th>
                  <th className="pb-2 pr-3">Admin Elder</th>
                  <th className="pb-2">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filteredCongs.map(c => (
                  <tr key={c.id} className="border-b last:border-0 hover:bg-muted/30">
                    <td className="py-2 pr-3 font-mono font-medium">{c.code}</td>
                    <td className="py-2 pr-3">{c.name}</td>
                    <td className="py-2 pr-3 text-muted-foreground">{getHierarchyName(c.overseership_id)}</td>
                    <td className="py-2 pr-3">
                      <Badge variant={c.property_status === "owned" ? "default" : c.property_status === "leased" ? "secondary" : "outline"} className="text-[9px]">
                        {c.property_status ?? "unknown"}
                      </Badge>
                    </td>
                    <td className="py-2 pr-3 text-muted-foreground">{getOfficerName(c.admin_elder_id)}</td>
                    <td className="py-2">
                      <Button size="sm" variant="ghost" className="h-6 text-[10px] px-2" onClick={() => openEdit(c)}>Edit</Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
