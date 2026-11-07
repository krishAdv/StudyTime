import { describe, expect, it } from "vitest";
import { SyncError, SyncResponseError, classifySyncError, redactSensitive, type SyncErrorKind } from "@/lib/sync/errors";

const pg = (code: string, message = "boom") => ({ code, message, details: null, hint: null });

describe("classifySyncError: server-defined codes", () => {
  it.each([
    ["ST001", "import_mismatch"],
    ["ST002", "account_not_empty"],
    ["ST003", "conflict"],
    ["ST004", "refused"],
    ["28000", "auth"],
    ["PGRST202", "unavailable"],
    ["PGRST301", "auth"],
    ["PGRST302", "auth"],
    ["PGRST303", "auth"],
    ["22023", "invalid_request"],
    ["22P02", "invalid_request"],
    ["22003", "invalid_request"],
    ["23505", "invalid_request"],
    ["23514", "invalid_request"],
    ["23503", "invalid_request"],
    ["PGRST100", "invalid_request"],
    ["PGRST102", "invalid_request"],
  ] as [string, SyncErrorKind][])("%s is %s", (code, kind) => {
    const e = classifySyncError(pg(code), 400);
    expect(e.kind).toBe(kind);
    expect(e.code).toBe(code);
  });

  it("tells a permission denial for a signed-out caller (401) from one for a signed-in caller (403)", () => {
    expect(classifySyncError(pg("42501", "permission denied for function push_changes"), 401).kind).toBe("auth");
    expect(classifySyncError(pg("42501", "permission denied for function push_changes"), 403).kind).toBe("forbidden");
    expect(classifySyncError(pg("42501"), null).kind).toBe("forbidden");
  });

  it("a server code wins over the HTTP status (a 404 or 500 carrying ST003 is still a conflict)", () => {
    expect(classifySyncError(pg("ST003"), 404).kind).toBe("conflict");
    expect(classifySyncError(pg("ST004"), 500).kind).toBe("refused");
    expect(classifySyncError(pg("PGRST202"), 400).kind).toBe("unavailable");
  });
});

describe("classifySyncError: HTTP status and message when there is no known code", () => {
  it.each([
    [401, "auth"],
    [403, "forbidden"],
    [404, "unavailable"],
    [429, "server"],
    [500, "server"],
    [502, "server"],
    [503, "server"],
    [0, "network"],
    [400, "invalid_request"],
  ] as [number, SyncErrorKind][])("status %d is %s", (status, kind) => {
    expect(classifySyncError({ message: "x", code: "" }, status).kind).toBe(kind);
  });

  it("recognizes expired or invalid tokens by message", () => {
    expect(classifySyncError({ message: "JWT expired" }).kind).toBe("auth");
    expect(classifySyncError({ message: "invalid JWT: unable to parse" }).kind).toBe("auth");
  });

  it("recognizes connection failures, with or without a status", () => {
    expect(classifySyncError(new TypeError("fetch failed")).kind).toBe("network");
    expect(classifySyncError({ message: "TypeError: Failed to fetch", code: "" }).kind).toBe("network");
    expect(classifySyncError(new Error("The operation timed out")).kind).toBe("network");
    expect(classifySyncError(new Error("network request failed")).kind).toBe("network");
    expect(classifySyncError(Object.assign(new Error("x"), { name: "AbortError" })).kind).toBe("network");
    expect(classifySyncError(new DOMException("timed out", "TimeoutError")).kind).toBe("network");
  });

  it("everything else is unknown", () => {
    for (const input of [new Error("something odd"), { message: "weird", code: "XX000" }, "just text", 42, null, undefined, {}]) {
      expect(classifySyncError(input).kind).toBe("unknown");
    }
  });
});

describe("SyncError", () => {
  it("keeps the original code, status and a detail, with a generic message", () => {
    const e = classifySyncError(pg("ST003", "conflict: classes_pkey (at change 2)"), 400);
    expect(e).toBeInstanceOf(SyncError);
    expect(e).toBeInstanceOf(Error);
    expect(e.name).toBe("SyncError");
    expect(e.code).toBe("ST003");
    expect(e.status).toBe(400);
    expect(e.detail).toContain("classes_pkey");
    expect(e.message).toBe("A name or id clashes with data already in your account.");
  });

  it("marks only connection and server trouble as retryable", () => {
    const kinds: SyncErrorKind[] = [
      "network", "server", "auth", "forbidden", "conflict", "refused", "account_not_empty",
      "import_mismatch", "invalid_request", "unavailable", "malformed_response", "unknown",
    ];
    const retryable = kinds.filter((k) => new SyncError(k).retryable);
    expect(retryable).toEqual(["network", "server"]);
  });

  it("has a user-safe message for every kind", () => {
    const kinds: SyncErrorKind[] = [
      "network", "server", "auth", "forbidden", "conflict", "refused", "account_not_empty",
      "import_mismatch", "invalid_request", "unavailable", "malformed_response", "unknown",
    ];
    const messages = kinds.map((k) => new SyncError(k).message);
    expect(new Set(messages).size).toBe(kinds.length);
    for (const m of messages) expect(m.length).toBeGreaterThan(10);
  });

  it("returns an existing SyncError unchanged", () => {
    const original = new SyncError("auth", { code: "28000" });
    expect(classifySyncError(original)).toBe(original);
    const response = new SyncResponseError("pull_snapshot: revision is not a whole number");
    expect(classifySyncError(response)).toBe(response);
  });

  it("represents a malformed response as its own typed error", () => {
    const e = new SyncResponseError("pull_snapshot: classes[0].name is not text");
    expect(e).toBeInstanceOf(SyncError);
    expect(e.kind).toBe("malformed_response");
    expect(e.name).toBe("SyncResponseError");
    expect(e.retryable).toBe(false);
  });

  it("never classifies anything as 'stale': a stale revision is a normal result, not an error", () => {
    const inputs: [unknown, number | undefined][] = [
      [pg("ST003", "stale revision"), 409], [pg("40001", "stale"), 409], [pg("ST999", "stale"), 412],
      [{ message: "stale", code: "" }, 409], [new Error("stale base revision"), undefined], ["stale", undefined],
    ];
    for (const [input, status] of inputs) expect(classifySyncError(input, status).kind).not.toBe("stale");
  });
});

describe("redaction", () => {
  const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abc-DEF_123";

  it.each([
    ["a JWT", `token was ${jwt} here`, jwt],
    ["a bearer header", "Authorization: Bearer abc.def-ghi_jkl123", "abc.def-ghi_jkl123"],
    ["a publishable key", "key sb_publishable_AbCdEf123_456 rejected", "sb_publishable_AbCdEf123_456"],
    ["a secret key", "key sb_secret_AbCdEf123_456 rejected", "sb_secret_AbCdEf123_456"],
    ["an apikey value", "apikey=supersecretvalue123", "supersecretvalue123"],
    ["a password value", 'password: "hunter2hunter2"', "hunter2hunter2"],
    ["an e-mail address", "failed for jane.doe@example.com today", "jane.doe@example.com"],
  ])("removes %s", (_label, text, secret) => {
    expect(redactSensitive(text)).not.toContain(secret);
    expect(redactSensitive(text).length).toBeGreaterThan(0);
  });

  it("leaves ordinary diagnostics readable", () => {
    expect(redactSensitive("invalid_payload: change 2 (add_class) refers to a class that does not exist.")).toBe(
      "invalid_payload: change 2 (add_class) refers to a class that does not exist.",
    );
  });

  it("limits the length", () => {
    expect(redactSensitive("x".repeat(5000)).length).toBe(300);
  });

  it("never leaves credentials in an error's detail or message", () => {
    const e = classifySyncError({ message: `request failed with ${jwt} for jane@example.com`, code: "XX000" }, 500);
    const text = `${e.message} ${e.detail}`;
    expect(text).not.toContain(jwt);
    expect(text).not.toContain("jane@example.com");
    expect(e.detail).toContain("[token]");
    expect(e.detail).toContain("[email]");
  });

  it("does not copy any request into the error: only the response's message is used", () => {
    const e = classifySyncError({ code: "22023", message: "invalid_payload: change 1 is not an object.", request: { p_changes: [{ name: "PRIVATE-STUDY-DATA" }] } } as never, 400);
    expect(JSON.stringify({ message: e.message, detail: e.detail, code: e.code, status: e.status })).not.toContain("PRIVATE-STUDY-DATA");
  });
});
