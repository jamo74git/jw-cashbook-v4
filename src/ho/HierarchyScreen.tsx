// HO Hierarchy Management (/ho/hierarchy) — create/edit Districts, Apostleships,
// Overseerships. Reads hierarchy_levels directly; writes via admin-write Edge Function
// (create_hierarchy / update_hierarchy). Ported from f6145ff1 admin/hierarchy.
import { useEffect, useMemo, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { getUserAccess, hasPermission } from "@/lib/permissions";
import { adminApi } from "@/ho/adminApi";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import type { Role, UserHierarchyAccess } from "@/lib/types";

interface HierarchyNode { id: string; name: string; level_type: string; code: string; parent_id: string | null; }
const LEVEL_ORDER = ["District", "Apostleship", "Overseership"];

export function HierarchyScreen() {
  const supabase = createClient();
  const [access, setAccess] = useState<UserHierarchyAccess | null>(null);
  const [nodes, setNodes] = useState<HierarchyNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [showCreate, setShowCreate] = useState(false);
  const [newName, setNewName] = useState("");
  const [newCode, setNewCode] = useState("");
  const [newLevelType, setNewLevelType] = useState("Overseership");
  const [newParentId, setNewParentId] = useState("");

  const [editNode, setEditNode] = useState<HierarchyNode | null>(null);
  const [editName, setEditName] = useState("");
  const [editCode, setEditCode] = useState("");
  const [filterLevel, setFilterLevel] = useState("");

  const role = access?.role as Role | undefined;

  useEffect(() => { if (toast) { const t = setTimeout(() => setToast(null), 4000); return () => clearTimeout(t); } }, [toast]);

  async function loadData() {
    setLoading(true);
    const ua = await getUserAccess();
    setAccess(ua);
    const { data } = await supabase.from("hierarchy_levels").select("id, name, level_type, code, parent_id").order("level_type").order("name");
    setNodes((data ?? []) as HierarchyNode[]);
    setLoading(false);
  }
  useEffect(() => { void loadData(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, []);

  const possibleParents = useMemo(() => {
    if (newLevelType === "Apostleship") return nodes.filter((n) => n.level_type === "District");
    if (newLevelType === "Overseership") return nodes.filter((n) => n.level_type === "Apostleship");
    return [];
  }, [nodes, newLevelType]);

  const filteredNodes = useMemo(() => (filterLevel ? nodes.filter((n) => n.level_type === filterLevel) : nodes.filter((n) => LEVEL_ORDER.includes(n.level_type))), [nodes, filterLevel]);
  const parentName = (pid: string | null) => (pid ? nodes.find((n) => n.id === pid)?.name ?? "—" : "—");

  async function handleCreate() {
    setError(null);
    if (!newName.trim() || !newCode.trim()) { setError("Name and code are required"); return; }
    if (newLevelType !== "District" && !newParentId) { setError("Please select a parent"); return; }
    setSaving(true);
    const r = await adminApi.createHierarchy({ name: newName.trim(), code: newCode.trim(), level_type: newLevelType, parent_id: newParentId || null });
    setSaving(false);
    if (!r.ok) { setError(r.error ?? "Failed"); return; }
    setToast(`${newLevelType} "${newName.trim()}" created`);
    setNewName(""); setNewCode(""); setNewParentId(""); setShowCreate(false);
    await loadData();
  }

  async function handleSaveEdit() {
    if (!editNode) return;
    setSaving(true);
    const r = await adminApi.updateHierarchy({ id: editNode.id, name: editName, code: editCode });
    setSaving(false);
    if (!r.ok) { setError(r.error ?? "Failed"); return; }
    setToast("Updated"); setEditNode(null); await loadData();
  }

  if (loading) return <div className="p-6 text-sm text-muted-foreground">Loading…</div>;
  if (!role || !hasPermission(role, "admin.manage_hierarchy")) return <div className="p-6 text-sm text-destructive">Access denied. HO only.</div>;

  return (
    <div className="max-w-5xl mx-auto px-4 py-6 space-y-4">
      <div className="flex items-center justify-between">
        <div><h1 className="text-lg font-bold">Hierarchy Management</h1><p className="text-xs text-muted-foreground">Create and manage Districts, Apostleships, and Overseerships.</p></div>
        {!showCreate && <Button size="sm" onClick={() => setShowCreate(true)}>+ New</Button>}
      </div>

      {toast && <div className="rounded border border-green-300 bg-green-50 p-2 text-xs text-green-800">{toast}</div>}
      {error && <div className="rounded border border-destructive/50 bg-destructive/10 p-2 text-xs text-destructive">{error}</div>}

      {showCreate && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">New Hierarchy Node</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="space-y-1"><Label className="text-xs">Level *</Label><select className="h-8 w-full rounded border border-input bg-background px-2 text-xs" value={newLevelType} onChange={(e) => { setNewLevelType(e.target.value); setNewParentId(""); }}>{LEVEL_ORDER.map((l) => <option key={l} value={l}>{l}</option>)}</select></div>
              <div className="space-y-1"><Label className="text-xs">Name *</Label><Input className="h-8 text-xs" value={newName} onChange={(e) => setNewName(e.target.value)} /></div>
              <div className="space-y-1"><Label className="text-xs">Code *</Label><Input className="h-8 text-xs" placeholder="DIST02" value={newCode} onChange={(e) => setNewCode(e.target.value)} /></div>
              {possibleParents.length > 0 && (
                <div className="space-y-1"><Label className="text-xs">Parent {newLevelType === "Apostleship" ? "(District)" : "(Apostleship)"} *</Label><select className="h-8 w-full rounded border border-input bg-background px-2 text-xs" value={newParentId} onChange={(e) => setNewParentId(e.target.value)}><option value="">Select…</option>{possibleParents.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></div>
              )}
            </div>
            <div className="flex gap-2"><Button size="sm" onClick={() => void handleCreate()} disabled={saving}>{saving ? "…" : "Create"}</Button><Button size="sm" variant="outline" onClick={() => setShowCreate(false)}>Cancel</Button></div>
          </CardContent>
        </Card>
      )}

      {editNode && (
        <Card className="border-primary/50">
          <CardHeader className="pb-2"><CardTitle className="text-sm">Edit: {editNode.level_type} — {editNode.name}</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1"><Label className="text-xs">Name</Label><Input className="h-8 text-xs" value={editName} onChange={(e) => setEditName(e.target.value)} /></div>
              <div className="space-y-1"><Label className="text-xs">Code</Label><Input className="h-8 text-xs" value={editCode} onChange={(e) => setEditCode(e.target.value)} /></div>
            </div>
            <div className="flex gap-2"><Button size="sm" onClick={() => void handleSaveEdit()} disabled={saving}>{saving ? "…" : "Save"}</Button><Button size="sm" variant="outline" onClick={() => setEditNode(null)}>Cancel</Button></div>
          </CardContent>
        </Card>
      )}

      <div className="flex gap-2 items-center flex-wrap">
        <Label className="text-xs text-muted-foreground">Filter:</Label>
        {["", ...LEVEL_ORDER].map((l) => <Button key={l || "all"} size="sm" variant={filterLevel === l ? "default" : "outline"} className="h-7 text-xs" onClick={() => setFilterLevel(l)}>{l || "All"}</Button>)}
      </div>

      <Card>
        <CardContent className="pt-4 overflow-x-auto">
          <table className="w-full text-xs">
            <thead><tr className="border-b text-left text-muted-foreground"><th className="pb-2 pr-3">Level</th><th className="pb-2 pr-3">Name</th><th className="pb-2 pr-3">Code</th><th className="pb-2 pr-3">Parent</th><th className="pb-2">Actions</th></tr></thead>
            <tbody>
              {filteredNodes.map((n) => (
                <tr key={n.id} className="border-b hover:bg-muted/30">
                  <td className="py-2 pr-3"><Badge variant="outline" className="text-[9px]">{n.level_type}</Badge></td>
                  <td className="py-2 pr-3 font-medium">{n.name}</td>
                  <td className="py-2 pr-3 font-mono text-muted-foreground">{n.code}</td>
                  <td className="py-2 pr-3 text-muted-foreground">{parentName(n.parent_id)}</td>
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
