// ─────────────────────────────────────────────────────────────────────────────
// OFFLINE PIN CRYPTOGRAPHIC ENGINE (WebCrypto / SubtleCrypto)
// Implements the design's threat model:
//  - PBKDF2 (SHA-256) with a per-user random salt + high iteration count to derive
//    the stored PIN hash. The raw PIN is never stored (Req 4.2, 4.5, 5.1, 15.1, 15.2).
//  - A PIN-keyed HMAC over the integrity-protected credential fields so tampering
//    with cached role/access-window without the PIN is detectable (Req 4.4, 15.3).
//  - Constant-time comparison for hash/HMAC checks.
//
// All functions are pure (no storage side effects) so they can be exhaustively
// property-tested (design Properties 1, 2, 3). WebCrypto is available in browsers
// and in Node >= 20 via globalThis.crypto, so the same code runs under Vitest.
// ─────────────────────────────────────────────────────────────────────────────

/** Default PBKDF2 work factor. Recorded per-credential for forward compatibility. */
export const DEFAULT_PBKDF2_ITERATIONS = 210_000;
const HASH_ALGO = "SHA-256";
const DERIVED_BITS = 256;
/** Distinct "info" salts so the verification hash and the HMAC key never collide. */
const HMAC_KEY_INFO = "oac-cashbook:hmac-key:v1";
const PIN_HASH_INFO = "oac-cashbook:pin-hash:v1";

const subtle = (): SubtleCrypto => {
  const c = globalThis.crypto;
  if (!c?.subtle) throw new Error("WebCrypto SubtleCrypto is not available in this environment");
  return c.subtle;
};

// ─── base64 helpers (browser + Node safe) ────────────────────────────────────
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

const encoder = new TextEncoder();

// TypeScript 5.7 parameterizes typed arrays as Uint8Array<ArrayBufferLike>, while the
// WebCrypto lib types expect BufferSource over ArrayBuffer. Coerce at the API boundary.
const asBuffer = (u: Uint8Array): BufferSource => u as unknown as BufferSource;

/** Generate a cryptographically-random per-user salt (Req 15.2). */
export function generateSalt(byteLength = 16): string {
  const salt = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(salt);
  return bytesToBase64(salt);
}

// ─── PBKDF2 PIN hash (Req 4.2, 5.1, 15.1) ─────────────────────────────────────
async function pbkdf2Bits(
  pin: string,
  saltBytes: Uint8Array,
  iterations: number,
  info: string,
  bits = DERIVED_BITS
): Promise<Uint8Array> {
  const keyMaterial = await subtle().importKey(
    "raw",
    asBuffer(encoder.encode(pin)),
    { name: "PBKDF2" },
    false,
    ["deriveBits"]
  );
  // Bind the derivation purpose into the salt so the PIN-hash and HMAC-key
  // derivations are domain-separated even with the same salt.
  const domainSalt = new Uint8Array([...saltBytes, ...encoder.encode(info)]);
  const derived = await subtle().deriveBits(
    { name: "PBKDF2", salt: asBuffer(domainSalt), iterations, hash: HASH_ALGO },
    keyMaterial,
    bits
  );
  return new Uint8Array(derived);
}

/**
 * Derive the stored PIN hash (base64) from a PIN + salt using PBKDF2-SHA256.
 * Deterministic: same (pin, salt, iterations) -> same hash (Property 2).
 */
export async function derivePinHash(
  pin: string,
  salt: string,
  iterations: number = DEFAULT_PBKDF2_ITERATIONS
): Promise<string> {
  const bits = await pbkdf2Bits(pin, base64ToBytes(salt), iterations, PIN_HASH_INFO);
  return bytesToBase64(bits);
}

// ─── PIN-keyed HMAC integrity (Req 4.4, 15.3) ─────────────────────────────────
/**
 * Compute an HMAC-SHA256 (base64) over `message` using a key derived from the PIN.
 * Because the key is PIN-derived, an attacker who edits cached role/access-window
 * in IndexedDB cannot forge a matching HMAC without knowing the PIN.
 */
export async function computeHmac(
  message: string,
  pin: string,
  salt: string,
  iterations: number = DEFAULT_PBKDF2_ITERATIONS
): Promise<string> {
  const keyBits = await pbkdf2Bits(pin, base64ToBytes(salt), iterations, HMAC_KEY_INFO);
  const hmacKey = await subtle().importKey(
    "raw",
    asBuffer(keyBits),
    { name: "HMAC", hash: HASH_ALGO },
    false,
    ["sign"]
  );
  const sig = await subtle().sign("HMAC", hmacKey, asBuffer(encoder.encode(message)));
  return bytesToBase64(new Uint8Array(sig));
}

/** Verify an HMAC in constant time (Req 5.4, 15.4). */
export async function verifyHmac(
  message: string,
  expectedHmac: string,
  pin: string,
  salt: string,
  iterations: number = DEFAULT_PBKDF2_ITERATIONS
): Promise<boolean> {
  const actual = await computeHmac(message, pin, salt, iterations);
  return constantTimeEqual(actual, expectedHmac);
}

/**
 * Verify a submitted PIN against a stored hash in constant time (Property 1).
 */
export async function verifyPin(
  pin: string,
  storedHash: string,
  salt: string,
  iterations: number = DEFAULT_PBKDF2_ITERATIONS
): Promise<boolean> {
  const candidate = await derivePinHash(pin, salt, iterations);
  return constantTimeEqual(candidate, storedHash);
}

/**
 * Constant-time string comparison to avoid timing side-channels on hash/HMAC checks.
 * Compares full length regardless of early mismatches.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const aBytes = encoder.encode(a);
  const bBytes = encoder.encode(b);
  // Fold length difference into the result without early return.
  let diff = aBytes.length ^ bBytes.length;
  const max = Math.max(aBytes.length, bBytes.length);
  for (let i = 0; i < max; i++) {
    diff |= (aBytes[i] ?? 0) ^ (bBytes[i] ?? 0);
  }
  return diff === 0;
}
