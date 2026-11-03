// ─────────────────────────────────────────────────────────────────────────────
// STORAGE PORT (Tranche 4 — proof-access)
// The single place the app mints short-lived SIGNED urls for private proofs and
// uploads proof objects. Callers (ProofLink, sync) depend on this instead of touching
// supabase.storage directly. Signed urls are minted on demand and NEVER persisted.
//
// Scope is deliberately narrow: only what proof read/upload needs. Not a general
// storage abstraction.
// ─────────────────────────────────────────────────────────────────────────────

import { createClient } from "@/lib/supabase/client";
import { PROOF_BUCKET, resolveProofKey } from "@/lib/storage/proofReference";

const DEFAULT_TTL_SECONDS = 120;

// A proof load has four honest outcomes. An unsuccessful load is NEVER represented as
// viewable/reviewed evidence — callers must surface missing/denied/error distinctly.
export type SignedUrlResult =
  | { status: "ok"; url: string }
  | { status: "missing" } // no usable reference, or the object does not exist
  | { status: "denied" } // storage RLS refused access
  | { status: "error" }; // transient/unknown failure — safe to retry

interface StorageErrorLike {
  message?: string;
  status?: number;
  statusCode?: string | number;
  name?: string;
}

/**
 * Classify a Supabase Storage error into a review-safe outcome. Pure + exported so the
 * client failure-handling is unit-testable without a live backend. (This verifies
 * CLIENT behaviour only; it is not a claim about server-side authorisation.)
 */
export function classifyStorageError(error: StorageErrorLike | null | undefined): SignedUrlResult {
  if (!error) return { status: "error" };
  const code = Number(error.status ?? error.statusCode ?? NaN);
  const msg = (error.message ?? "").toLowerCase();

  if (code === 404 || msg.includes("not found") || msg.includes("does not exist")) {
    return { status: "missing" };
  }
  if (
    code === 401 ||
    code === 403 ||
    msg.includes("unauthorized") ||
    msg.includes("forbidden") ||
    msg.includes("permission") ||
    msg.includes("denied") ||
    msg.includes("row-level security") ||
    msg.includes("violates row-level") ||
    msg.includes("not authorized")
  ) {
    return { status: "denied" };
  }
  return { status: "error" };
}

/**
 * Mint a short-lived signed url for a stored proof reference (legacy public url or
 * bare key). Returns a discriminated result; the url is transient and must not be
 * cached or written back to the attachment row.
 */
export async function getProofSignedUrl(
  stored: string | null | undefined,
  ttlSeconds: number = DEFAULT_TTL_SECONDS
): Promise<SignedUrlResult> {
  const ref = resolveProofKey(stored);
  if (ref.kind !== "key") return { status: "missing" };

  try {
    const supabase = createClient();
    const { data, error } = await supabase.storage
      .from(PROOF_BUCKET)
      .createSignedUrl(ref.key, ttlSeconds);
    if (error) return classifyStorageError(error as StorageErrorLike);
    if (!data?.signedUrl) return { status: "error" };
    return { status: "ok", url: data.signedUrl };
  } catch {
    return { status: "error" };
  }
}

/**
 * Upload a proof object at the given durable key. Returns nothing; the caller stores
 * the key (not a url). Kept thin so sync can keep its own client/flow.
 */
export async function uploadProofObject(objectKey: string, blob: Blob): Promise<void> {
  const supabase = createClient();
  const { error } = await supabase.storage.from(PROOF_BUCKET).upload(objectKey, blob);
  if (error) throw new Error(`Proof upload failed: ${error.message}`);
}

// Tranche 4 (item 8): pure decision for how ProofLink should act on a signed-url result
// given whether a popup window is actually available. Keeps the component logic testable
// without a DOM. "inline" means the popup was blocked — show an explicit open control
// and do NOT navigate the current tab away. A failed load is never "ok".
export type OpenProofAction =
  | { kind: "navigate"; url: string }
  | { kind: "inline"; url: string }
  | { kind: "fail"; status: "missing" | "denied" | "error" };

export function decideProofOpen(res: SignedUrlResult, popupAvailable: boolean): OpenProofAction {
  if (res.status === "ok") {
    return popupAvailable ? { kind: "navigate", url: res.url } : { kind: "inline", url: res.url };
  }
  return { kind: "fail", status: res.status };
}
