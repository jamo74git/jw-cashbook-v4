import { createBrowserClient } from "@supabase/ssr";

// Vite exposes env vars via import.meta.env. vite.config.ts sets envPrefix to
// accept both VITE_ and NEXT_PUBLIC_ so the existing .env.local keys keep working.
const supabaseUrl = import.meta.env.NEXT_PUBLIC_SUPABASE_URL as string;
const supabaseAnonKey = import.meta.env.NEXT_PUBLIC_SUPABASE_ANON_KEY as string;

export function createClient() {
  return createBrowserClient(supabaseUrl, supabaseAnonKey);
}
