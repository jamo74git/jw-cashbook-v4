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

    // Create officer
    const body = await request.json();
    const { officer_code, first_name, last_name, rank, congregation_id, service_status } = body;

    if (!officer_code || !first_name || !rank || !congregation_id) {
      return NextResponse.json({ error: "Missing required fields" }, { status: 400 });
    }

    const { data: newOfficer, error: insertErr } = await supabaseAdmin
      .from("officers")
      .insert({
        officer_code,
        first_name,
        last_name: last_name || null,
        rank,
        congregation_id,
        is_active: true,
        service_status: service_status || "serving",
      })
      .select("id, officer_code")
      .single();

    if (insertErr) {
      return NextResponse.json({ error: insertErr.message }, { status: 400 });
    }

    return NextResponse.json({ success: true, officer: newOfficer });
  } catch (err) {
    return NextResponse.json({ error: `Server error: ${err instanceof Error ? err.message : "Unknown"}` }, { status: 500 });
  }
}
