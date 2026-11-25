// Live (online, RLS-governed) Officer Faithfulness list for the Elder, who has no local
// capture data. Same rule as dashboardRepo.listOfficersWithoutRecentTithe: active
// Priests/Underdeacons with no line item in the congregation's 4 most recent periods.
// Read-only.

import { createClient } from "@/lib/supabase/client";
import type { FaithfulnessOfficer } from "@/db/dashboardRepo";

export async function listOfficersWithoutRecentTitheLive(congregationId: string): Promise<FaithfulnessOfficer[]> {
  const supabase = createClient();

  const { data: periods, error: pErr } = await supabase
    .from("cashbook_period")
    .select("id")
    .eq("congregation_id", congregationId)
    .order("year", { ascending: false })
    .order("month", { ascending: false })
    .order("week", { ascending: false })
    .limit(4);
  if (pErr) throw new Error(pErr.message);

  const referenced = new Set<string>();
  const periodIds = (periods ?? []).map((p) => p.id as string);
  if (periodIds.length > 0) {
    const { data: lines, error: lErr } = await supabase
      .from("cashbook_line_item")
      .select("officer_id")
      .in("period_id", periodIds)
      .not("officer_id", "is", null);
    if (lErr) throw new Error(lErr.message);
    for (const l of lines ?? []) referenced.add(l.officer_id as string);
  }

  const { data: officers, error: oErr } = await supabase
    .from("officers")
    .select("id, officer_code, first_name, last_name, rank, is_interim")
    .eq("congregation_id", congregationId)
    .eq("is_active", true)
    .in("rank", ["Priest", "Underdeacon"]);
  if (oErr) throw new Error(oErr.message);

  return (officers ?? [])
    .filter((o) => !referenced.has(o.id as string))
    .map((o) => ({
      id: o.id as string,
      officer_code: o.officer_code as string,
      first_name: o.first_name as string,
      last_name: (o.last_name as string | null) ?? null,
      rank: o.rank as string,
      is_interim: o.is_interim === true,
    }))
    .sort((a, b) => a.officer_code.localeCompare(b.officer_code));
}
