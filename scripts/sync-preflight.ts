/**
 * Read-only pre-flight for the Replace cloud verification. Run it FIRST, in the same terminal you will run the
 * stage in. It makes no network connection, runs no SQL and writes nothing.
 *
 *   npx vite-node -c scripts/vite.scripts.config.ts scripts/sync-preflight.ts        app settings (Stage B) and DATABASE_URL (Stage A) if set
 *   npx vite-node -c scripts/vite.scripts.config.ts scripts/sync-preflight.ts app    app settings only
 *   npx vite-node -c scripts/vite.scripts.config.ts scripts/sync-preflight.ts db     DATABASE_URL only
 *
 * Exit code 0 means every checked setting provably points at the TEST project. Anything else exits 1.
 */
import { checkApp, checkDatabase, formatGuard, TEST_REF, PRODUCTION_REF } from "./lib/project-guard";

const mode = process.argv[2] ?? "auto";
const results: { title: string; ok: boolean }[] = [];

console.log(`Expected test project: ${TEST_REF}`);
console.log(`Production (never to be used): ${PRODUCTION_REF}\n`);

if (mode === "app" || mode === "auto") {
  const r = checkApp(process.env);
  console.log(formatGuard("App settings (NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_ANON_KEY), used by Stage B", r));
  console.log("  (Stage B additionally requires STAGE_CONFIRM_PROJECT to be typed by you.)\n");
  results.push({ title: "app", ok: r.ok });
}
if (mode === "db" || (mode === "auto" && process.env.DATABASE_URL)) {
  const r = checkDatabase(process.env);
  console.log(formatGuard("Database connection (DATABASE_URL), used by Stage A with psql", r) + "\n");
  results.push({ title: "db", ok: r.ok });
}
if (mode === "auto" && !process.env.DATABASE_URL) console.log("DATABASE_URL is not set, so Stage A was not checked (run with `db` once it is).\n");
if (!["auto", "app", "db"].includes(mode)) {
  console.log(`Unknown mode "${mode}". Use app, db, or nothing.`);
  process.exit(1);
}

const failed = results.filter((r) => !r.ok);
console.log(failed.length === 0 && results.length > 0 ? "PRE-FLIGHT PASSED" : "PRE-FLIGHT FAILED: do not run any stage.");
process.exit(failed.length === 0 && results.length > 0 ? 0 : 1);
