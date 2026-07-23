import { NextRequest, NextResponse } from "next/server";

export async function POST(request: NextRequest) {
  const secretKey = process.env.TURNSTILE_SECRET_KEY;

  // If Turnstile not configured, allow through (dev mode)
  if (!secretKey) {
    return NextResponse.json({ success: true });
  }

  try {
    const { token } = await request.json();

    if (!token) {
      return NextResponse.json({ success: false, error: "No token provided" }, { status: 400 });
    }

    // Verify with Cloudflare
    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        secret: secretKey,
        response: token,
        remoteip: request.headers.get("x-forwarded-for") ?? "",
      }),
    });

    const result = await response.json();

    if (!result.success) {
      return NextResponse.json({ success: false, error: "Verification failed" }, { status: 403 });
    }

    return NextResponse.json({ success: true });
  } catch {
    return NextResponse.json({ success: false, error: "Server error" }, { status: 500 });
  }
}
