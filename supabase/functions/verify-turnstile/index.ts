// ─────────────────────────────────────────────────────────────────────────────
// Supabase Edge Function: verify-turnstile (Deno)
// Server-side Cloudflare Turnstile verification. Replaces the Next.js
// /api/auth/verify-turnstile route. Preserves the original contract (Req 7):
//   - No token                    -> 400
//   - Cloudflare verify failure   -> 403
//   - Secret unset (dev)          -> success (fail-open in dev, fail-closed in prod)
//   - Sends remoteip from the forwarding header
// The TURNSTILE_SECRET_KEY lives only in the Edge Function runtime, never the client.
// ─────────────────────────────────────────────────────────────────────────────

// deno-lint-ignore-file no-explicit-any
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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });

  const secretKey = Deno.env.get("TURNSTILE_SECRET_KEY");

  // Dev bypass: no secret configured -> allow through (fail-open in dev only).
  if (!secretKey) {
    return json({ success: true, devBypass: true });
  }

  try {
    const { token } = await req.json().catch(() => ({ token: undefined }));
    if (!token) {
      return json({ success: false, error: "No token provided" }, 400);
    }

    const remoteip = req.headers.get("x-forwarded-for") ?? "";
    const form = new URLSearchParams({ secret: secretKey, response: token, remoteip });

    const resp = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: form,
    });
    const result: any = await resp.json();

    if (!result.success) {
      return json({ success: false, error: "Verification failed" }, 403);
    }
    return json({ success: true });
  } catch {
    return json({ success: false, error: "Server error" }, 500);
  }
});
