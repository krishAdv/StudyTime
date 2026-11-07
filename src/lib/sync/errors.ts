/**
 * What can go wrong when talking to the sync RPCs, as a small set of kinds a caller can act on.
 *
 * A stale revision is NOT here: `push_changes` answers a stale base with a normal successful
 * result (`{status: "stale", revision}`), which the response parser returns as a value. It never
 * becomes a `SyncError`.
 *
 * Original error information is kept (`code`, `status`, a redacted `detail`) but never credentials:
 * tokens, API keys, bearer headers, passwords and e-mail addresses are removed from `detail`, and the
 * request that was sent (which may hold study data) is never copied into an error.
 */
export type SyncErrorKind =
  /** No connection, a timeout, or an aborted request. Retry later. */
  | "network"
  /** The server answered with 5xx or 429 (busy or failing). Retry later. */
  | "server"
  /** Not signed in, or the session is invalid or expired (28000, 401, JWT errors). Sign in again. */
  | "auth"
  /** Signed in but not allowed (permission denied for this account). */
  | "forbidden"
  /** ST003: an id or name clashes with data already in the account. */
  | "conflict"
  /** ST004: `delete_class` found a different number of sessions than expected. */
  | "refused"
  /** ST002: the account already has study data, so it can't be imported into. */
  | "account_not_empty"
  /** ST001: this import id was already used with different data. */
  | "import_mismatch"
  /** 22023, other data or constraint failures, or a request the server couldn't parse. */
  | "invalid_request"
  /** The RPC doesn't exist on this server (PGRST202 / 404): the migration isn't applied there. */
  | "unavailable"
  /** The server answered, but not in the shape the contract promises. */
  | "malformed_response"
  | "unknown";

const MESSAGES: Record<SyncErrorKind, string> = {
  network: "Couldn’t reach the server. Check your connection.",
  server: "The server is busy or having trouble. Try again shortly.",
  auth: "Your session has ended or isn’t valid. Sign in again.",
  forbidden: "This account isn’t allowed to do that.",
  conflict: "A name or id clashes with data already in your account.",
  refused: "The server refused the change to protect data it holds.",
  account_not_empty: "This account already has study data.",
  import_mismatch: "That import was already used with different data.",
  invalid_request: "The server rejected the data as invalid.",
  unavailable: "Sync isn’t available on this server yet.",
  malformed_response: "The server sent a response StudyTime couldn’t understand.",
  unknown: "Something went wrong while syncing.",
};

const RETRYABLE: ReadonlySet<SyncErrorKind> = new Set<SyncErrorKind>(["network", "server"]);

/** Removes anything credential-like and limits the length. */
export function redactSensitive(text: string): string {
  return text
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g, "[token]")
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, "Bearer [token]")
    .replace(/sb_(?:publishable|secret)_[A-Za-z0-9_-]+/g, "[key]")
    .replace(/(apikey|api_key|password|passwd|secret|token)(["']?\s*[:=]\s*["']?)[^\s"',;]+/gi, "$1$2[redacted]")
    .replace(/[^\s@"'<>]+@[^\s@"'<>]+\.[A-Za-z]{2,}/g, "[email]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

export class SyncError extends Error {
  readonly kind: SyncErrorKind;
  /** The SQLSTATE or PostgREST code the server reported, if any (for example "ST003" or "PGRST202"). */
  readonly code: string | null;
  /** The HTTP status, if known (0 means the request never got an answer). */
  readonly status: number | null;
  /** The original message with credentials removed. For logs and support, not for display. */
  readonly detail: string | null;

  constructor(kind: SyncErrorKind, info: { code?: string | null; status?: number | null; detail?: string | null } = {}) {
    super(MESSAGES[kind]);
    this.name = "SyncError";
    this.kind = kind;
    this.code = info.code ?? null;
    this.status = info.status ?? null;
    this.detail = info.detail ? redactSensitive(info.detail) : null;
  }

  /** True for failures that may succeed if tried again later without any change. */
  get retryable(): boolean {
    return RETRYABLE.has(this.kind);
  }
}

/** The response arrived but broke the contract (wrong shape, type, enum value or revision). */
export class SyncResponseError extends SyncError {
  constructor(detail: string) {
    super("malformed_response", { detail });
    this.name = "SyncResponseError";
  }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;

const NETWORK_TEXT = /fetch failed|failed to fetch|networkerror|network request failed|load failed|timed out|timeout|aborted|econn|enotfound|eai_again|socket hang up|offline/i;
const JWT_TEXT = /jwt (expired|invalid|malformed)|invalid jwt|invalid claim|token (has )?expired|not authenticated|no api key/i;

/**
 * Turns whatever a failed call produced into a `SyncError`:
 *  - a PostgREST/Postgres error object (`{code, message, details, hint}`), with the HTTP `status` if known
 *  - a thrown exception (network failure, timeout, abort)
 *  - anything else (unknown)
 * Server-defined codes win over the HTTP status, because the status only says how PostgREST mapped them.
 * A `SyncError` passed in comes back unchanged.
 */
export function classifySyncError(input: unknown, status?: number | null): SyncError {
  if (input instanceof SyncError) return input;

  const o = isObj(input) ? input : {};
  const code = typeof o.code === "string" && o.code !== "" ? o.code : null;
  const message = typeof o.message === "string" ? o.message : input instanceof Error ? input.message : "";
  const name = typeof o.name === "string" ? o.name : "";
  const http = status ?? (typeof o.status === "number" ? o.status : null);
  const detail = message || (typeof o.details === "string" ? o.details : "") || null;
  const info = { code, status: http, detail };
  const make = (kind: SyncErrorKind) => new SyncError(kind, info);

  // Codes our own RPCs raise (see the M4.2 and import migrations).
  switch (code) {
    case "ST001": return make("import_mismatch");
    case "ST002": return make("account_not_empty");
    case "ST003": return make("conflict");
    case "ST004": return make("refused");
    case "28000": return make("auth");
    case "PGRST202": return make("unavailable");
    case "PGRST301": case "PGRST302": case "PGRST303": return make("auth");
    case "42501": return make(http === 401 ? "auth" : "forbidden");
  }
  if (code !== null && (code.startsWith("22") || code.startsWith("23"))) return make("invalid_request");
  if (code !== null && /^PGRST1\d\d$/.test(code)) return make("invalid_request");

  if (JWT_TEXT.test(message)) return make("auth");
  if (http === 401) return make("auth");
  if (http === 403) return make("forbidden");
  if (http === 404) return make("unavailable");
  if (http === 429 || (http !== null && http >= 500)) return make("server");
  if (http === 0) return make("network");
  if (name === "AbortError" || name === "TimeoutError" || NETWORK_TEXT.test(message)) return make("network");
  if (http === 400) return make("invalid_request");
  return make("unknown");
}
