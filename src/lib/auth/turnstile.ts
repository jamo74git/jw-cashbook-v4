// ─────────────────────────────────────────────────────────────────────────────
// Client-side interpretation of the `verify-turnstile` Edge Function response.
//
// The gate itself is unchanged: any non-success still blocks sign-in. This only
// chooses the user-facing message, distinguishing a GENUINE verification failure
// (the function returned success:false, possibly with Cloudflare error-codes) from
// the function being UNAVAILABLE / misconfigured (no verdict body — network error,
// 500, not deployed). Never weakens the gate when a site key is configured.
// ─────────────────────────────────────────────────────────────────────────────

export interface TurnstileResponseBody {
  success?: boolean;
  error?: string;
  errorCodes?: string[];
}

/**
 * Build the failure message for a verify-turnstile call. `data` is the parsed success
 * body (present on a 2xx response); `error` is the invoke error (set for non-2xx, e.g.
 * the 403 the function returns on verification failure, or a network/5xx error). The
 * function's JSON body (with error-codes) is read from the error's `context` Response
 * when it was not surfaced as `data`.
 */
export async function turnstileFailureMessage(
  data: TurnstileResponseBody | null | undefined,
  error: unknown,
): Promise<string> {
  const body = (data && typeof data === "object" ? data : null) ?? (await readErrorBody(error));

  if (body && body.success === false) {
    const codes = Array.isArray(body.errorCodes) ? body.errorCodes.filter(Boolean) : [];
    return codes.length
      ? `Security verification failed (${codes.join(", ")}). Please try again.`
      : "Security verification failed. Please try again.";
  }

  // No usable verdict -> the verification service could not be reached.
  return "Security verification is unavailable right now. Please try again, or contact the administrator if it persists.";
}

/** Best-effort read of the function's JSON body from a FunctionsHttpError context. */
async function readErrorBody(error: unknown): Promise<TurnstileResponseBody | null> {
  const ctx = (error as { context?: unknown } | null | undefined)?.context;
  if (typeof Response !== "undefined" && ctx instanceof Response) {
    try {
      return (await ctx.clone().json()) as TurnstileResponseBody;
    } catch {
      return null;
    }
  }
  return null;
}
