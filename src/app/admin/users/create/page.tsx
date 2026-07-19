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

interface Congregation { id: string; name: string; code: string; eldership_id: string | null; overseership_id: string | null; }
interface HierarchyNode { id: string; name: string; level_type: string; code: string; parent_id: string | null; }

const ROLES = ["Treasurer", "Auditor", "Chairperson", "Elder", "Overseer", "Apostle", "HO", "Secretary"] as const;

const ROLE_SCOPE: Record<string, string> = {
  Treasurer: "Congregation", Auditor: "Congregation", Chairperson: "Congregation", Secretary: "Congregation",
  Elder: "Eldership", Overseer: "Overseership", Apostle: "Apostleship", HO: "District",
};

export default function CreateUserPage() {
  const supabase = createClient();
  const [access, setAccess] = useState<UserHierarchyAccess | null>(null);
  const [congregations, setCongregations] = useState<Congregation[]>([]);
  const [hierarchyNodes, setHierarchyNodes] = useState<HierarchyNode[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [success, setSuccess] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Form
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<string>("Treasurer");
  const [congregationId, setCongregationId] = useState("");
  const [hierarchyId, setHierarchyId] = useState("");

  // Cascading filters
  const [filterDistrict, setFilterDistrict] = useState("");
  const [filterApostleship, setFilterApostleship] = useState("");
  const [filterOverseership, setFilterOverseership] = useState("");
  const [searchTerm, setSearchTerm] = useState("");

  const scopeLevel = ROLE_SCOPE[role] ?? "Congregation";
  const needsCongregation = ["Treasurer", "Auditor", "Chairperson", "Secretary"].includes(role);

  useEffect(() => {
    (async () => {
      const ua = await getUserAccess();
      if (!ua) { setLoading(false); return; }
      setAccess(ua);

      const { data: congs } = await supabase.from("congregations").select("id, name, code, eldership_id, overseership_id").order("name");
      setCongregations(congs ?? []);

      const { data: nodes } = await supabase.from("hierarchy_levels").select("id, name, level_type, code, parent_id").order("name");
      setHierarchyNodes(nodes ?? []);

      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Derive filter options from hierarchy
  const districts = useMemo(() => hierarchyNodes.filter(n => n.level_type === "District"), [hierarchyNodes]);
  const apostleships = useMemo(() => {
    let nodes = hierarchyNodes.filter(n => n.level_type === "Apostleship");
    if (filterDistrict) nodes = nodes.filter(n => n.parent_id === filterDistrict);
    return nodes;
  }, [hierarchyNodes, filterDistrict]);
  const overseerships = useMemo(() => {
    let nodes = hierarchyNodes.filter(n => n.level_type === "Overseership");
    if (filterApostleship) nodes = nodes.filter(n => n.parent_id === filterApostleship);
    else if (filterDistrict) {
      const apoIds = apostleships.map(a => a.id);
      nodes = nodes.filter(n => n.parent_id && apoIds.includes(n.parent_id));
    }
    return nodes;
  }, [hierarchyNodes, filterApostleship, filterDistrict, apostleships]);

  // Filter congregations based on cascading selection + search
  const filteredCongregations = useMemo(() => {
    let list = congregations;
    if (filterOverseership) {
      list = list.filter(c => c.overseership_id === filterOverseership);
    } else if (filterApostleship) {
      const ovIds = overseerships.map(o => o.id);
      list = list.filter(c => c.overseership_id && ovIds.includes(c.overseership_id));
    } else if (filterDistrict) {
      const ovIds = overseerships.map(o => o.id);
      list = list.filter(c => c.overseership_id && ovIds.includes(c.overseership_id));
    }
    if (searchTerm.trim()) {
      const term = searchTerm.toLowerCase();
      list = list.filter(c => c.name.toLowerCase().includes(term) || c.code.toLowerCase().includes(term));
    }
    return list;
  }, [congregations, filterOverseership, filterApostleship, filterDistrict, overseerships, searchTerm]);

  // Auto-set hierarchy_id when congregation changes
  useEffect(() => {
    if (needsCongregation && congregationId) {
      const cong = congregations.find(c => c.id === congregationId);
      if (cong) {
        const node = hierarchyNodes.find(n => n.level_type === "Congregation" && n.code === cong.code);
        if (node) setHierarchyId(node.id);
        else if (cong.eldership_id) setHierarchyId(cong.eldership_id);
      }
    }
  }, [congregationId, needsCongregation, congregations, hierarchyNodes]);

  // Reset cascading when role changes
  function resetFilters() {
    setFilterDistrict(""); setFilterApostleship(""); setFilterOverseership("");
    setSearchTerm(""); setCongregationId(""); setHierarchyId("");
  }

  async function handleCreate() {
    setError(null);
    setSuccess(null);

    if (!email || !password) { setError("Email and password are required"); return; }
    if (needsCongregation && !congregationId) { setError("Please select a congregation for this role"); return; }
    if (!needsCongregation && !hierarchyId) { setError("Please select a hierarchy node for this role"); return; }

    setCreating(true);

    const { data: { session } } = await supabase.auth.getSession();
    if (!session?.access_token) {
      setError("Session expired. Please log in again.");
      setCreating(false);
      return;
    }

    const res = await fetch("/api/admin/create-user", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({
        email,
        password,
        role,
        congregation_id: needsCongregation ? congregationId : null,
        hierarchy_id: hierarchyId,
        scope_level: scopeLevel,
      }),
    });

    const data = await res.json();
    setCreating(false);

    if (!res.ok) {
      setError(data.error ?? "Failed to create user");
      return;
    }

    setSuccess(`User created: ${data.user.email} as ${data.user.role} (${data.user.scope_level})`);
    setEmail("");
    setPassword("");
    setCongregationId("");
  }

  if (loading) return <div className="p-6 text-sm text-muted-foreground">Loading...</div>;
  if (access?.role !== "HO") return <div className="p-6 text-sm text-destructive">Access denied. HO only.</div>;

  const filteredNodes = hierarchyNodes.filter(n => n.level_type === scopeLevel);

  return (
    <>
      <div className="max-w-lg mx-auto px-4 py-6 space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-lg font-bold">Create User</h1>
          <Button variant="outline" size="sm" onClick={() => window.history.back()}>← Back</Button>
        </div>

        {success && <div className="rounded border border-green-300 bg-green-50 p-3 text-xs text-green-800">{success}</div>}
        {error && <div className="rounded border border-destructive/50 bg-destructive/10 p-3 text-xs text-destructive">{error}</div>}

        <Card>
          <CardHeader className="pb-3"><CardTitle className="text-sm">New User Details</CardTitle></CardHeader>
          <CardContent className="space-y-4">
            {/* Email */}
            <div className="space-y-1">
              <Label className="text-xs">Email Address *</Label>
              <Input className="h-9 text-xs" type="email" placeholder="user@example.com" value={email} onChange={e => setEmail(e.target.value)} />
            </div>

            {/* Password */}
            <div className="space-y-1">
              <Label className="text-xs">Temporary Password *</Label>
              <Input className="h-9 text-xs" type="text" placeholder="Min 6 characters" value={password} onChange={e => setPassword(e.target.value)} />
              <p className="text-[10px] text-muted-foreground">User will use this for first login. OTP-based login planned for go-live.</p>
            </div>

            {/* Role */}
            <div className="space-y-1">
              <Label className="text-xs">Role *</Label>
              <select className="h-9 w-full rounded border border-input bg-background px-2 text-xs" value={role} onChange={e => { setRole(e.target.value); resetFilters(); }}>
                {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
              </select>
              <Badge variant="outline" className="text-[9px] mt-1">Scope: {scopeLevel}</Badge>
            </div>

            {/* Congregation Selection with Cascading Filters */}
            {needsCongregation && (
              <div className="space-y-3 rounded border border-dashed border-muted-foreground/30 p-3">
                <p className="text-[10px] font-medium text-muted-foreground uppercase tracking-wider">Find Congregation</p>

                {/* Cascading Filters */}
                <div className="grid grid-cols-1 gap-2">
                  {/* District filter */}
                  {districts.length > 1 && (
                    <div className="space-y-0.5">
                      <Label className="text-[10px] text-muted-foreground">District</Label>
                      <select className="h-8 w-full rounded border border-input bg-background px-2 text-xs" value={filterDistrict} onChange={e => { setFilterDistrict(e.target.value); setFilterApostleship(""); setFilterOverseership(""); setCongregationId(""); }}>
                        <option value="">All districts</option>
                        {districts.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
                      </select>
                    </div>
                  )}

                  {/* Apostleship filter */}
                  {apostleships.length > 0 && (
                    <div className="space-y-0.5">
                      <Label className="text-[10px] text-muted-foreground">Apostleship</Label>
                      <select className="h-8 w-full rounded border border-input bg-background px-2 text-xs" value={filterApostleship} onChange={e => { setFilterApostleship(e.target.value); setFilterOverseership(""); setCongregationId(""); }}>
                        <option value="">All apostleships</option>
                        {apostleships.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                      </select>
                    </div>
                  )}

                  {/* Overseership filter */}
                  {overseerships.length > 0 && (
                    <div className="space-y-0.5">
                      <Label className="text-[10px] text-muted-foreground">Overseership</Label>
                      <select className="h-8 w-full rounded border border-input bg-background px-2 text-xs" value={filterOverseership} onChange={e => { setFilterOverseership(e.target.value); setCongregationId(""); }}>
                        <option value="">All overseerships</option>
                        {overseerships.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
                      </select>
                    </div>
                  )}

                  {/* Search */}
                  <div className="space-y-0.5">
                    <Label className="text-[10px] text-muted-foreground">Search by name or code</Label>
                    <Input className="h-8 text-xs" placeholder="Type to search..." value={searchTerm} onChange={e => setSearchTerm(e.target.value)} />
                  </div>
                </div>

                {/* Congregation dropdown (filtered) */}
                <div className="space-y-0.5">
                  <Label className="text-xs font-medium">Congregation * <span className="text-muted-foreground font-normal">({filteredCongregations.length} available)</span></Label>
                  <select className="h-9 w-full rounded border border-input bg-background px-2 text-xs" value={congregationId} onChange={e => setCongregationId(e.target.value)}>
                    <option value="">Select congregation...</option>
                    {filteredCongregations.map(c => <option key={c.id} value={c.id}>{c.code} — {c.name}</option>)}
                  </select>
                </div>
              </div>
            )}

            {/* Hierarchy Node (for higher-scoped roles) */}
            {!needsCongregation && (
              <div className="space-y-1">
                <Label className="text-xs">{scopeLevel} *</Label>
                <select className="h-9 w-full rounded border border-input bg-background px-2 text-xs" value={hierarchyId} onChange={e => setHierarchyId(e.target.value)}>
                  <option value="">Select {scopeLevel.toLowerCase()}...</option>
                  {filteredNodes.map(n => <option key={n.id} value={n.id}>{n.code} — {n.name}</option>)}
                </select>
              </div>
            )}

            {/* Create Button */}
            <Button className="w-full" onClick={handleCreate} disabled={creating}>
              {creating ? "Creating..." : "Create User & Assign Access"}
            </Button>
          </CardContent>
        </Card>

        {/* Quick Info */}
        <Card>
          <CardContent className="py-3 text-[10px] text-muted-foreground space-y-1">
            <p><b>What happens:</b></p>
            <p>1. Auth account created with email + temp password</p>
            <p>2. Role + hierarchy access assigned immediately</p>
            <p>3. User can log in right away at the correct dashboard</p>
            <p className="pt-1 text-orange-600">For go-live: passwords will be replaced with OTP (email/SMS).</p>
          </CardContent>
        </Card>
      </div>
    </>
  );
}
