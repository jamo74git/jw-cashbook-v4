import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

// ─── Route Protection Map ───────────────────────────────────────────────────
// Maps route prefixes to the roles allowed to access them.
// Empty array = any authenticated user with active access.
// This is a first-pass gate; fine-grained permissions are checked in-page via permissions.ts.

const ROUTE_ROLE_MAP: Record<string, string[]> = {
  "/dashboard": [],                                          // All roles
  "/elder": ["Elder"],                                         // Elder dashboard
  "/capture": ["Treasurer", "Chairperson", "Elder"],         // Capture flow
  "/audit": ["Auditor", "Chairperson", "Elder", "HO"],      // Audit queue
  "/review": ["Overseer", "Apostle", "HO"],                  // Overseer/HO review
  "/monthly-close": ["Elder", "Overseer", "HO"],             // Monthly close
  "/census": ["Treasurer", "Elder", "Chairperson", "HO", "Apostle", "Overseer", "Secretary"],
  "/admin": ["HO"],                                          // HO admin only
  "/settings": ["Elder", "Chairperson", "HO"],               // Congregation settings
  "/reports": [],                                            // All roles (export gated in-page)
  "/messages": [],                                           // All except Secretary (gated in-page)
  "/treasurer": ["Treasurer"],                               // Treasurer dashboard
  "/chairperson": ["Chairperson"],                           // Chairperson dashboard
  "/oac": ["Treasurer", "Chairperson", "Elder"],             // Legacy cashbook
};

const PROTECTED_PREFIXES = Object.keys(ROUTE_ROLE_MAP);

export async function middleware(request: NextRequest) {
  let response = NextResponse.next({
    request: { headers: request.headers },
  });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        get(name: string) {
          return request.cookies.get(name)?.value;
        },
        set(name: string, value: string, options: CookieOptions) {
          request.cookies.set({ name, value, ...options });
          response = NextResponse.next({
            request: { headers: request.headers },
          });
          response.cookies.set({ name, value, ...options });
        },
        remove(name: string, options: CookieOptions) {
          request.cookies.set({ name, value: "", ...options });
          response = NextResponse.next({
            request: { headers: request.headers },
          });
          response.cookies.set({ name, value: "", ...options });
        },
      },
    }
  );

  // Refresh session — required for Server Components
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname } = request.nextUrl;

  // ── Check if route is protected ──────────────────────────────────────────
  const matchedPrefix = PROTECTED_PREFIXES.find((p) => pathname.startsWith(p));
  const isProtected = !!matchedPrefix;

  // ── Redirect unauthenticated users to login ──────────────────────────────
  if (isProtected && !user) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  // ── For authenticated users on protected routes: check user_hierarchy_access ──
  if (isProtected && user) {
    const { data: access } = await supabase
      .from("user_hierarchy_access")
      .select("role, status, start_date, end_date")
      .eq("user_id", user.id)
      .eq("status", "active")
      .order("created_at", { ascending: true })
      .limit(1)
      .single();

    // No active access record → block
    if (!access) {
      const loginUrl = new URL("/login", request.url);
      loginUrl.searchParams.set("error", "Access is restricted to registered congregation members.");
      return NextResponse.redirect(loginUrl);
    }

    // Check date range
    const now = new Date().toISOString();
    if ((access.start_date && access.start_date > now) || (access.end_date && access.end_date < now)) {
      const loginUrl = new URL("/login", request.url);
      loginUrl.searchParams.set("error", "Your access period is not active. Contact your administrator.");
      return NextResponse.redirect(loginUrl);
    }

    // Check role is allowed for this route
    const allowedRoles = ROUTE_ROLE_MAP[matchedPrefix!];
    if (allowedRoles && allowedRoles.length > 0 && !allowedRoles.includes(access.role)) {
      // Redirect to their correct dashboard instead of showing an error
      const roleRoutes: Record<string, string> = {
        HO: "/admin",
        Apostle: "/review",
        Overseer: "/review",
        Elder: "/elder",
        Chairperson: "/chairperson",
        Treasurer: "/treasurer",
        Auditor: "/audit",
        Secretary: "/reports",
      };
      const correctRoute = roleRoutes[access.role] ?? "/dashboard";
      return NextResponse.redirect(new URL(correctRoute, request.url));
    }
  }

  // ── Redirect authenticated users away from login to their dashboard ──────
  if (pathname === "/login" && user) {
    const { data: access } = await supabase
      .from("user_hierarchy_access")
      .select("role")
      .eq("user_id", user.id)
      .eq("status", "active")
      .order("created_at", { ascending: true })
      .limit(1)
      .single();

    if (access) {
      const roleRoutes: Record<string, string> = {
        HO: "/admin",
        Apostle: "/review",
        Overseer: "/review",
        Elder: "/elder",
        Chairperson: "/chairperson",
        Treasurer: "/treasurer",
        Auditor: "/audit",
        Secretary: "/reports",
      };
      const route = roleRoutes[access.role] ?? "/dashboard";
      return NextResponse.redirect(new URL(route, request.url));
    }
  }

  return response;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
