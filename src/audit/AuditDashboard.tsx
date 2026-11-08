// ─────────────────────────────────────────────────────────────────────────────
// AUDITOR DASHBOARD (online-only). Reads live from Supabase under RLS: the pending
// audit queue (status="Submitted") and recent history (AuditApproved/Rejected).
// No Dexie / offline path. In-page permission gate on audit.view_queue.
// ─────────────────────────────────────────────────────────────────────────────

import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { createClient } from "@/lib/supabase/client";
import { getUserAccess, hasPermission } from "@/lib/permissions";
import { useOnlineStatus } from "@/lib/useOnlineStatus";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import type { Role, UserHierarchyAccess } from "@/lib/types";

const OFFLINE_MSG = "Offline Unavailable — Please connect to a stable network to audit submissions.";

interface Period {
  id: string;
  congregation_id: string;
  year: number;
  month: number;
  week: number;
  service: string;
  status: string;
  week_key: string | null;
  submitted_at: string | null;
}

interface Congregation {
  id: string;
  name: string;
  code: string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const periodLabel = (p: Period) => `${MONTHS[p.month - 1]} ${p.year} — Week ${p.week} (${p.service})`;

export function AuditDashboard() {
  const supabase = createClient();
  const navigate = useNavigate();
  const online = useOnlineStatus();
  const [access, setAccess] = useState<UserHierarchyAccess | null>(null);
  const [email, setEmail] = useState("");
  const [congregation, setCongregation] = useState<Congregation | null>(null);
  const [pending, setPending] = useState<Period[]>([]);
  const [history, setHistory] = useState<Period[]>([]);
  const [loading, setLoading] = useState(true);
  // PRIORITY 2: accepted sign-off count per pending period (0 = awaiting first, 1 = needs an
  // independent second). Resilient — empty if the sign-off ledger is not yet provisioned.
  const [signoffCounts, setSignoffCounts] = useState<Record<string, number>>({});

  const role = access?.role as Role | undefined;

  useEffect(() => {
    (async () => {
      const ua = await getUserAccess();
      if (!ua) {
        setLoading(false);
        return;
      }
      setAccess(ua);
      const {
        data: { user },
      } = await supabase.auth.getUser();
      setEmail(user?.email ?? "");

      if (ua.congregation_id) {
        const { data: cong } = await supabase
          .from("congregations")
          .select("id, name, code")
          .eq("id", ua.congregation_id)
          .single();
        if (cong) setCongregation(cong as Congregation);

        const selectCols = "id, congregation_id, year, month, week, service, status, week_key, submitted_at";
        const { data: pend } = await supabase
          .from("cashbook_period")
          .select(selectCols)
          .eq("congregation_id", ua.congregation_id)
          .eq("status", "Submitted")
          .order("year", { ascending: false })
          .order("month", { ascending: false })
          .order("week", { ascending: false });
        const pendList = (pend ?? []) as Period[];
        setPending(pendList);

        // Sign-off counts for the pending queue (best-effort; table is schema-gated).
        const pendIds = pendList.map((p) => p.id);
        if (pendIds.length > 0) {
          const { data: soRows, error: soErr } = await supabase
            .from("cashbook_review_decision")
            .select("period_id")
            .in("period_id", pendIds)
            .eq("decision", "signoff")
            .eq("outcome", "accepted");
          if (!soErr && soRows) {
            const counts: Record<string, number> = {};
            for (const r of soRows as { period_id: string }[]) {
              counts[r.period_id] = (counts[r.period_id] ?? 0) + 1;
            }
            setSignoffCounts(counts);
          }
        }

        const { data: hist } = await supabase
          .from("cashbook_period")
          .select(selectCols)
          .eq("congregation_id", ua.congregation_id)
          .in("status", ["AuditApproved", "Rejected"])
          .order("year", { ascending: false })
          .order("month", { ascending: false })
          .limit(10);
        setHistory((hist ?? []) as Period[]);
      }
      setLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!online) return <p className="p-6 text-sm text-amber-700">{OFFLINE_MSG}</p>;
  if (loading) return <p className="p-6 text-sm text-muted-foreground">Loading…</p>;
  if (!role || !hasPermission(role, "audit.view_queue")) {
    return <p className="p-6 text-sm text-destructive">Access denied. Auditor role required.</p>;
  }

  // PRIORITY 2 buckets: awaiting the FIRST sign-off vs needing an independent SECOND.
  const awaitingFirst = pending.filter((p) => (signoffCounts[p.id] ?? 0) === 0).length;
  const needsSecond = pending.filter((p) => (signoffCounts[p.id] ?? 0) === 1).length;

  return (
    <main className="mx-auto max-w-4xl p-6 space-y-6">
      <div className="space-y-1">
        <h1 className="text-2xl font-bold tracking-tight">Auditor Dashboard</h1>
        <p className="text-sm text-muted-foreground">
          Role: <span className="font-medium">{role}</span> · {email}
        </p>
        {congregation && (
          <p className="text-sm text-muted-foreground">
            Congregation: <span className="font-medium">{congregation.name}</span> ({congregation.code})
          </p>
        )}
      </div>

      <Card className={pending.length > 0 ? "border-orange-300 bg-orange-50/30" : ""}>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">Pending Audit Queue</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-3xl font-bold">{pending.length}</p>
          <p className="text-sm text-muted-foreground">
            {pending.length === 0 ? "No services waiting for review." : "service(s) waiting for your review."}
          </p>
          {pending.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-2 text-[11px]">
              <span className="rounded bg-orange-100 px-2 py-0.5 text-orange-800">{awaitingFirst} awaiting first sign-off</span>
              <span className="rounded bg-amber-100 px-2 py-0.5 text-amber-800">{needsSecond} needs independent second</span>
            </div>
          )}
        </CardContent>
      </Card>

      {pending.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Services Awaiting Review</CardTitle>
          </CardHeader>
          <CardContent className="space-y-1">
            {pending.map((p) => (
              <button
                key={p.id}
                onClick={() => navigate(`/audit/${p.id}`)}
                className="w-full flex items-center justify-between px-3 py-2 rounded border text-xs hover:bg-muted transition-colors text-left"
              >
                <div>
                  <span className="font-medium">{periodLabel(p)}</span>
                  {p.submitted_at && (
                    <span className="text-muted-foreground ml-2">
                      submitted {new Date(p.submitted_at).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}
                    </span>
                  )}
                </div>
                {(signoffCounts[p.id] ?? 0) === 1 ? (
                  <Badge variant="outline" className="text-[9px] bg-amber-50 text-amber-700 border-amber-300">
                    1/2 — needs 2nd
                  </Badge>
                ) : (
                  <Badge variant="outline" className="text-[9px] bg-orange-50 text-orange-700 border-orange-300">
                    0/2 Pending
                  </Badge>
                )}
              </button>
            ))}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">Recent Audit History</CardTitle>
        </CardHeader>
        <CardContent>
          {history.length === 0 ? (
            <p className="text-xs text-muted-foreground">No audit history yet.</p>
          ) : (
            <div className="space-y-1">
              {history.map((p) => (
                <button
                  key={p.id}
                  onClick={() => navigate(`/audit/${p.id}`)}
                  className="w-full flex items-center justify-between px-3 py-2 rounded border text-xs hover:bg-muted transition-colors text-left"
                >
                  <span className="font-medium">{periodLabel(p)}</span>
                  <Badge
                    variant="outline"
                    className={`text-[9px] ${
                      p.status === "AuditApproved"
                        ? "bg-green-50 text-green-700 border-green-300"
                        : "bg-red-50 text-red-700 border-red-300"
                    }`}
                  >
                    {p.status === "AuditApproved" ? "Approved" : "Rejected"}
                  </Badge>
                </button>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
