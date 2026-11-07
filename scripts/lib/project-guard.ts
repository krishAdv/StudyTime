import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

/**
 * The production guard for every script that could talk to Supabase (the Replace cloud verification, M4.3 S9).
 *
 * It only INSPECTS configuration. It never opens a network connection, never runs SQL and never writes anything.
 * It works from an allow-list: a run proceeds only if the project it would talk to is provably the TEST project.
 * Everything else (production, any other project, a custom domain, localhost, a URL it cannot read) is refused.
 *
 * Configuration comes ONLY from the process environment. The scripts are started with scripts/vite.scripts.config.ts (envDir: false)
 * so the tool does not load `.env.local` (it holds production's URL), and the guard also refuses a value identical to the one in
 * `.env.local`. The files are mentioned in the report below purely so the person running the test can see them.
 */

export const PRODUCTION_REF = "qnqsqxytmtonklhjwyrx";
export const TEST_REF = "tjvpwextkocihvoevffo";

export type GuardResult = {
  ok: boolean;
  /** The project reference the configuration points at, when it could be read. */
  ref: string | null;
  /** Why the run is refused (empty when ok). */
  problems: string[];
  /** Things worth knowing, never secrets. */
  notes: string[];
};

type Env = Record<string, string | undefined>;

const REF_PATTERN = /^[a-z0-9]{20}$/;

/**
 * `https://<ref>.supabase.co` and nothing else: no path (a lone trailing slash is the same URL), query string, fragment,
 * port, credentials, custom domain, localhost or http. A bare `?` or `#` is refused too (the URL parser reports both as
 * empty, so the raw text is checked as well).
 */
export function refFromUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.port !== "" || url.username !== "" || url.password !== "") return null;
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "" || raw.includes("?") || raw.includes("#")) return null;
  // The parser hides some deviations (a default port written out, letter case), so the raw text must be the exact form too.
  if (!/^https:\/\/[a-z0-9]+\.supabase\.co\/?$/.test(raw)) return null;
  const m = /^([a-z0-9]+)\.supabase\.co$/.exec(url.hostname);
  return m && REF_PATTERN.test(m[1]) ? m[1] : null;
}

type KeyInfo = { kind: "anon_jwt" | "publishable" | "service_role" | "secret" | "unknown"; ref: string | null };

/** What kind of key this is, from its shape only (a JWT's payload is decoded, never verified or printed). */
export function describeKey(key: string | undefined): KeyInfo {
  if (!key) return { kind: "unknown", ref: null };
  if (key.startsWith("sb_publishable_")) return { kind: "publishable", ref: null };
  if (key.startsWith("sb_secret_")) return { kind: "secret", ref: null };
  const parts = key.split(".");
  if (parts.length === 3) {
    try {
      const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as { role?: unknown; ref?: unknown };
      const ref = typeof payload.ref === "string" ? payload.ref : null;
      if (payload.role === "service_role") return { kind: "service_role", ref };
      if (payload.role === "anon") return { kind: "anon_jwt", ref };
    } catch {
      // falls through to unknown
    }
  }
  return { kind: "unknown", ref: null };
}

/** The project a Postgres connection string points at: `db.<ref>.supabase.co`, or a pooler user `postgres.<ref>`. */
export function refFromDatabaseUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "postgresql:" && url.protocol !== "postgres:") return null;
  const direct = /^db\.([a-z0-9]+)\.supabase\.co$/.exec(url.hostname);
  if (direct && REF_PATTERN.test(direct[1])) return direct[1];
  const pooler = /^[a-z0-9-]+\.pooler\.supabase\.com$/.test(url.hostname) ? /^postgres\.([a-z0-9]+)$/.exec(decodeURIComponent(url.username)) : null;
  return pooler && REF_PATTERN.test(pooler[1]) ? pooler[1] : null;
}

function judgeRef(ref: string | null, what: string, problems: string[]) {
  if (ref === null) problems.push(`${what} does not clearly point at a Supabase project (expected https://<ref>.supabase.co), so it can't be proven to be the test project.`);
  else if (ref === PRODUCTION_REF) problems.push(`${what} points at the PRODUCTION project (${PRODUCTION_REF}). This must never be used for testing.`);
  else if (ref !== TEST_REF) problems.push(`${what} points at project ${ref}, which is not the expected test project (${TEST_REF}).`);
}

/** One value from `.env.local`, read only to COMPARE against the environment (never printed, never used as configuration). */
function envLocalValue(cwd: string, name: string): string | null {
  try {
    const file = path.join(cwd, ".env.local");
    if (!existsSync(file)) return null;
    const line = readFileSync(file, "utf8").split(/\r?\n/).find((l) => l.startsWith(`${name}=`));
    const value = line?.slice(name.length + 1).trim().replace(/^["']|["']$/g, "");
    return value ? value : null;
  } catch {
    return null;
  }
}

/** Informational: where the repository's own files point. Reads only the project reference, never a key. */
function repositoryNotes(cwd: string): string[] {
  const notes: string[] = [];
  try {
    const linked = path.join(cwd, "supabase", ".temp", "project-ref");
    if (existsSync(linked)) {
      const ref = readFileSync(linked, "utf8").trim();
      notes.push(`supabase/.temp/project-ref links this repository to ${ref}${ref === PRODUCTION_REF ? " (PRODUCTION: never run db push or reset against it)" : ""}.`);
    }
    const envLocal = path.join(cwd, ".env.local");
    if (existsSync(envLocal)) {
      const line = readFileSync(envLocal, "utf8").split(/\r?\n/).find((l) => l.startsWith("NEXT_PUBLIC_SUPABASE_URL="));
      const ref = refFromUrl(line?.slice("NEXT_PUBLIC_SUPABASE_URL=".length).trim().replace(/^["']|["']$/g, ""));
      notes.push(`.env.local points at ${ref ?? "an unreadable URL"}${ref === PRODUCTION_REF ? " (PRODUCTION). It is NOT used by these scripts. Real environment variables override it for the dev server." : "."}`);
    }
  } catch {
    // purely informational
  }
  return notes;
}

/**
 * Checks the app-style configuration (`NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY`) that Stage B uses.
 * `requireConfirm` also demands `STAGE_CONFIRM_PROJECT` to equal the test ref, typed by the person running it.
 */
export function checkApp(env: Env, options: { requireConfirm?: boolean; cwd?: string } = {}): GuardResult {
  const problems: string[] = [];
  const notes: string[] = [];
  const url = env.NEXT_PUBLIC_SUPABASE_URL;
  const key = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  const ref = refFromUrl(url);

  if (!url) problems.push("NEXT_PUBLIC_SUPABASE_URL is not set in the environment. These scripts do not read .env.local.");
  else judgeRef(ref, "NEXT_PUBLIC_SUPABASE_URL", problems);

  // Belt and braces: production's reference appearing anywhere in the relevant settings is refused outright.
  for (const name of ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY", "DATABASE_URL"]) {
    if ((env[name] ?? "").includes(PRODUCTION_REF)) problems.push(`${name} contains the production project reference.`);
  }

  const info = describeKey(key);
  if (!key) problems.push("NEXT_PUBLIC_SUPABASE_ANON_KEY is not set in the environment.");
  else if (info.kind === "service_role" || info.kind === "secret") problems.push("The key is a service-role or secret key. Only the public anon or publishable key may be used.");
  else if (info.kind === "unknown") problems.push("The key is not recognisable as an anon JWT or a publishable key.");
  else if (info.kind === "anon_jwt") {
    if (info.ref === null) notes.push("The anon key carries no project reference, so it could not be matched to the URL.");
    else if (info.ref !== ref) problems.push(`The anon key belongs to project ${info.ref}, but the URL points at ${ref ?? "an unreadable project"}. The two must match.`);
  } else notes.push("The key is a publishable key (it carries no project reference to compare, so the URL is the only proof).");

  // Defense in depth: a tool that loads .env.local by itself would hand these scripts production's values. The URL case is
  // already caught above (it names production); a key that is identical to .env.local's is refused too.
  const cwd = options.cwd ?? process.cwd();
  for (const name of ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY"]) {
    const fromFile = envLocalValue(cwd, name);
    if (fromFile !== null && env[name] === fromFile) problems.push(`${name} is identical to the value in .env.local (production's). Set it explicitly to the test project's value.`);
  }

  if (env.SUPABASE_SERVICE_ROLE_KEY) problems.push("SUPABASE_SERVICE_ROLE_KEY is set in the environment. Remove it; it must never be near these scripts.");

  if (options.requireConfirm && env.STAGE_CONFIRM_PROJECT !== TEST_REF) {
    problems.push(`STAGE_CONFIRM_PROJECT must be set to ${TEST_REF} (type it yourself) to allow a run that writes data.`);
  }

  notes.push(...repositoryNotes(cwd));
  return { ok: problems.length === 0, ref, problems, notes };
}

/** Checks `DATABASE_URL` for Stage A (psql). Never prints the password. */
export function checkDatabase(env: Env, options: { cwd?: string } = {}): GuardResult {
  const problems: string[] = [];
  const url = env.DATABASE_URL;
  const ref = refFromDatabaseUrl(url);
  if (!url) problems.push("DATABASE_URL is not set in the environment.");
  else judgeRef(ref, "DATABASE_URL", problems);
  if ((url ?? "").includes(PRODUCTION_REF)) problems.push("DATABASE_URL contains the production project reference.");
  return { ok: problems.length === 0, ref, problems, notes: repositoryNotes(options.cwd ?? process.cwd()) };
}

export function formatGuard(title: string, r: GuardResult): string {
  const lines = [`${title}`, `  project reference read from the configuration: ${r.ref ?? "(could not be determined)"}`];
  if (r.ref === TEST_REF) lines.push("  that is the expected TEST project");
  for (const n of r.notes) lines.push(`  note: ${n}`);
  if (r.ok) lines.push("  RESULT: OK. The configuration points at the test project.");
  else {
    for (const p of r.problems) lines.push(`  REFUSED: ${p}`);
    lines.push("  RESULT: REFUSED. Nothing was contacted.");
  }
  return lines.join("\n");
}
