"use client";

import { useEffect, useState, useMemo } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { getUserAccess } from "@/lib/permissions";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import type { UserHierarchyAccess } from "@/lib/types";

interface HierarchyNode { id: string; name: string; level_type: string; code: string; parent_id: string | null; }
interface Congregation { id: string; name: string; code: string; overseership_id: string | null; }
interface PeriodSummary { id: string; congregation_id: string; year: number; month: number; week: number; service: string; status: string; }

export default function HODashboardPage() {
  const supabase = createClient();
  const router = useRouter();
  const [access, setAccess] = useState<UserHierarchyAccess | null>(null);
  const [hierarchyNodes, setHierarchyNodes] = useState<HierarchyNode[]>([]);
  const [congregations, setCongregations] = useState<Congregation[]>([]);
  const [periods, setPeriods] = useState<PeriodSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedMonth, setSelectedMonth] = useState(() => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`; });

  // Drill state
  const [drillLevel, setDrillLevel] = useState<"district" | "apostleship" | "overseership" | "congregation">("district");
  const [drillId, setDrillId] = useState<string | null>(null);
  const [drillPath, setDrillPath] = useState<{ level: string; id: string; name: string }[]>([]);

  useEffect(() => {
    (async () => {
      const ua = await getUserAccess();
      if (!ua || ua.role !== "HO") { setLoading(false); return; }
      setAccess(ua);

      const [{ data: nodes }, { data: congs }] = await Promise.all([
        supabase.from("hierarchy_levels").select("id, name, level_type, code, parent_id").order("name"),
        supabase.from("congregations").select("id, name, code, overseership_id").order("name"),
      ]);
      setHierarchyNodes(nodes ?? []);
      setCongregations(congs ?? []);
      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Load periods when month changes
  useEffect(() => {
    if (congregations.length === 0) return;
    (async () => {
      const [year, month] = selectedMonth.split("-").map(Number);
      const { data: ps } = await supabase.from("cashbook_period")
        .select("id, congregation_id, year, month, week, service, status")
        .eq("year", year).eq("month", month);
      setPeriods(ps ?? []);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedMonth, congregations]);

  // Get children of a node
  function getChildren(parentId: string | null, levelType: string) {
    if (!parentId) return hierarchyNodes.filter(n => n.level_type === levelType);
    return hierarchyNodes.filter(n => n.parent_id === parentId && n.level_type === levelType);
  }

  // Get all congregation IDs under a hierarchy node
  function getCongIdsUnder(nodeId: string, nodeLevel: string): string[] {
    if (nodeLevel === "Overseership") {
      return congregations.filter(c => c.overseership_id === nodeId).map(c => c.id);
    }
    // For Apostleship: get all overseerships under it, then congregations
    if (nodeLevel === "Apostleship") {
      const ovIds = hierarchyNodes.filter(n => n.parent_id === nodeId && n.level_type === "Overseership").map(n => n.id);
      return congregations.filter(c => c.overseership_id && ovIds.includes(c.overseership_id)).map(c => c.id);
    }
    // For District: get all apostleships, then overseerships, then congregations
    if (nodeLevel === "District") {
      const apoIds = hierarchyNodes.filter(n => n.parent_id === nodeId && n.level_type === "Apostleship").map(n => n.id);
      const ovIds = hierarchyNodes.filter(n => n.parent_id && apoIds.includes(n.parent_id) && n.level_type === "Overseership").map(n => n.id);
      return congregations.filter(c => c.overseership_id && ovIds.includes(c.overseership_id)).map(c => c.id);
    }
    return [];
  }

  // Period stats for a set of congregation IDs
  function getStats(congIds: string[]) {
    const ps = periods.filter(p => congIds.includes(p.congregation_id));
    return {
      total: ps.length,
      draft: ps.filter(p => p.status === "Draft").length,
      submitted: ps.filter(p => p.status === "Submitted").length,
      approved: ps.filter(p => p.status === "AuditApproved").length,
      toOverseer: ps.filter(p => ["SubmittedToOverseer", "SubmittedToHO", "HOReviewed"].includes(p.status)).length,
    };
  }

  // Current view items
  const currentItems = useMemo(() => {
    if (drillLevel === "district") {
      // Show districts
      const districts = hierarchyNodes.filter(n => n.level_type === "District");
      return districts.map(d => {
        const congIds = getCongIdsUnder(d.id, "District");
        return { ...d, congIds, stats: getStats(congIds), childCount: getChildren(d.id, "Apostleship").length };
      });
    }
    if (drillLevel === "apostleship" && drillId) {
      const apos = getChildren(drillId, "Apostleship");
      return apos.map(a => {
        const congIds = getCongIdsUnder(a.id, "Apostleship");
        return { ...a, congIds, stats: getStats(congIds), childCount: getChildren(a.id, "Overseership").length };
      });
    }
    if (drillLevel === "overseership" && drillId) {
      const ovs = getChildren(drillId, "Overseership");
      return ovs.map(o => {
        const congIds = getCongIdsUnder(o.id, "Overseership");
        return { ...o, congIds, stats: getStats(congIds), childCount: congregations.filter(c => c.overseership_id === o.id).length };
      });
    }
    if (drillLevel === "congregation" && drillId) {
      const congs = congregations.filter(c => c.overseership_id === drillId);
      return congs.map(c => {
        const ps = periods.filter(p => p.congregation_id === c.id);
        return { ...c, level_type: "Congregation", parent_id: drillId, congIds: [c.id], stats: getStats([c.id]), childCount: ps.length };
      });
    }
    return [];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drillLevel, drillId, hierarchyNodes, congregations, periods]);

  function drillDown(item: { id: string; name: string; level_type: string }) {
    const newPath = [...drillPath, { level: drillLevel, id: drillId ?? "", name: item.name }];
    setDrillPath(newPath);

    if (drillLevel === "district") { setDrillLevel("apostleship"); setDrillId(item.id); }
    else if (drillLevel === "apostleship") { setDrillLevel("overseership"); setDrillId(item.id); }
    else if (drillLevel === "overseership") { setDrillLevel("congregation"); setDrillId(item.id); }
  }

  function drillUp() {
    if (drillPath.length === 0) return;
    const prev = drillPath[drillPath.length - 1];
    setDrillPath(drillPath.slice(0, -1));

    if (drillLevel === "congregation") { setDrillLevel("overseership"); setDrillId(prev.id); }
    else if (drillLevel === "overseership") { setDrillLevel("apostleship"); setDrillId(prev.id); }
    else if (drillLevel === "apostleship") { setDrillLevel("district"); setDrillId(null); }
  }

  function drillToRoot() {
    setDrillLevel("district"); setDrillId(null); setDrillPath([]);
  }

  if (loading) return <div className="p-6 text-sm text-muted-foreground">Loading...</div>;
  if (access?.role !== "HO") return <div className="p-6 text-sm text-destructive">Access denied.</div>;

  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  const [year, month] = selectedMonth.split("-").map(Number);
  const levelLabels: Record<string, string> = { district: "Districts", apostleship: "Apostleships", overseership: "Overseerships", congregation: "Congregations" };

  return (
    <div className="max-w-6xl mx-auto px-4 py-6 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold">Cashbook Review</h1>
          <p className="text-xs text-muted-foreground">Drill down through the hierarchy to review captures.</p>
        </div>
        <div className="flex items-center gap-2">
          <input type="month" className="h-8 rounded border border-input bg-background px-2 text-xs" value={selectedMonth} onChange={e => setSelectedMonth(e.target.value)} />
          <Button variant="outline" size="sm" onClick={() => router.push("/admin")}>← Admin</Button>
        </div>
      </div>

      {/* Breadcrumb */}
      <div className="flex items-center gap-1 text-xs">
        <button onClick={drillToRoot} className="text-primary hover:underline font-medium">All Districts</button>
        {drillPath.map((p, i) => (
          <span key={i} className="flex items-center gap-1">
            <span className="text-muted-foreground">/</span>
            <button onClick={() => { setDrillPath(drillPath.slice(0, i + 1)); const levels: ("district" | "apostleship" | "overseership" | "congregation")[] = ["apostleship", "overseership", "congregation"]; setDrillLevel(levels[i] ?? "district"); setDrillId(p.id); }} className="text-primary hover:underline">
              {p.name}
            </button>
          </span>
        ))}
        <span className="text-muted-foreground ml-2">— {months[month - 1]} {year}</span>
      </div>

      {/* Summary Stats */}
      <div className="grid grid-cols-4 gap-2">
        {(() => {
          const allCongIds = currentItems.flatMap(i => i.congIds);
          const s = getStats(allCongIds);
          return [
            { label: "Draft", value: s.draft, color: "bg-gray-100 text-gray-700" },
            { label: "Pending Audit", value: s.submitted, color: "bg-orange-100 text-orange-700" },
            { label: "Approved", value: s.approved, color: "bg-green-100 text-green-700" },
            { label: "Submitted Up", value: s.toOverseer, color: "bg-blue-100 text-blue-700" },
          ].map(c => (
            <Card key={c.label} className={c.color}>
              <CardContent className="py-2 px-3 text-center">
                <p className="text-lg font-bold">{c.value}</p>
                <p className="text-[10px]">{c.label}</p>
              </CardContent>
            </Card>
          ));
        })()}
      </div>

      {/* Drill Grid */}
      <Card>
        <CardHeader className="pb-2">
          <div className="flex items-center justify-between">
            <CardTitle className="text-sm">{levelLabels[drillLevel]} ({currentItems.length})</CardTitle>
            {drillLevel !== "district" && <Button size="sm" variant="ghost" className="h-6 text-[10px]" onClick={drillUp}>↑ Up</Button>}
          </div>
        </CardHeader>
        <CardContent>
          {currentItems.length === 0 ? <p className="text-xs text-muted-foreground">No items at this level.</p> : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead><tr className="border-b text-left text-muted-foreground">
                  <th className="pb-2 pr-3">Name</th>
                  <th className="pb-2 pr-3">Code</th>
                  <th className="pb-2 pr-2 text-center">Draft</th>
                  <th className="pb-2 pr-2 text-center">Pending</th>
                  <th className="pb-2 pr-2 text-center">Approved</th>
                  <th className="pb-2 pr-2 text-center">Submitted</th>
                  <th className="pb-2">{drillLevel === "congregation" ? "Services" : "Children"}</th>
                  <th className="pb-2">Action</th>
                </tr></thead>
                <tbody>
                  {currentItems.map((item) => (
                    <tr key={item.id} className="border-b hover:bg-muted/30">
                      <td className="py-2 pr-3 font-medium">{item.name}</td>
                      <td className="py-2 pr-3 font-mono text-muted-foreground">{item.code}</td>
                      <td className="py-2 pr-2 text-center">{item.stats.draft || "—"}</td>
                      <td className="py-2 pr-2 text-center">{item.stats.submitted ? <Badge className="text-[9px] bg-orange-100 text-orange-700 border-orange-300">{item.stats.submitted}</Badge> : "—"}</td>
                      <td className="py-2 pr-2 text-center">{item.stats.approved ? <Badge className="text-[9px] bg-green-100 text-green-700 border-green-300">{item.stats.approved}</Badge> : "—"}</td>
                      <td className="py-2 pr-2 text-center">{item.stats.toOverseer ? <Badge className="text-[9px] bg-blue-100 text-blue-700 border-blue-300">{item.stats.toOverseer}</Badge> : "—"}</td>
                      <td className="py-2 pr-2 text-muted-foreground">{item.childCount}</td>
                      <td className="py-2">
                        {drillLevel === "congregation" ? (
                          <Button size="sm" variant="ghost" className="h-6 text-[10px] px-2" onClick={() => {
                            // Show periods for this congregation
                            const congPeriods = periods.filter(p => p.congregation_id === item.id);
                            if (congPeriods.length > 0) router.push(`/capture/${congPeriods[0].id}`);
                          }}>View</Button>
                        ) : (
                          <Button size="sm" variant="ghost" className="h-6 text-[10px] px-2" onClick={() => drillDown(item)}>Drill ↓</Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Congregation-level: show period list when at congregation level */}
      {drillLevel === "congregation" && currentItems.length > 0 && (
        <Card>
          <CardHeader className="pb-2"><CardTitle className="text-sm">Services This Month</CardTitle></CardHeader>
          <CardContent>
            <div className="space-y-1">
              {periods.filter(p => currentItems.some(ci => ci.id === p.congregation_id)).map(p => {
                const cong = congregations.find(c => c.id === p.congregation_id);
                return (
                  <button key={p.id} onClick={() => router.push(`/capture/${p.id}`)} className="w-full flex items-center justify-between px-3 py-2 rounded border text-xs hover:bg-muted transition-colors text-left">
                    <span><span className="font-medium">{cong?.code}</span> — Wk {p.week} {p.service}</span>
                    <Badge variant="outline" className={`text-[9px] ${p.status === "AuditApproved" ? "bg-green-50 text-green-700 border-green-300" : p.status === "Submitted" ? "bg-orange-50 text-orange-700 border-orange-300" : p.status === "Draft" ? "" : "bg-blue-50 text-blue-700 border-blue-300"}`}>
                      {p.status === "AuditApproved" ? "Approved" : p.status === "Submitted" ? "Pending" : p.status}
                    </Badge>
                  </button>
                );
              })}
              {periods.filter(p => currentItems.some(ci => ci.id === p.congregation_id)).length === 0 && (
                <p className="text-xs text-muted-foreground text-center py-4">No captures this month.</p>
              )}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
