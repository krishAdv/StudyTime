import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import {
  SYNC_RPC_NAMES, createSupabaseSyncApi, type SyncRpcClient, type SyncRpcResponse,
} from "@/lib/sync/api";
import { toImportPayload, type SyncChange } from "@/lib/sync/changes";
import { SyncError, SyncResponseError } from "@/lib/sync/errors";
import { createFakeSyncServer } from "./helpers/fake-sync-server";

// Compile-time proof that a real Supabase client can be passed as is: no wider interface is needed.
const realClientIsAccepted = (client: SupabaseClient): SyncRpcClient => client;

const pullData = () => ({
  revision: 2,
  classes: [{ id: "c1", name: "Math", color: "#3b82f6" }],
  groups: [],
  sessions: [],
});

type Reply = SyncRpcResponse | Error;
/** A client that answers from a script and records every call. It has no `from` and no `auth`. */
function stub(...replies: Reply[]) {
  const rpc = vi.fn<(fn: string, args?: Record<string, unknown>) => Promise<SyncRpcResponse>>(async () => {
    if (replies.length === 0) throw new Error("unexpected extra call");
    const next = replies.shift();
    if (next instanceof Error) throw next;
    return next as SyncRpcResponse; // may be undefined on purpose: a client that returns nothing
  });
  const client = new Proxy({ rpc } as unknown as SyncRpcClient, {
    get(target, prop) {
      if (prop === "rpc") return rpc;
      throw new Error(`the sync adapter touched client.${String(prop)}`);
    },
  });
  return { client, rpc };
}
const ok = (data: unknown): SyncRpcResponse => ({ data, error: null, status: 200 });
const err = (code: string, message: string, status = 400): SyncRpcResponse => ({ data: null, error: { code, message }, status });

async function rejection(p: Promise<unknown>): Promise<SyncError> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(SyncError);
    return e as SyncError;
  }
  throw new Error("expected the call to reject");
}

const oneChange: SyncChange[] = [{ op: "add_class", id: "c1", name: "Math", color: "#3b82f6" }];

describe("types", () => {
  it("accepts a real SupabaseClient where an RPC client is needed (checked by the compiler)", () => {
    expect(typeof realClientIsAccepted).toBe("function");
  });
});

describe("which calls the adapter makes", () => {
  it("uses only the three approved RPCs, with the documented argument names, and nothing else on the client", async () => {
    const { client, rpc } = stub(
      ok(pullData()),
      ok({ status: "applied", revision: 3, changed: 1 }),
      ok({ status: "imported", import_id: "imp", classes: 0, groups: 0, sessions: 0, revision: 1 }),
    );
    const api = createSupabaseSyncApi(client);
    await api.pullSnapshot();
    await api.pushChanges(2, oneChange);
    const payload = toImportPayload({ classes: [], sessions: [] }, new Date(0));
    await api.importAndInitSync("imp", payload);

    expect(rpc.mock.calls.map((c) => c[0])).toEqual(["pull_snapshot", "push_changes", "import_and_init_sync"]);
    expect(rpc.mock.calls.every((c) => (SYNC_RPC_NAMES as readonly string[]).includes(c[0]))).toBe(true);
    expect(rpc.mock.calls[0][1]).toBeUndefined();
    expect(rpc.mock.calls[1][1]).toEqual({ p_base_revision: 2, p_changes: oneChange });
    expect(rpc.mock.calls[2][1]).toEqual({ p_import_id: "imp", p_payload: payload });
  });
});

describe("pullSnapshot", () => {
  it("returns the validated revision and snapshot", async () => {
    const r = await createSupabaseSyncApi(stub(ok(pullData())).client).pullSnapshot();
    expect(r).toEqual({ revision: 2, snapshot: { classes: pullData().classes, groups: [], sessions: [] } });
  });

  it("rejects a malformed response with a typed response error", async () => {
    for (const data of [null, "x", { revision: 1 }, { ...pullData(), extra: 1 }, { ...pullData(), revision: -1 }]) {
      const e = await rejection(createSupabaseSyncApi(stub(ok(data)).client).pullSnapshot());
      expect(e).toBeInstanceOf(SyncResponseError);
      expect(e.kind).toBe("malformed_response");
    }
  });

  it("rejects when the call returns nothing at all", async () => {
    const e = await rejection(createSupabaseSyncApi(stub(undefined as unknown as SyncRpcResponse).client).pullSnapshot());
    expect(e.kind).toBe("malformed_response");
  });

  it("turns a returned error into a classified SyncError, keeping its code and status", async () => {
    const e = await rejection(createSupabaseSyncApi(stub(err("28000", "Not signed in.", 403)).client).pullSnapshot());
    expect(e.kind).toBe("auth");
    expect(e.code).toBe("28000");
    expect(e.status).toBe(403);
  });

  it("turns a thrown exception into a network error", async () => {
    const e = await rejection(createSupabaseSyncApi(stub(new TypeError("fetch failed")).client).pullSnapshot());
    expect(e.kind).toBe("network");
    expect(e.retryable).toBe(true);
  });

  it("does not echo credentials from an error message", async () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ4In0.sig_123";
    const e = await rejection(createSupabaseSyncApi(stub(err("XX000", `bad token ${jwt}`, 500)).client).pullSnapshot());
    expect(`${e.message} ${e.detail}`).not.toContain(jwt);
  });
});

describe("pushChanges", () => {
  it("returns an applied result", async () => {
    const r = await createSupabaseSyncApi(stub(ok({ status: "applied", revision: 5, changed: 1 })).client).pushChanges(4, oneChange);
    expect(r).toEqual({ status: "applied", revision: 5, changed: 1 });
  });

  it("returns a stale answer as a value: nothing is thrown", async () => {
    const r = await createSupabaseSyncApi(stub(ok({ status: "stale", revision: 9 })).client).pushChanges(4, oneChange);
    expect(r).toEqual({ status: "stale", revision: 9 });
  });

  it("accepts an applied push that changed nothing at the same revision", async () => {
    const r = await createSupabaseSyncApi(stub(ok({ status: "applied", revision: 4, changed: 0 })).client).pushChanges(4, []);
    expect(r).toEqual({ status: "applied", revision: 4, changed: 0 });
  });

  it("rejects an applied answer whose revision does not follow from the base", async () => {
    for (const reply of [
      { status: "applied", revision: 4, changed: 2 }, // changed rows but the revision did not move
      { status: "applied", revision: 6, changed: 2 }, // moved by more than 1
      { status: "applied", revision: 5, changed: 0 }, // changed nothing but the revision moved
    ]) {
      const e = await rejection(createSupabaseSyncApi(stub(ok(reply)).client).pushChanges(4, oneChange));
      expect(e).toBeInstanceOf(SyncResponseError);
    }
  });

  it("rejects a stale answer that reports the base revision itself", async () => {
    const e = await rejection(createSupabaseSyncApi(stub(ok({ status: "stale", revision: 4 })).client).pushChanges(4, oneChange));
    expect(e.kind).toBe("malformed_response");
  });

  it("rejects a malformed response", async () => {
    for (const data of [null, {}, { status: "applied", revision: 5 }, { status: "done", revision: 5 }, { status: "stale", revision: 5, changed: 1 }]) {
      const e = await rejection(createSupabaseSyncApi(stub(ok(data)).client).pushChanges(4, oneChange));
      expect(e.kind).toBe("malformed_response");
    }
  });

  it.each([
    ["ST003", "conflict"],
    ["ST004", "refused"],
    ["22023", "invalid_request"],
    ["28000", "auth"],
    ["PGRST202", "unavailable"],
  ])("classifies the server error %s as %s", async (code, kind) => {
    const e = await rejection(createSupabaseSyncApi(stub(err(code, "x")).client).pushChanges(4, oneChange));
    expect(e.kind).toBe(kind);
    expect(e.code).toBe(code);
  });

  it("sends nothing for a request the server would reject anyway", async () => {
    const huge = Array.from({ length: 5001 }, (_, i) => ({ op: "delete_group", id: `g${i}` }) as SyncChange);
    const big: SyncChange[] = [{ op: "add_class", id: "c", name: "x".repeat(4_000_001), color: "#000000" }];
    for (const [base, changes] of [
      [-1, oneChange], [1.5, oneChange], [Number.NaN, oneChange], [Number.MAX_SAFE_INTEGER + 1, oneChange],
      [0, "nope" as unknown as SyncChange[]], [0, huge], [0, big],
    ] as [number, SyncChange[]][]) {
      const { client, rpc } = stub();
      const e = await rejection(createSupabaseSyncApi(client).pushChanges(base, changes));
      expect(e.kind).toBe("invalid_request");
      expect(rpc).not.toHaveBeenCalled();
    }
  });

  it("allows exactly 5,000 changes", async () => {
    const max = Array.from({ length: 5000 }, (_, i) => ({ op: "delete_group", id: `g${i}` }) as SyncChange);
    const { client, rpc } = stub(ok({ status: "stale", revision: 9 }));
    await createSupabaseSyncApi(client).pushChanges(0, max);
    expect(rpc).toHaveBeenCalledTimes(1);
  });
});

describe("importAndInitSync", () => {
  const payload = toImportPayload({ classes: [], sessions: [] }, new Date(0));
  const imported = { status: "imported", import_id: "imp-1", classes: 0, groups: 0, sessions: 0, revision: 1 };

  it("returns the validated result with a camelCase import id", async () => {
    const r = await createSupabaseSyncApi(stub(ok(imported)).client).importAndInitSync("imp-1", payload);
    expect(r).toEqual({ status: "imported", importId: "imp-1", classes: 0, groups: 0, sessions: 0, revision: 1 });
  });

  it("accepts an already_imported replay", async () => {
    const r = await createSupabaseSyncApi(stub(ok({ ...imported, status: "already_imported", revision: 4 })).client).importAndInitSync("imp-1", payload);
    expect(r.status).toBe("already_imported");
    expect(r.revision).toBe(4);
  });

  it("rejects an answer that belongs to a different import id", async () => {
    const e = await rejection(createSupabaseSyncApi(stub(ok({ ...imported, import_id: "other" })).client).importAndInitSync("imp-1", payload));
    expect(e.kind).toBe("malformed_response");
  });

  it("rejects a malformed response", async () => {
    for (const data of [null, {}, { ...imported, revision: 0 }, { ...imported, status: "x" }, { ...imported, extra: 1 }]) {
      const e = await rejection(createSupabaseSyncApi(stub(ok(data)).client).importAndInitSync("imp-1", payload));
      expect(e.kind).toBe("malformed_response");
    }
  });

  it.each([
    ["ST001", "import_mismatch"],
    ["ST002", "account_not_empty"],
    ["22023", "invalid_request"],
    ["28000", "auth"],
  ])("classifies the server error %s as %s", async (code, kind) => {
    const e = await rejection(createSupabaseSyncApi(stub(err(code, "x")).client).importAndInitSync("imp-1", payload));
    expect(e.kind).toBe(kind);
  });

  it("sends nothing for an unusable import id or payload", async () => {
    for (const [id, body] of [
      ["", payload], ["   ", payload], ["x".repeat(101), payload], [5 as unknown as string, payload],
      ["imp", null as never], ["imp", [] as never], ["imp", "text" as never],
    ] as [string, never][]) {
      const { client, rpc } = stub();
      const e = await rejection(createSupabaseSyncApi(client).importAndInitSync(id, body));
      expect(e.kind).toBe("invalid_request");
      expect(rpc).not.toHaveBeenCalled();
    }
  });
});

describe("against the in-memory server", () => {
  it("a client alone proves nothing: a caller with no session is rejected as an auth failure on every call", async () => {
    const server = createFakeSyncServer();
    const api = server.apiFor(null);
    expect((await rejection(api.pullSnapshot())).kind).toBe("auth");
    expect((await rejection(api.pushChanges(0, oneChange))).kind).toBe("auth");
    expect((await rejection(api.importAndInitSync("imp", toImportPayload({ classes: [], sessions: [] })))).kind).toBe("auth");
  });

  it("an expired session is an auth failure", async () => {
    const server = createFakeSyncServer();
    server.setSessionExpired("u", true);
    const e = await rejection(server.apiFor("u").pullSnapshot());
    expect(e.kind).toBe("auth");
    expect(e.code).toBe("PGRST301");
    server.setSessionExpired("u", false);
    await expect(server.apiFor("u").pullSnapshot()).resolves.toMatchObject({ revision: 0 });
  });

  it("a connection failure is a retryable network error", async () => {
    const server = createFakeSyncServer();
    server.setMode("network_down");
    const e = await rejection(server.apiFor("u").pullSnapshot());
    expect(e.kind).toBe("network");
    expect(e.status).toBe(0);
    expect(e.retryable).toBe(true);
  });

  it("a server outage is a retryable server error", async () => {
    const server = createFakeSyncServer();
    server.setMode("server_error");
    const e = await rejection(server.apiFor("u").pushChanges(0, oneChange));
    expect(e.kind).toBe("server");
    expect(e.retryable).toBe(true);
  });

  it("a server without the migration reports the RPCs as unavailable", async () => {
    const server = createFakeSyncServer();
    server.setMode("unavailable");
    const api = server.apiFor("u");
    for (const p of [api.pullSnapshot(), api.pushChanges(0, oneChange), api.importAndInitSync("imp", toImportPayload({ classes: [], sessions: [] }))]) {
      const e = await rejection(p);
      expect(e.kind).toBe("unavailable");
      expect(e.code).toBe("PGRST202");
    }
  });

  it("a full round: pull, push, stale push, pull again", async () => {
    const server = createFakeSyncServer();
    const api = server.apiFor("u");
    expect((await api.pullSnapshot()).revision).toBe(0);
    expect(await api.pushChanges(0, oneChange)).toEqual({ status: "applied", revision: 1, changed: 1 });
    expect(await api.pushChanges(0, [{ op: "add_class", id: "c2", name: "Art", color: "#000000" }])).toEqual({ status: "stale", revision: 1 });
    const after = await api.pullSnapshot();
    expect(after.revision).toBe(1);
    expect(after.snapshot.classes.map((c) => c.id)).toEqual(["c1"]);
  });

  it("only ever calls the three approved RPCs", async () => {
    const server = createFakeSyncServer();
    const api = server.apiFor("u");
    await api.pullSnapshot();
    await api.pushChanges(0, oneChange);
    await api.importAndInitSync("imp", toImportPayload({ classes: [], sessions: [] })).catch(() => undefined);
    expect(new Set(server.calls.map((c) => c.fn))).toEqual(new Set(SYNC_RPC_NAMES));
  });
});
