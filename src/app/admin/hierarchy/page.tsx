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

interface HierarchyNode { id: string; name: string; level_type: string; code: string; parent_id: string | null; }

const LEVEL_ORDER = ["District", "Apostleship", "Overseership"];

export default function HierarchyManagementPage() {
  const supabase = createClient();
  const [access, setAccess] = useState<UserHierarchyAccess | null>(null);
  const [nodes, setNodes] = useState<HierarchyNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Create
  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newCode, setNewCode] = useState("");
  const [newLevelType, setNewLevelType] = useState("Overseership");
  const [newParentId, setNewParentId] = useState("");

  // Edit
  const [editNode, setEditNode] = useState<HierarchyNode | null>(null);
  const [editName, setEditName] = useState("");
  const [editCode, setEditCode] = useState("");

  // Filter
  const [filterLevel, setFilterLevel] = useState("");

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
    const { data } = await supabase.from("hierarchy_levels").select("id, name, level_type, code, parent_id").order("level_type").order("name");
    setNodes(data ?? []);
    setLoading(false);
  }

  // Possible parents based on selected level type
  const possibleParents = useMemo(() => {
    if (newLevelType === "District") return []; // Districts have no parent (or parent is Conference)
    if (newLevelType === "Apostleship") return nodes.filter(n => n.level_type === "District");
    if (newLevelType === "Overseership") return nodes.filter(n => n.level_type === "Apostleship");
    return [];
  }, [nodes, newLevelType]);

  const filteredNodes = useMemo(() => {
    if (filterLevel) return nodes.filter(n => n.level_type === filterLevel);
    return nodes.filter(n => LEVEL_ORDER.includes(n.level_type));
  }, [nodes, filterLevel]);

  function getParentName(parentId: string | null) {
    if (!parentId) return "—";
    const p = nodes.find(n => n.id === parentId);
    return p ? p.name : "—";
  }

  async function handleCreate() {
    setError(null);
    if (!newName.trim() || !newCode.trim()) { setError("Name and code are required"); return; }
    if (newLevelType !== "District" && !newParentId) { setError("Please select a parent"); return; }

    setSaving(true);
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) { setError("Session expired"); setSaving(false); return; }

    // Use service_role via API to bypass RLS
    const res = await fetch("/api/admin/create-hierarchy", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${session.access_token}` },
      body: JSON.stringify({ name: newName.trim(), code: newCode.trim(), level_type: newLevelType, parent_id: newParentId || null }),
    });
    const data = await res.json();
    setSaving(false);
    if (!res.ok) { setError(data.error ?? "Failed"); return; }

    setToast(`${newLevelType} "${newName.trim()}" created`);
    setNewName(""); setNewCode(""); setNewParentId(""); setShowCreate(false);
    await loadData();
  }

  async function handleSaveEdit() {
    if (!editNode) return;
    setSaving(true);
    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) { setSaving(false); return; }

    const res = await fetch("/api/admin/update-hierarchy", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${session.access_token}` },
      body: JSON.stringify({ id: editNode.id, name: editName, code: editCode }),
    });
    setSaving(false);
    if (res.ok) { setToast("Updated"); setEditNode(null); await loadData(); }
  }

  if (loading) return <div className="p-6 text-sm text-muted-foreground">Loading...</div>;
  if (access?.role !== "HO") return <div className="p-6 text-sm text-destructive">Access denied.</div>;

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold">Hierarchy Management</h1>
          <p className="text-xs text-muted-foreground">Create and manage Districts, Apostleships, and Overseerships.</p>
        </div>
        <div className="flex gap-2">
          {!showCreate && <Button size="sm" onClick={() => setShowCreate(true)}>+ New</Button>}
          <Button variant="outline" size="sm" onClick={() => window.history.back()}>← Back</Button>
        </div>
      </div>

      {toast && <div className="rounded border border-green-300 bg-green-50 p-2 text-xs text-green-800">{toast}</div>}
      {error && <div className="rounded border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive">{error}</div>}

      {/* Create */}
      {showCreate && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">New Hierarchy Node</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="space-y-1"><Label className="text-xs">Level *</Label><select className="h-8 w-full rounded border border-input bg-background px-2 text-xs" value={newLevelType} onChange={e => { setNewLevelType(e.target.value); setNewParentId(""); }}>{LEVEL_ORDER.map(l => <option key={l} value={l}>{l}</option>)}</select></div>
              <div className="space-y-1"><Label className="text-xs">Name *</Label><Input className="h-8 text-xs" value={newName} onChange={e => setNewName(e.target.value)} /></div>
              <div className="space-y-1"><Label className="text-xs">Code *</Label><Input className="h-8 text-xs" placeholder="DIST02" value={newCode} onChange={e => setNewCode(e.target.value)} /></div>
              {possibleParents.length > 0 && (
                <div className="space-y-1"><Label className="text-xs">Parent {newLevelType === "Apostleship" ? "(District)" : "(Apostleship)"} *</Label><select className="h-8 w-full rounded border border-input bg-background px-2 text-xs" value={newParentId} onChange={e => setNewParentId(e.target.value)}><option value="">Select...</option>{possibleParents.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>
              )}
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={handleCreate} disabled={saving}>{saving ? "..." : "Create"}</Button>
              <Button size="sm" variant="outline" onClick={() => setShowCreate(false)}>Cancel</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Edit */}
      {editNode && (
        <Card className="border-primary/50">
          <CardHeader className="pb-2"><CardTitle className="text-sm">Edit: {editNode.level_type} — {editNode.name}</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1"><Label className="text-xs">Name</Label><Input className="h-8 text-xs" value={editName} onChange={e => setEditName(e.target.value)} /></div>
              <div className="space-y-1"><Label className="text-xs">Code</Label><Input className="h-8 text-xs" value={editCode} onChange={e => setEditCode(e.target.value)} /></div>
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={handleSaveEdit} disabled={saving}>{saving ? "..." : "Save"}</Button>
              <Button size="sm" variant="outline" onClick={() => setEditNode(null)}>Cancel</Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Filter */}
      <div className="flex gap-2 items-center">
        <Label className="text-xs text-muted-foreground">Filter:</Label>
        {["", ...LEVEL_ORDER].map(l => (
          <Button key={l} size="sm" variant={filterLevel === l ? "default" : "outline"} className="h-7 text-xs" onClick={() => setFilterLevel(l)}>
            {l || "All"}
          </Button>
        ))}
      </div>

      {/* Table */}
      <Card>
        <CardContent className="pt-4">
          <table className="w-full text-xs">
            <thead><tr className="border-b text-left text-muted-foreground">
              <th className="pb-2 pr-3">Level</th><th className="pb-2 pr-3">Name</th><th className="pb-2 pr-3">Code</th><th className="pb-2 pr-3">Parent</th><th className="pb-2">Actions</th>
            </tr></thead>
            <tbody>
              {filteredNodes.map(n => (
                <tr key={n.id} className="border-b hover:bg-muted/30">
                  <td className="py-2 pr-3"><Badge variant="outline" className="text-[9px]">{n.level_type}</Badge></td>
                  <td className="py-2 pr-3 font-medium">{n.name}</td>
                  <td className="py-2 pr-3 font-mono text-muted-foreground">{n.code}</td>
                  <td className="py-2 pr-3 text-muted-foreground">{getParentName(n.parent_id)}</td>
                  <td className="py-2"><Button size="sm" variant="ghost" className="h-6 text-[10px] px-2" onClick={() => { setEditNode(n); setEditName(n.name); setEditCode(n.code); }}>Edit</Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </CardContent>
      </Card>
    </div>
  );
}
