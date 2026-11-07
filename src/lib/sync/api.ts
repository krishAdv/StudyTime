import { IMPORT_LIMITS, PUSH_LIMITS, type ImportPayload, type SyncChange } from "./changes";
import { SyncError, SyncResponseError, classifySyncError } from "./errors";
import {
  parseImportResponse, parsePullResponse, parsePushResponse, type ImportResult, type PushResult,
} from "./responses";
import type { RevisionedSnapshot } from "./snapshot";
import { codePointLength } from "./text";

/**
 * The three M4.2 RPCs as an injectable interface. Tests (and the sync engine's tests) use a fake;
 * the app uses `createSupabaseSyncApi`.
 *
 * Contract for every method: it resolves with a validated, typed result, or rejects with a
 * `SyncError`. A stale revision is a normal result (`{status: "stale"}`), not a rejection.
 */
export interface SyncApi {
  /** The caller's whole data with the revision it was read at, in one consistent snapshot. */
  pullSnapshot(): Promise<RevisionedSnapshot>;
  /** Applies `changes` atomically if `baseRevision` is still the current revision; otherwise returns `stale` and changes nothing. */
  pushChanges(baseRevision: number, changes: SyncChange[]): Promise<PushResult>;
  /** Imports a whole export file into an empty account and starts sync, safely repeatable with the same id and payload. */
  importAndInitSync(importId: string, payload: ImportPayload): Promise<ImportResult>;
}

/** The only functions this module ever calls. There are deliberately no table reads or writes. */
export const SYNC_RPC_NAMES = ["pull_snapshot", "push_changes", "import_and_init_sync"] as const;
export type SyncRpcName = (typeof SYNC_RPC_NAMES)[number];

/** What a failed Supabase call reports (structurally a PostgrestError). */
export type SyncRpcError = { message?: string; code?: string; details?: string; hint?: string; name?: string };

export type SyncRpcResponse = { data: unknown; error: SyncRpcError | null; status?: number };

/**
 * The one slice of the Supabase client this module needs. It is intentionally tiny: `rpc` only, no
 * `from`, no `auth`. A real `SupabaseClient` satisfies it as is (checked by a type-level test), so
 * nothing else in the app has to be widened. Having a client says nothing about being signed in:
 * the user's JWT travels with the client's requests, and the server answers 28000 / 401 when there is none.
 */
export interface SyncRpcClient {
  rpc(fn: SyncRpcName, args?: Record<string, unknown>): PromiseLike<SyncRpcResponse>;
}

const MAX_ID_LENGTH = 100;

const invalidLocally = (detail: string) => new SyncError("invalid_request", { detail: `not sent: ${detail}` });

/** Runs one RPC and returns its raw `data`, turning every failure into a `SyncError`. */
async function call(client: SyncRpcClient, fn: SyncRpcName, args?: Record<string, unknown>): Promise<unknown> {
  let res: SyncRpcResponse;
  try {
    res = await client.rpc(fn, args);
  } catch (e) {
    throw classifySyncError(e);
  }
  if (typeof res !== "object" || res === null) throw new SyncResponseError(`${fn}: the call returned nothing`);
  if (res.error) throw classifySyncError(res.error, res.status);
  return res.data;
}

export function createSupabaseSyncApi(client: SyncRpcClient): SyncApi {
  return {
    async pullSnapshot() {
      return parsePullResponse(await call(client, "pull_snapshot"));
    },

    async pushChanges(baseRevision, changes) {
      // Checked before anything is sent: these requests would be rejected anyway.
      if (!Number.isSafeInteger(baseRevision) || baseRevision < 0) throw invalidLocally("the base revision is not a whole number of 0 or more");
      if (!Array.isArray(changes)) throw invalidLocally("changes is not a list");
      if (changes.length > PUSH_LIMITS.maxChanges) throw invalidLocally(`more than ${PUSH_LIMITS.maxChanges} changes in one push`);
      if (JSON.stringify(changes).length > PUSH_LIMITS.maxBytes) throw invalidLocally("the changes are larger than one push allows");

      const result = parsePushResponse(await call(client, "push_changes", { p_base_revision: baseRevision, p_changes: changes }));
      // The revision rules are part of the contract: a push that changed rows moves the revision by exactly 1,
      // one that changed nothing leaves it, and a stale answer reports a revision different from the base.
      if (result.status === "applied") {
        const expected = result.changed === 0 ? baseRevision : baseRevision + 1;
        if (result.revision !== expected) {
          throw new SyncResponseError("push_changes: the revision does not follow from the base revision");
        }
      } else if (result.revision === baseRevision) {
        throw new SyncResponseError("push_changes: a stale answer reported the base revision itself");
      }
      return result;
    },

    async importAndInitSync(importId, payload) {
      if (typeof importId !== "string" || importId.trim() === "" || codePointLength(importId) > MAX_ID_LENGTH) {
        throw invalidLocally("the import id must be 1 to 100 characters");
      }
      if (typeof payload !== "object" || payload === null || Array.isArray(payload)) throw invalidLocally("the payload is not an object");
      if (JSON.stringify(payload).length > IMPORT_LIMITS.maxBytes) throw invalidLocally("the payload is larger than an import allows");

      const result = parseImportResponse(await call(client, "import_and_init_sync", { p_import_id: importId, p_payload: payload }));
      if (result.importId !== importId) throw new SyncResponseError("import_and_init_sync: the answer is for a different import id");
      return result;
    },
  };
}
