// ─────────────────────────────────────────────────────────────────────────────
// Supabase Edge Function: admin-write (Deno)
// Privileged HO-only writer. Replaces the Next.js /api/admin/* routes and preserves
// the EXACT authorization gate (Req 9, steering "Privileged Route Checklist"):
//   service-role key present (else 500)
//   -> Authorization: Bearer <token> (else 401)
//   -> resolve user via auth.getUser (else 401)
//   -> active user_hierarchy_access with role 'HO' (else 403)
//   -> validate required body fields (else 400)
//   -> perform write with the service-role client (bypasses RLS)
// The service-role key lives ONLY in the Edge Function runtime, never the client.
// ─────────────────────────────────────────────────────────────────────────────

// deno-lint-ignore-file no-explicit-any
import { createClient } from "jsr:@supabase/supabase-js@2";

declare const Deno: { env: { get(k: string): string | undefined }; serve: (h: (r: Request) => Response | Promise<Response>) => void };

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS },
  });
}

// Allow-listed privileged writes and their required fields. Mirrors the original
// create-hierarchy / update-hierarchy routes.
type WriteResult = { table: string; op: "insert" | "update"; values: Record<string, unknown>; matchId?: string } | { error: string };

function buildWrite(action: string, body: any): WriteResult {
  switch (action) {
    case "create_hierarchy": {
      const { name, code, level_type, parent_id } = body;
      if (!name || !code || !level_type) return { error: "name, code, level_type required" };
      return { table: "hierarchy_levels", op: "insert", values: { name, code, level_type, parent_id: parent_id ?? null } };
    }
    case "update_hierarchy": {
      const { id, name, code } = body;
      if (!id) return { error: "id required" };
      const values: Record<string, unknown> = {};
      if (name) values.name = name;
      if (code) values.code = code;
      if (Object.keys(values).length === 0) return { error: "Nothing to update" };
      return { table: "hierarchy_levels", op: "update", values, matchId: id };
    }
    default:
      return { error: `Unknown action: ${action}` };
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  // 1) Service-role key must be configured.
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  if (!serviceRoleKey || !supabaseUrl) {
    return json({ error: "Server config error" }, 500);
  }

  const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  // 2) Bearer token required.
  const authHeader = req.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return json({ error: "Unauthorized" }, 401);
  }

  // 3) Resolve the caller.
  const { data: userData, error: authErr } = await supabaseAdmin.auth.getUser(
    authHeader.replace("Bearer ", "")
  );
  if (authErr || !userData?.user) {
    return json({ error: "Unauthorized" }, 401);
  }

  // 4) Caller must have an active HO access record.
  const { data: access } = await supabaseAdmin
    .from("user_hierarchy_access")
    .select("role")
    .eq("user_id", userData.user.id)
    .eq("status", "active")
    .limit(1)
    .maybeSingle();
  if (!access || (access as any).role !== "HO") {
    return json({ error: "Forbidden" }, 403);
  }

  // 5) Validate the requested write.
  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }
  const write = buildWrite(payload?.action, payload ?? {});
  if ("error" in write) {
    return json({ error: write.error }, 400);
  }

  // 6) Perform the write with the service-role client (bypasses RLS).
  const table = supabaseAdmin.from(write.table);
  const { error: writeErr } =
    write.op === "insert"
      ? await table.insert(write.values)
      : await table.update(write.values).eq("id", write.matchId!);

  if (writeErr) {
    return json({ error: writeErr.message }, 400);
  }
  return json({ success: true });
});
