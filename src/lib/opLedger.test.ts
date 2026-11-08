// PRIORITY 1 — idempotent replay primitives. A replay carries the SAME dedupe key, so
// a committed operation is never issued twice (no duplicate after a lost acknowledgement).
import { describe, it, expect } from "vitest";
import { operationDedupeKey, shouldIssueOperation } from "@/lib/opLedger";

describe("operationDedupeKey", () => {
  it("is deterministic for the same operation (stable across retries)", () => {
    const a = operationDedupeKey("ACTING_AS_TREASURER", "period-1", "user-1");
    const b = operationDedupeKey("ACTING_AS_TREASURER", "period-1", "user-1");
    expect(a).toBe(b);
    expect(a).toBe("ACTING_AS_TREASURER:period-1:user-1");
  });
  it("distinguishes different entities, actors and kinds", () => {
    const base = operationDedupeKey("ACTING_AS_TREASURER", "period-1", "user-1");
    expect(operationDedupeKey("ACTING_AS_TREASURER", "period-2", "user-1")).not.toBe(base);
    expect(operationDedupeKey("ACTING_AS_TREASURER", "period-1", "user-2")).not.toBe(base);
    expect(operationDedupeKey("SUBMIT", "period-1", "user-1")).not.toBe(base);
  });
  it("includes a discriminator (e.g. revision) and drops empty segments", () => {
    expect(operationDedupeKey("SUBMIT", "p1", "u1", "rev2")).toBe("SUBMIT:p1:u1:rev2");
    expect(operationDedupeKey("SUBMIT", "p1", "u1", "")).toBe("SUBMIT:p1:u1");
  });
});

describe("shouldIssueOperation (replay guard)", () => {
  const key = operationDedupeKey("ACTING_AS_TREASURER", "p1", "u1");
  it("issues when the key is not yet committed", () => {
    expect(shouldIssueOperation([], key)).toBe(true);
    expect(shouldIssueOperation(["other:key"], key)).toBe(true);
  });
  it("skips (idempotent) when the committed key is already present", () => {
    expect(shouldIssueOperation([key], key)).toBe(false);
    expect(shouldIssueOperation(new Set(["x", key]), key)).toBe(false);
  });
});
