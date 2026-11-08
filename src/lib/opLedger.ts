// ─────────────────────────────────────────────────────────────────────────────
// DURABLE-REPLAY IDEMPOTENCY primitives (PRIORITY 1).
// A stable per-operation identity so a retry after a LOST ACKNOWLEDGEMENT never
// creates a duplicate server effect. These are pure helpers; the Sync_Engine uses
// them to generate the dedupe key and to decide whether an operation whose effect is
// already present still needs to be issued.
//
// AUTHORITATIVE duplicate-suppression is a server-side UNIQUE/dedupe key (authored,
// schema-gated, NOT applied here — must be proven with authenticated/hosted testing).
// The client-side pre-check below closes the common lost-ack gap at the app layer.
// ─────────────────────────────────────────────────────────────────────────────

export type OpKind = "ACTING_AS_TREASURER" | "SUBMIT" | "AUDIT_DECISION";

/**
 * Deterministic dedupe key for a per-entity governance/metadata operation. The SAME
 * inputs always produce the SAME key, so a replay carries the identical key and the
 * server unique index (or the client pre-check) collapses it to a single effect.
 * `discriminator` separates distinct operations against the same entity (e.g. a
 * capture generation or revision), and empty segments are dropped so the key is stable.
 */
export function operationDedupeKey(
  kind: OpKind,
  entityId: string,
  actorUserId: string,
  discriminator = ""
): string {
  return [kind, entityId, actorUserId, discriminator].filter((x) => x !== "").join(":");
}

/**
 * Replay guard: given the dedupe keys already known to be committed server-side (e.g.
 * from a pre-insert lookup), decide whether this operation still needs to be issued.
 * Returns FALSE (skip) when the key is already present — the idempotent-replay case.
 */
export function shouldIssueOperation(committedKeys: Iterable<string>, dedupeKey: string): boolean {
  for (const k of committedKeys) {
    if (k === dedupeKey) return false;
  }
  return true;
}
