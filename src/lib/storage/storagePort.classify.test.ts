import { describe, it, expect } from "vitest";
import { classifyStorageError } from "@/lib/storage/storagePort";

// These tests verify CLIENT failure-handling only (how the reader maps a storage error
// to a review-safe outcome). They are NOT a claim about server-side authorisation.
describe("classifyStorageError", () => {
  it("maps 404 / not-found to missing", () => {
    expect(classifyStorageError({ status: 404 }).status).toBe("missing");
    expect(classifyStorageError({ message: "Object not found" }).status).toBe("missing");
    expect(classifyStorageError({ message: "The resource does not exist" }).status).toBe("missing");
  });

  it("maps 401/403 and RLS/permission messages to denied", () => {
    expect(classifyStorageError({ status: 403 }).status).toBe("denied");
    expect(classifyStorageError({ statusCode: "401" }).status).toBe("denied");
    expect(classifyStorageError({ message: "new row violates row-level security policy" }).status).toBe("denied");
    expect(classifyStorageError({ message: "Unauthorized" }).status).toBe("denied");
    expect(classifyStorageError({ message: "permission denied" }).status).toBe("denied");
  });

  it("maps unknown/transient to error (retryable)", () => {
    expect(classifyStorageError({ status: 500 }).status).toBe("error");
    expect(classifyStorageError({ message: "network timeout" }).status).toBe("error");
    expect(classifyStorageError({}).status).toBe("error");
    expect(classifyStorageError(null).status).toBe("error");
  });

  it("never returns ok for an error (a failed load is never viewable evidence)", () => {
    for (const e of [{ status: 404 }, { status: 403 }, { status: 500 }, {}, null]) {
      expect(classifyStorageError(e).status).not.toBe("ok");
    }
  });
});
