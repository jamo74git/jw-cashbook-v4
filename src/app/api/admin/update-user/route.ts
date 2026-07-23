import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
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
      return NextResponse.json({ error: "Forbidden. HO only." }, { status: 403 });
    }

    const body = await request.json();
    const { user_id, ...updates } = body;

    if (!user_id) {
      return NextResponse.json({ error: "user_id required" }, { status: 400 });
    }

    // Build update fields
    const allowedFields: Record<string, unknown> = {};
    if ("role" in updates) allowedFields.role = updates.role;
    if ("congregation_id" in updates) allowedFields.congregation_id = updates.congregation_id;
    if ("scope_level" in updates) allowedFields.scope_level = updates.scope_level;
    if ("status" in updates) allowedFields.status = updates.status;
    if ("hierarchy_id" in updates) allowedFields.hierarchy_id = updates.hierarchy_id;

    if (Object.keys(allowedFields).length === 0) {
      return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
    }

    // Update user_hierarchy_access record
    const { error: updateErr } = await supabaseAdmin
      .from("user_hierarchy_access")
      .update(allowedFields)
      .eq("user_id", user_id)
      .eq("status", "active");

    // If setting inactive, update by matching user_id (any status)
    if (updates.status === "inactive") {
      await supabaseAdmin
        .from("user_hierarchy_access")
        .update({ status: "inactive" })
        .eq("user_id", user_id);
    }

    if (updateErr) {
      return NextResponse.json({ error: updateErr.message }, { status: 400 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json({ error: `Server error: ${err instanceof Error ? err.message : "Unknown"}` }, { status: 500 });
  }
}
