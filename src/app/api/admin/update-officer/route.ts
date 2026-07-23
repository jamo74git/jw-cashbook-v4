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

    // Update officer
    const body = await request.json();
    const { id, ...updates } = body;

    if (!id) {
      return NextResponse.json({ error: "Officer ID required" }, { status: 400 });
    }

    // Only allow specific fields to be updated
    const allowedFields: Record<string, unknown> = {};
    if ("is_active" in updates) allowedFields.is_active = updates.is_active;
    if ("congregation_id" in updates) allowedFields.congregation_id = updates.congregation_id;
    if ("rank" in updates) allowedFields.rank = updates.rank;
    if ("service_status" in updates) allowedFields.service_status = updates.service_status;
    if ("first_name" in updates) allowedFields.first_name = updates.first_name;
    if ("last_name" in updates) allowedFields.last_name = updates.last_name;
    if ("initials" in updates) allowedFields.initials = updates.initials;
    if ("mobile_number" in updates) allowedFields.mobile_number = updates.mobile_number;
    if ("start_date" in updates) allowedFields.start_date = updates.start_date;
    if ("end_date" in updates) allowedFields.end_date = updates.end_date;
    if ("initials" in updates) allowedFields.initials = updates.initials;
    if ("mobile_number" in updates) allowedFields.mobile_number = updates.mobile_number;
    if ("start_date" in updates) allowedFields.start_date = updates.start_date;
    if ("end_date" in updates) allowedFields.end_date = updates.end_date;

    if (Object.keys(allowedFields).length === 0) {
      return NextResponse.json({ error: "No valid fields to update" }, { status: 400 });
    }

    const { error: updateErr } = await supabaseAdmin
      .from("officers")
      .update(allowedFields)
      .eq("id", id);

    if (updateErr) {
      return NextResponse.json({ error: updateErr.message }, { status: 400 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json({ error: `Server error: ${err instanceof Error ? err.message : "Unknown"}` }, { status: 500 });
  }
}
