// Verifies that createClient() surfaces a clear, identifiable error when the public
// Supabase env vars are missing/empty, instead of silently building a broken client
// (which previously threw deep inside @supabase/ssr and blanked the whole app).
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createClient, SupabaseConfigError } from "@/lib/supabase/client";

// Hoisted so vi.mock's factory can safely reference the spy (vi.mock is hoisted).
const mock = vi.hoisted(() => ({ createBrowserClient: vi.fn(() => ({ __mockClient: true })) }));
vi.mock("@supabase/ssr", () => ({ createBrowserClient: mock.createBrowserClient }));

const createBrowserClient = mock.createBrowserClient;

describe("createClient configuration guard", () => {
  beforeEach(() => {
    createBrowserClient.mockClear();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("throws a SupabaseConfigError naming the URL var when it is missing", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key");
    expect(() => createClient()).toThrow(SupabaseConfigError);
    expect(() => createClient()).toThrow(/NEXT_PUBLIC_SUPABASE_URL/);
    expect(createBrowserClient).not.toHaveBeenCalled();
  });

  it("throws a SupabaseConfigError naming the anon key var when it is missing", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "");
    expect(() => createClient()).toThrow(/NEXT_PUBLIC_SUPABASE_ANON_KEY/);
    expect(createBrowserClient).not.toHaveBeenCalled();
  });

  it("does not leak the secret value in the error message", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "");
    let message = "";
    try {
      createClient();
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).not.toContain("https://example.supabase.co");
  });

  it("builds the client when both vars are present", () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_ANON_KEY", "anon-key");
    const client = createClient();
    expect(client).toEqual({ __mockClient: true });
    expect(createBrowserClient).toHaveBeenCalledWith("https://example.supabase.co", "anon-key");
  });
});
