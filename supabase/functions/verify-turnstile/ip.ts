// ─────────────────────────────────────────────────────────────────────────────
// Pure, Deno-free helpers for deriving the client IP from an `x-forwarded-for`
// header, extracted so they can be unit-tested without the Deno runtime.
//
// On Supabase, `x-forwarded-for` is often a comma-separated list ("client, proxy").
// Cloudflare's siteverify expects a single client IP for `remoteip`; passing the raw
// list can make verification return success:false. These helpers pick the first entry
// and only use it when it is a valid IP (remoteip is optional, so otherwise omit it).
// ─────────────────────────────────────────────────────────────────────────────

/** True for a syntactically valid IPv4 or (loosely) IPv6 address. */
export function isValidIp(ip: string): boolean {
  if (!ip) return false;

  // IPv4: four dotted octets, each 0–255.
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
  const m = v4.exec(ip);
  if (m) {
    return m.slice(1).every((octet) => {
      const n = Number(octet);
      return Number.isInteger(n) && n >= 0 && n <= 255;
    });
  }

  // IPv6: hex groups separated by colons (allows "::" compression). Loose check —
  // enough to decide whether it is safe to forward as remoteip.
  if (ip.includes(":") && /^[0-9a-fA-F:]+$/.test(ip) && ip.length <= 45) {
    return true;
  }

  return false;
}

/**
 * Parse an `x-forwarded-for` header value and return the first client IP, or null
 * when it is absent/empty/not a valid IP (in which case `remoteip` should be omitted).
 */
export function firstClientIp(xForwardedFor: string | null | undefined): string | null {
  if (!xForwardedFor) return null;
  const first = (xForwardedFor.split(",")[0] ?? "").trim();
  if (!first) return null;
  return isValidIp(first) ? first : null;
}
