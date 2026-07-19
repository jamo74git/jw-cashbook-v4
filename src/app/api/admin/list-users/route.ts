import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";

export async function GET(request: NextRequest) {
  try {
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!serviceRoleKey) {
      return NextResponse.json({ error: "Server config error" }, { status: 500 });
    }

    const supabaseAdmin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      serviceRoleKey,
      { auth: { autoRefreshToken: false, persistSession: false } }
    );

    // Verify caller is HO
    const authHeader = request.headers.get("authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const token = authHeader.replace("Bearer ", "");
    const { data: { user: callerUser }, error: authError } = await supabaseAdmin.auth.getUser(token);
    if (authError || !callerUser) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }

    const { data: callerAccess } = await supabaseAdmin
      .from("user_hierarchy_access")
      .select("role")
      .eq("user_id", callerUser.id)
      .eq("status", "active")
      .limit(1)
      .maybeSingle();

    if (!callerAccess || callerAccess.role !== "HO") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    // Get all users from auth with their hierarchy access
    const { data: { users }, error: listErr } = await supabaseAdmin.auth.admin.listUsers({ perPage: 500 });
    if (listErr) {
      return NextResponse.json({ error: listErr.message }, { status: 500 });
    }

    // Get all hierarchy access records
    const { data: accessRows } = await supabaseAdmin
      .from("user_hierarchy_access")
      .select("user_id, role, scope_level, congregation_id, hierarchy_id, status")
      .eq("status", "active");

    // Build user list with emails and roles
    const userList = (accessRows ?? []).map(a => {
      const authUser = users.find(u => u.id === a.user_id);
      return {
        user_id: a.user_id,
        email: authUser?.email ?? "unknown",
        role: a.role,
        scope_level: a.scope_level,
        congregation_id: a.congregation_id,
        hierarchy_id: a.hierarchy_id,
      };
    });

    return NextResponse.json({ users: userList });
  } catch (err) {
    return NextResponse.json({ error: `Server error: ${err instanceof Error ? err.message : "Unknown"}` }, { status: 500 });
  }
}
