import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  try {
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!serviceRoleKey) return NextResponse.json({ error: "Server config error" }, { status: 500 });

    const supabaseAdmin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

    const authHeader = request.headers.get("authorization");
    if (!authHeader?.startsWith("Bearer ")) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { data: { user }, error: authErr } = await supabaseAdmin.auth.getUser(authHeader.replace("Bearer ", ""));
    if (authErr || !user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });

    const { data: access } = await supabaseAdmin.from("user_hierarchy_access").select("role").eq("user_id", user.id).eq("status", "active").limit(1).maybeSingle();
    if (!access || access.role !== "HO") return NextResponse.json({ error: "Forbidden" }, { status: 403 });

    const { name, code, level_type, parent_id } = await request.json();
    if (!name || !code || !level_type) return NextResponse.json({ error: "name, code, level_type required" }, { status: 400 });

    const { error: insertErr } = await supabaseAdmin.from("hierarchy_levels").insert({ name, code, level_type, parent_id: parent_id || null });
    if (insertErr) return NextResponse.json({ error: insertErr.message }, { status: 400 });

    return NextResponse.json({ success: true });
  } catch (err) {
    return NextResponse.json({ error: `Server error: ${err instanceof Error ? err.message : "Unknown"}` }, { status: 500 });
  }
}
