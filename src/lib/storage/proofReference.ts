// ─────────────────────────────────────────────────────────────────────────────
// PROOF REFERENCE RESOLVER (Tranche 4 — proof-access)
// Pure, dependency-free. Turns a stored cashbook_attachment.file_url into a durable
// Storage OBJECT KEY, accepting BOTH:
//   (a) legacy PUBLIC urls written before private reading, and
//   (b) bare object keys written going forward (syncEngine.uploadProof).
//
// Validation is EXACT (origin + known object route + exact bucket segment). It never
// uses substring matching, so a look-alike host or a bucket name embedded elsewhere in
// the string cannot be mistaken for a real proof reference.
// ─────────────────────────────────────────────────────────────────────────────

// The one project + bucket this app's proofs live in. Keep in sync with
// src/utils/syncEngine.ts (PROOF_BUCKET) and src/lib/supabase/client.ts origin.
export const PROOF_PROJECT_ORIGIN = "https://cwdyixafvylzgtpsfmwr.supabase.co";
export const PROOF_BUCKET = "cashbook-proofs";

// Supabase Storage object routes. A stored URL must begin with exactly one of these
// (after the exact origin) for us to trust it and extract a key.
const OBJECT_ROUTES = [
  "/storage/v1/object/public/",
  "/storage/v1/object/sign/",
  "/storage/v1/object/authenticated/",
];

export type ProofRef =
  | { kind: "key"; key: string }
  | { kind: "unrecognized"; reason: string };

const SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Resolve a stored file_url into a Storage object key, or classify it as unrecognized.
 * Bare keys (no URL scheme) are accepted directly; absolute URLs must match the exact
 * project origin, a known Storage object route, and the exact proof bucket.
 */
export function resolveProofKey(stored: string | null | undefined): ProofRef {
  if (stored == null) return { kind: "unrecognized", reason: "empty" };
  const raw = stored.trim();
  if (!raw) return { kind: "unrecognized", reason: "empty" };

  // (b) Bare object key — no URL scheme. Accept after normalisation.
  if (!SCHEME_RE.test(raw)) return normalizeKey(raw);

  // (a) Absolute URL — must parse and match EXACT origin + route + bucket.
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { kind: "unrecognized", reason: "malformed-url" };
  }
  if (u.origin !== PROOF_PROJECT_ORIGIN) return { kind: "unrecognized", reason: "foreign-origin" };

  let path: string;
  try {
    path = decodeURIComponent(u.pathname);
  } catch {
    return { kind: "unrecognized", reason: "malformed-path" };
  }

  const route = OBJECT_ROUTES.find((r) => path.startsWith(r));
  if (!route) return { kind: "unrecognized", reason: "not-storage-object" };

  const afterRoute = path.slice(route.length); // "<bucket>/<key...>"
  const slash = afterRoute.indexOf("/");
  if (slash <= 0) return { kind: "unrecognized", reason: "no-bucket-segment" };

  const bucket = afterRoute.slice(0, slash);
  if (bucket !== PROOF_BUCKET) return { kind: "unrecognized", reason: "foreign-bucket" };

  return normalizeKey(afterRoute.slice(slash + 1));
}

function normalizeKey(key: string): ProofRef {
  const k = key.replace(/^\/+/, "");
  if (!k) return { kind: "unrecognized", reason: "empty-key" };
  // Reject path traversal / absolute escapes; proof keys are simple nested segments.
  if (k.split("/").some((seg) => seg === ".." || seg === ".")) {
    return { kind: "unrecognized", reason: "traversal" };
  }
  return { kind: "key", key: k };
}
