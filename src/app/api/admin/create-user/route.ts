import { createClient } from "@supabase/supabase-js";
import { NextRequest, NextResponse } from "next/server";

// ── Admin Supabase client (service_role, bypasses RLS) ──────────────────────
const supabaseAdmin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!
);

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { email, password, role, congregation_id, hierarchy_id, scope_level } = body;

    // ── Validate required fields ────────────────────────────────────────────
    if (!email || !password || !role || !hierarchy_id || !scope_level) {
      return NextResponse.json({ error: "Missing required fields: email, password, role, hierarchy_id, scope_level" }, { status: 400 });
    }

    // ── Verify caller is HO using Bearer token ──────────────────────────────
    const authHeader = request.headers.get("authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return NextResponse.json({ error: "Unauthorized. No auth token provided." }, { status: 401 });
    }

    const token = authHeader.replace("Bearer ", "");
    const { data: { user: callerUser }, error: authError } = await supabaseAdmin.auth.getUser(token);

    if (authError || !callerUser) {
      return NextResponse.json({ error: "Unauthorized. Invalid or expired session. Please log in again." }, { status: 401 });
    }

    // Check caller has HO role (admin client bypasses RLS)
    const { data: callerAccess, error: accessQueryErr } = await supabaseAdmin
      .from("user_hierarchy_access")
      .select("role, status, user_id")
      .eq("user_id", callerUser.id)
      .eq("status", "active")
      .limit(1)
      .maybeSingle();

    if (!callerAccess || callerAccess.role !== "HO") {
      // Debug: fetch without status filter to see what's actually in the table
      const { data: allRows } = await supabaseAdmin
        .from("user_hierarchy_access")
        .select("role, status, user_id")
        .eq("user_id", callerUser.id);
      return NextResponse.json({
        error: `Forbidden. Only HO can create users. Your role: ${callerAccess?.role ?? "none (no active access record)"}`,
        debug: { userId: callerUser.id, email: callerUser.email, queryError: accessQueryErr?.message ?? null, allRowsForUser: allRows }
      }, { status: 403 });
    }

    // ── Step 1: Create auth user ────────────────────────────────────────────
    const { data: newUser, error: createError } = await supabaseAdmin.auth.admin.createUser({
      email,
      password,
      email_confirm: true, // Auto-confirm for demo (no email verification needed)
    });

    if (createError) {
      return NextResponse.json({ error: `Auth creation failed: ${createError.message}` }, { status: 400 });
    }

    // ── Step 2: Create user_hierarchy_access ────────────────────────────────
    const { error: accessError } = await supabaseAdmin
      .from("user_hierarchy_access")
      .insert({
        user_id: newUser.user.id,
        role,
        hierarchy_id,
        congregation_id: congregation_id || null,
        scope_level,
        status: "active",
        start_date: new Date().toISOString(),
      });

    if (accessError) {
      // Rollback: delete the auth user if access creation fails
      await supabaseAdmin.auth.admin.deleteUser(newUser.user.id);
      return NextResponse.json({ error: `Access assignment failed: ${accessError.message}` }, { status: 400 });
    }

    // ── Step 3: If HO role, also create ho_district_assignments ──────────────
    if (role === "HO" && hierarchy_id) {
      await supabaseAdmin
        .from("ho_district_assignments")
        .insert({ user_id: newUser.user.id, district_id: hierarchy_id, assigned_by: callerUser.id });
    }

    return NextResponse.json({
      success: true,
      user: { id: newUser.user.id, email: newUser.user.email, role, scope_level },
    });

  } catch (err) {
    return NextResponse.json({ error: `Server error: ${err instanceof Error ? err.message : "Unknown"}` }, { status: 500 });
  }
}
