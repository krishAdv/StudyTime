import { describe, expect, it } from "vitest";
import { SyncResponseError } from "@/lib/sync/errors";
import { parseImportResponse, parsePullResponse, parsePushResponse } from "@/lib/sync/responses";

const pull = () => ({
  revision: 3,
  classes: [{ id: "c1", name: "Math", color: "#3b82f6" }],
  groups: [{ id: "g1", classId: "c1", name: "Unit 1" }],
  sessions: [{ id: "s1", classId: "c1", groupId: "g1", startedAt: 1_700_000_000_123, seconds: 1500, mode: "stopwatch" }],
});

function malformed(parse: (v: unknown) => unknown, input: unknown) {
  let error: unknown;
  try {
    parse(input);
  } catch (e) {
    error = e;
  }
  expect(error).toBeInstanceOf(SyncResponseError);
  expect((error as SyncResponseError).kind).toBe("malformed_response");
  return error as SyncResponseError;
}

/** Applies `change` to a fresh pull payload and returns the result as an untyped value. */
const mutated = (change: (p: ReturnType<typeof pull>) => void): unknown => {
  const p = pull();
  change(p);
  return p;
};

describe("parsePullResponse", () => {
  it("accepts a valid response and returns the revision beside the snapshot", () => {
    const r = parsePullResponse(pull());
    expect(r.revision).toBe(3);
    expect(r.snapshot).toEqual({ classes: pull().classes, groups: pull().groups, sessions: pull().sessions });
    expect("revision" in r.snapshot).toBe(false);
  });

  it("accepts an empty account at revision 0", () => {
    expect(parsePullResponse({ revision: 0, classes: [], groups: [], sessions: [] })).toEqual({
      revision: 0, snapshot: { classes: [], groups: [], sessions: [] },
    });
  });

  it("returns copies, not the objects it was given", () => {
    const input = pull();
    const r = parsePullResponse(input);
    expect(r.snapshot.classes[0]).not.toBe(input.classes[0]);
    expect(r.snapshot.sessions[0]).not.toBe(input.sessions[0]);
  });

  it("accepts values at the edges of every range", () => {
    const edge = pull();
    edge.classes[0].id = "😀".repeat(100);
    edge.sessions[0] = { ...edge.sessions[0], startedAt: 0, seconds: 1, groupId: null as unknown as string };
    expect(() => parsePullResponse(edge)).not.toThrow();
    edge.sessions[0] = { ...edge.sessions[0], startedAt: 253_402_300_799_999, seconds: 31_622_400, mode: "countdown" };
    expect(() => parsePullResponse(edge)).not.toThrow();
  });

  it.each([
    ["null", null],
    ["a string", "revision"],
    ["a list", []],
    ["an empty object", {}],
  ])("rejects a response that is %s", (_n, input) => {
    malformed(parsePullResponse, input);
  });

  it("rejects a missing or an extra top-level field", () => {
    malformed(parsePullResponse, mutated((p) => void delete (p as Partial<typeof p>).groups));
    malformed(parsePullResponse, { ...pull(), extra: 1 });
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, "3", null, undefined])(
    "rejects the revision %j",
    (revision) => {
      malformed(parsePullResponse, { ...pull(), revision });
    },
  );

  it("rejects lists that are not lists", () => {
    for (const key of ["classes", "groups", "sessions"] as const) malformed(parsePullResponse, { ...pull(), [key]: {} });
  });

  it("rejects class records with a wrong, missing or extra field", () => {
    malformed(parsePullResponse, mutated((p) => void ((p.classes[0] as unknown as { name: unknown }).name = 5)));
    malformed(parsePullResponse, mutated((p) => void ((p.classes[0] as unknown as { color: unknown }).color = null)));
    malformed(parsePullResponse, mutated((p) => void delete (p.classes[0] as Partial<(typeof p.classes)[0]>).color));
    malformed(parsePullResponse, mutated((p) => void ((p.classes[0] as unknown as Record<string, unknown>).createdAt = 1)));
    malformed(parsePullResponse, mutated((p) => void (p.classes[0] = "c1" as never)));
  });

  it.each(["", "   ", 7, null, "x".repeat(101), "😀".repeat(101)])("rejects the id %j", (id) => {
    malformed(parsePullResponse, mutated((p) => void (p.classes[0].id = id as string)));
    malformed(parsePullResponse, mutated((p) => void (p.groups[0].id = id as string)));
    malformed(parsePullResponse, mutated((p) => void (p.groups[0].classId = id as string)));
    malformed(parsePullResponse, mutated((p) => void (p.sessions[0].id = id as string)));
    malformed(parsePullResponse, mutated((p) => void (p.sessions[0].classId = id as string)));
  });

  it("rejects group records with a wrong field", () => {
    malformed(parsePullResponse, mutated((p) => void ((p.groups[0] as unknown as { name: unknown }).name = 1)));
    malformed(parsePullResponse, mutated((p) => void delete (p.groups[0] as Partial<(typeof p.groups)[0]>).classId));
  });

  it.each(["pomodoro", "", "Stopwatch", null, 1, undefined])("rejects the mode %j", (mode) => {
    malformed(parsePullResponse, mutated((p) => void ((p.sessions[0] as unknown as { mode: unknown }).mode = mode)));
  });

  it.each(["", "   ", 5, undefined])("rejects the subgroup reference %j (null is the only 'none')", (groupId) => {
    malformed(parsePullResponse, mutated((p) => void ((p.sessions[0] as unknown as { groupId: unknown }).groupId = groupId)));
  });

  it.each([-1, 1.5, Number.NaN, 253_402_300_800_000, "1700000000000", null])("rejects the start time %j", (startedAt) => {
    malformed(parsePullResponse, mutated((p) => void ((p.sessions[0] as unknown as { startedAt: unknown }).startedAt = startedAt)));
  });

  it.each([0, -3, 1.5, Number.NaN, 31_622_401, "60", null])("rejects the duration %j", (seconds) => {
    malformed(parsePullResponse, mutated((p) => void ((p.sessions[0] as unknown as { seconds: unknown }).seconds = seconds)));
  });

  it("names the field but never echoes the response contents", () => {
    const err = malformed(parsePullResponse, mutated((p) => void ((p.classes[0] as unknown as { name: unknown }).name = 12345)));
    expect(err.detail).toContain("classes[0].name");
    const secret = mutated((p) => void (p.sessions[0].mode = "SECRET-VALUE-XYZ" as never));
    expect(malformed(parsePullResponse, secret).detail).not.toContain("SECRET-VALUE-XYZ");
    expect(malformed(parsePullResponse, secret).message).not.toContain("SECRET-VALUE-XYZ");
  });
});

describe("parsePushResponse", () => {
  it("accepts an applied result", () => {
    expect(parsePushResponse({ status: "applied", revision: 5, changed: 3 })).toEqual({ status: "applied", revision: 5, changed: 3 });
  });

  it("accepts an applied result that changed nothing", () => {
    expect(parsePushResponse({ status: "applied", revision: 5, changed: 0 })).toEqual({ status: "applied", revision: 5, changed: 0 });
  });

  it("returns a stale answer as a normal parsed value, never as an error", () => {
    const r = parsePushResponse({ status: "stale", revision: 9 });
    expect(r).toEqual({ status: "stale", revision: 9 });
    expect(r).not.toBeInstanceOf(Error);
  });

  it.each([null, "applied", [], 5, {}])("rejects the response %j", (input) => {
    malformed(parsePushResponse, input);
  });

  it.each(["ok", "APPLIED", "Stale", "", null, undefined, 1])("rejects the status %j", (status) => {
    malformed(parsePushResponse, { status, revision: 1, changed: 1 });
  });

  it("rejects missing or extra fields for each status", () => {
    malformed(parsePushResponse, { status: "applied", revision: 1 }); // changed missing
    malformed(parsePushResponse, { status: "applied", changed: 1 }); // revision missing
    malformed(parsePushResponse, { status: "applied", revision: 1, changed: 1, extra: true });
    malformed(parsePushResponse, { status: "stale" }); // revision missing
    malformed(parsePushResponse, { status: "stale", revision: 1, changed: 0 }); // stale has no `changed`
  });

  it.each([-1, 1.5, Number.NaN, "2", null, undefined])("rejects the revision %j", (revision) => {
    malformed(parsePushResponse, { status: "applied", revision, changed: 1 });
    malformed(parsePushResponse, { status: "stale", revision });
  });

  it.each([-1, 1.5, 5001, "1", null, undefined])("rejects the changed count %j", (changed) => {
    malformed(parsePushResponse, { status: "applied", revision: 1, changed });
  });
});

describe("parseImportResponse", () => {
  const ok = { status: "imported", import_id: "imp-1", classes: 2, groups: 3, sessions: 4, revision: 1 };

  it("accepts imported and already_imported results", () => {
    expect(parseImportResponse(ok)).toEqual({ status: "imported", importId: "imp-1", classes: 2, groups: 3, sessions: 4, revision: 1 });
    expect(parseImportResponse({ ...ok, status: "already_imported", revision: 7 }).status).toBe("already_imported");
  });

  it.each([null, "imported", [], {}])("rejects the response %j", (input) => {
    malformed(parseImportResponse, input);
  });

  it.each(["done", "IMPORTED", "", null, undefined])("rejects the status %j", (status) => {
    malformed(parseImportResponse, { ...ok, status });
  });

  it("rejects missing and extra fields", () => {
    for (const key of Object.keys(ok)) {
      const copy: Record<string, unknown> = { ...ok };
      delete copy[key];
      malformed(parseImportResponse, copy);
    }
    malformed(parseImportResponse, { ...ok, importId: "imp-1" });
  });

  it.each(["", "   ", 5, null, "x".repeat(101)])("rejects the import id %j", (import_id) => {
    malformed(parseImportResponse, { ...ok, import_id });
  });

  it.each([-1, 1.5, "2", null])("rejects the count %j", (n) => {
    for (const key of ["classes", "groups", "sessions"]) malformed(parseImportResponse, { ...ok, [key]: n });
  });

  it("rejects counts above the server's caps", () => {
    malformed(parseImportResponse, { ...ok, classes: 1001 });
    malformed(parseImportResponse, { ...ok, sessions: 100_001 });
  });

  it.each([0, -1, 1.5, "1", null, undefined])("rejects the revision %j (an import always leaves revision 1 or more)", (revision) => {
    malformed(parseImportResponse, { ...ok, revision });
  });
});
