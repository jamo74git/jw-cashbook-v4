import { createServerClient, type CookieOptions } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

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

  // Protect app routes
  const protectedPrefixes = ["/treasurer", "/audit", "/capture", "/review", "/admin", "/submit"];
  const isProtected = protectedPrefixes.some((p) => pathname.startsWith(p));

  if (isProtected && !user) {
    return NextResponse.redirect(new URL("/login", request.url));
  }

  // For protected routes, check profile status and date range
  if (isProtected && user) {
    const { data: profile } = await supabase
      .from("profiles")
      .select("status, start_date, userend_date")
      .eq("id", user.id)
      .single();

    const now = new Date().toISOString();
    const isBlocked =
      !profile ||
      profile.status !== "active" ||
      (profile.start_date && profile.start_date > now) ||
      (profile.userend_date && profile.userend_date < now);

    if (isBlocked) {
      // Redirect to login with an error message
      const loginUrl = new URL("/login", request.url);
      loginUrl.searchParams.set(
        "error",
        "Access is restricted to registered congregation members."
      );
      return NextResponse.redirect(loginUrl);
    }
  }

  // Skip login if already signed in
  if (pathname === "/login" && user) {
    return NextResponse.redirect(new URL("/treasurer", request.url));
  }

  return response;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
