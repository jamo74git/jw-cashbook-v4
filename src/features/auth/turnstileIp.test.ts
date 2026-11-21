// Unit tests for the pure x-forwarded-for -> first-valid-client-IP parsing used by the
// verify-turnstile Edge Function. The helper lives in the function folder so the Deno
// function stays self-contained; it is Deno-free so it can be tested under Node.
import { describe, it, expect } from "vitest";
import { firstClientIp, isValidIp } from "../../../supabase/functions/verify-turnstile/ip";

describe("firstClientIp", () => {
  it("returns a single valid IPv4 unchanged", () => {
    expect(firstClientIp("203.0.113.5")).toBe("203.0.113.5");
  });

  it("returns only the FIRST IP from a comma-separated list", () => {
    expect(firstClientIp("203.0.113.5, 70.41.3.18, 150.172.238.178")).toBe("203.0.113.5");
  });

  it("trims surrounding whitespace on the first entry", () => {
    expect(firstClientIp("  203.0.113.5  , 70.41.3.18")).toBe("203.0.113.5");
  });

  it("returns a valid IPv6 address", () => {
    expect(firstClientIp("2001:db8::1, 70.41.3.18")).toBe("2001:db8::1");
  });

  it("omits (null) when the header is absent", () => {
    expect(firstClientIp(null)).toBeNull();
    expect(firstClientIp(undefined)).toBeNull();
    expect(firstClientIp("")).toBeNull();
  });

  it("omits (null) when the first entry is empty", () => {
    expect(firstClientIp(", 70.41.3.18")).toBeNull();
    expect(firstClientIp("   , 70.41.3.18")).toBeNull();
  });

  it("omits (null) when the first entry is not a valid IP", () => {
    expect(firstClientIp("unknown")).toBeNull();
    expect(firstClientIp("not-an-ip, 70.41.3.18")).toBeNull();
    expect(firstClientIp("999.1.1.1")).toBeNull();
    expect(firstClientIp("1.2.3")).toBeNull();
  });
});

describe("isValidIp", () => {
  it("accepts valid IPv4", () => {
    expect(isValidIp("0.0.0.0")).toBe(true);
    expect(isValidIp("255.255.255.255")).toBe(true);
    expect(isValidIp("192.168.1.1")).toBe(true);
  });

  it("rejects out-of-range or malformed IPv4", () => {
    expect(isValidIp("256.0.0.1")).toBe(false);
    expect(isValidIp("1.2.3")).toBe(false);
    expect(isValidIp("1.2.3.4.5")).toBe(false);
    expect(isValidIp("")).toBe(false);
    expect(isValidIp("abc")).toBe(false);
  });

  it("accepts loose IPv6", () => {
    expect(isValidIp("::1")).toBe(true);
    expect(isValidIp("2001:db8::1")).toBe(true);
  });
});
