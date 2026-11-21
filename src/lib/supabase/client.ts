import { createBrowserClient } from "@supabase/ssr";

// Vite exposes env vars via import.meta.env. vite.config.ts sets envPrefix to
// accept both VITE_ and NEXT_PUBLIC_ so the existing .env.local keys keep working.

/**
 * Identifiable error thrown when the Supabase client cannot be configured. Distinct
 * from a generic runtime error so the app error boundary can show a clear "contact
 * the administrator" message instead of silently constructing a broken client (which
 * threw deep inside @supabase/ssr and blanked the whole tree).
 */
export class SupabaseConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SupabaseConfigError";
  }
}

/** Reads a required public env var, failing with a clear, secret-free message when it
 * is missing or empty. Only the variable NAME is ever surfaced, never its value. */
function requireEnv(name: string, value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new SupabaseConfigError(
      `Missing Supabase configuration: ${name} is not set. ` +
        "The app cannot start until the environment is configured.",
    );
  }
  return value;
}

export function createClient() {
  // Read at call time (not module load) so a missing config surfaces as a catchable
  // error when a page actually needs Supabase, rather than crashing on import.
  const supabaseUrl = requireEnv(
    "NEXT_PUBLIC_SUPABASE_URL",
    import.meta.env.NEXT_PUBLIC_SUPABASE_URL,
  );
  const supabaseAnonKey = requireEnv(
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    import.meta.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );
  return createBrowserClient(supabaseUrl, supabaseAnonKey);
}
