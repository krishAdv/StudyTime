/**
 * Stage B: Replace cloud against the REAL test project, through the app's own adapter and planner.
 * Passed against the TEST project (owner-reported: 15 passed, 0 failed, 4 informational, account left empty).
 *
 *   npx vite-node -c scripts/vite.scripts.config.ts scripts/stage-b/replace-cloud-check.ts --offline   no network, no credentials:
 *                                                                    proves the script loads and the planner works (safe anywhere)
 *   npx vite-node -c scripts/vite.scripts.config.ts scripts/stage-b/replace-cloud-check.ts             the real run (see docs/REPLACE-CLOUD-TEST-PLAN.md)
 *   npx vite-node -c scripts/vite.scripts.config.ts scripts/stage-b/replace-cloud-check.ts --cleanup   only empty the throwaway account
 *
 * Safety, in order (the run stops at the first one that fails, before any request is made):
 *  1. The production guard (scripts/lib/project-guard.ts): the URL must be the TEST project, the key a public anon or
 *     publishable key that matches it, no service-role key anywhere, and STAGE_CONFIRM_PROJECT typed by you.
 *  2. It signs in as ONE dedicated throwaway test account (STAGE_B_EMAIL / STAGE_B_PASSWORD).
 *  3. That account must be EMPTY (no classes, no subgroups, no sessions). Otherwise it refuses and writes nothing.
 *  4. It only calls the three sync RPCs through createSupabaseSyncApi (no table access, no SQL, no admin API).
 *  5. It always ends by emptying the account again and checking that it is empty. Cleanup uses raw delete_class operations
 *     (scripts/stage-b/cleanup.ts), not the app's planner, because B9 stores data the app's validator refuses.
 *  6. `--cleanup` (same guard, same sign-in) only empties the account after an interrupted run, and refuses an account that
 *     holds any class this script does not create. That check is made twice: on the first read, and again on the fresh
 *     snapshot the delete itself is built from (nothing is sent if either finds an unexpected class).
 * Nothing is read from .env.local (see the guard). Nothing is printed that contains the key or the password.
 */
import { createClient } from "@supabase/supabase-js";
import { createSupabaseSyncApi, type SyncApi } from "../../src/lib/sync/api";
import type { SyncChange } from "../../src/lib/sync/changes";
import { diffToOps } from "../../src/lib/sync/diff";
import { snapshotKey } from "../../src/lib/sync/engine";
import { planReplaceCloud } from "../../src/lib/sync/escape";
import { SyncError } from "../../src/lib/sync/errors";
import type { SyncSession, SyncSnapshot } from "../../src/lib/sync/snapshot";
import { checkApp, formatGuard, TEST_REF } from "../lib/project-guard";
import { KNOWN_TEST_CLASS_IDS, appCallsDuplicate, describeNonEmpty, rawDeleteClasses, unknownClasses } from "./cleanup";

type Row = { name: string; ok: boolean; info: boolean; detail: string };
const rows: Row[] = [];
const check = (name: string, ok: boolean, detail = "") => {
  rows.push({ name, ok, info: false, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
  return ok;
};
const info = (name: string, detail: string) => {
  rows.push({ name, ok: true, info: true, detail });
  console.log(`INFO  ${name}: ${detail}`);
};

const EMPTY: SyncSnapshot = { classes: [], groups: [], sessions: [] };
const cls = (id: string, name: string, color = "#3b82f6") => ({ id, name, color });
const grp = (id: string, classId: string, name: string) => ({ id, classId, name });
const ses = (id: string, classId: string, groupId: string | null, startedAt: number, seconds = 60, mode: SyncSession["mode"] = "stopwatch"): SyncSession => ({
  id, classId, groupId, startedAt, seconds, mode,
});
const T0 = 1_700_000_000_000;

/** The starting data: the same shape the SQL stage uses. */
const seedData = (): SyncSnapshot => ({
  classes: [cls("A", "Math"), cls("B", "Art", "#8b5cf6")],
  groups: [grp("g1", "A", "Unit 1"), grp("g2", "A", "Unit 2")],
  sessions: [ses("s1", "A", "g1", T0, 60), ses("s2", "A", null, T0 + 100_000, 120), ses("s4", "A", "g2", T0 + 200_000, 240, "countdown"), ses("s3", "B", null, T0 + 300_000, 180)],
});

/** "This device" after the user changed class A: new color, subgroup g2 and sessions s2/s4 gone, s1 longer, s5 new. */
const deviceData = (): SyncSnapshot => ({
  classes: [cls("A", "Math", "#ef4444"), cls("B", "Art", "#8b5cf6")],
  groups: [grp("g1", "A", "Unit 1")],
  sessions: [ses("s1", "A", "g1", T0, 90), ses("s5", "A", null, T0 + 400_000, 30), ses("s3", "B", null, T0 + 300_000, 180)],
});

const load = (n: number): SyncSnapshot => ({
  classes: [cls("Load", "Load")],
  groups: [],
  sessions: Array.from({ length: n }, (_, i) => ses(`ld${n}-${i}`, "Load", null, T0 + i * 1000, 60 + (i % 50))),
});

async function seedTo(api: SyncApi, target: SyncSnapshot) {
  const remote = await api.pullSnapshot();
  const plan = diffToOps(remote.snapshot, target);
  if (!plan.ok) throw new Error(`seed plan refused: ${plan.error.message}`);
  let revision = remote.revision;
  for (const batch of plan.batches) {
    const r = await api.pushChanges(revision, batch);
    if (r.status !== "applied") throw new Error("seed push was answered stale");
    revision = r.revision;
  }
  return api.pullSnapshot();
}

type ReplaceReport = { planned: boolean; refusal?: string; ops: number; bytes: number; ms: number; matches: boolean; revisionDelta: number; error?: string; pushedOps?: SyncChange[] };

/** What the app's Replace cloud does on the wire: plan, ONE push, read back, compare. */
async function replaceTo(api: SyncApi, local: SyncSnapshot): Promise<ReplaceReport> {
  const remote = await api.pullSnapshot();
  const plan = planReplaceCloud(remote.snapshot, local);
  if (!plan.ok) return { planned: false, refusal: plan.message, ops: 0, bytes: 0, ms: 0, matches: false, revisionDelta: 0 };
  const bytes = JSON.stringify(plan.ops).length;
  const started = Date.now();
  try {
    if (plan.ops.length > 0) {
      const r = await api.pushChanges(remote.revision, plan.ops);
      if (r.status !== "applied") return { planned: true, ops: plan.ops.length, bytes, ms: Date.now() - started, matches: false, revisionDelta: 0, error: "stale" };
    }
  } catch (e) {
    const code = e instanceof SyncError ? `${e.kind}/${e.code ?? "-"}/${e.status ?? "-"}: ${e.detail ?? ""}` : String(e);
    return { planned: true, ops: plan.ops.length, bytes, ms: Date.now() - started, matches: false, revisionDelta: 0, error: code };
  }
  const ms = Date.now() - started;
  const after = await api.pullSnapshot();
  return { planned: true, ops: plan.ops.length, bytes, ms, matches: snapshotKey(after.snapshot) === snapshotKey(local), revisionDelta: after.revision - remote.revision, pushedOps: plan.ops };
}

const errCode = (e: unknown) => (e instanceof SyncError ? e.code : null);

async function offline() {
  console.log("OFFLINE CHECK: no network, no credentials.\n");
  const plan = planReplaceCloud(seedData(), deviceData());
  check("the planner builds the same-id delete and recreate for class A", plan.ok && plan.ops.some((o) => o.op === "delete_class" && o.id === "A") && plan.ops.some((o) => o.op === "add_class" && o.id === "A"));
  check("class B, which already matches, is not touched", plan.ok && !plan.ops.some((o) => "id" in o && o.id === "B" && (o.op === "delete_class" || o.op === "add_class")));
  const empty = planReplaceCloud(seedData(), EMPTY);
  check("replacing with an empty device deletes every class", empty.ok && empty.ops.filter((o) => o.op === "delete_class").length === 2);
  const big = planReplaceCloud(load(10), load(4900));
  check("4,900 sessions fit one push", big.ok, big.ok ? `${big.ops.length} operations, ${JSON.stringify(big.ops).length} bytes` : "");
  check("5,100 sessions are refused (never split)", !planReplaceCloud(load(10), load(5100)).ok);
  check("the guard refuses an empty environment", !checkApp({}).ok);
}

async function main() {
  if (process.argv.includes("--offline")) {
    await offline();
    return finish();
  }

  // 1. The production guard. Nothing below runs unless it passes.
  const guard = checkApp(process.env, { requireConfirm: true });
  console.log(formatGuard("Production guard", guard) + "\n");
  if (!guard.ok || guard.ref !== TEST_REF) {
    console.log("Stopped by the guard. No request was made.");
    process.exit(2);
  }
  const email = process.env.STAGE_B_EMAIL;
  const password = process.env.STAGE_B_PASSWORD;
  if (!email || !password) {
    console.log("STAGE_B_EMAIL and STAGE_B_PASSWORD (the dedicated throwaway test account) must be set. No request was made.");
    process.exit(2);
  }

  // 2. Sign in as the throwaway account only.
  const client = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL as string, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY as string, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  const signedIn = await client.auth.signInWithPassword({ email, password });
  if (signedIn.error || !signedIn.data.session) {
    console.log(`Sign-in failed (${signedIn.error?.status ?? "no session"}). Nothing was written.`);
    process.exit(2);
  }
  const api = createSupabaseSyncApi(client);

  // 3. The account must be empty (except in --cleanup, whose whole purpose is to empty an account left over from a stopped run).
  const start = await api.pullSnapshot();
  if (process.argv.includes("--cleanup")) return cleanupOnly(api, start.snapshot.classes);
  const notEmpty = describeNonEmpty(start.snapshot);
  if (notEmpty !== null) {
    console.log(`The test account is NOT empty: it holds ${notEmpty}. Stage B only runs on an empty throwaway account (run --cleanup after an interrupted run). Nothing was written.`);
    process.exit(2);
  }
  console.log(`Signed in to the test project; the account is empty (revision ${start.revision}).\n`);

  try {
    // B1: seed
    const seeded = await seedTo(api, seedData());
    check("B1 seed: the account holds the starting data", snapshotKey(seeded.snapshot) === snapshotKey(seedData()), `revision ${seeded.revision}`);

    // B2: the real question, through the real plan
    const before = await api.pullSnapshot();
    const r2 = await replaceTo(api, deviceData());
    check("B2 same-id replace is planned", r2.planned, r2.refusal);
    check("B2 ... pushed in ONE call and accepted", !r2.error && r2.revisionDelta === 1, r2.error ?? `revision +${r2.revisionDelta}, ${r2.ops} operations, ${r2.ms} ms`);
    check("B2 ... the cloud reads back EXACTLY as this device's data", r2.matches);
    check("B2 ... the plan deleted and recreated class A under the same id and left class B alone",
      !!r2.pushedOps && r2.pushedOps.some((o) => o.op === "delete_class" && o.id === "A") && r2.pushedOps.some((o) => o.op === "add_class" && o.id === "A")
        && !r2.pushedOps.some((o) => (o.op === "delete_class" || o.op === "add_class") && o.id === "B"));
    const afterOrder = (await api.pullSnapshot()).snapshot.classes.map((c) => c.id).join(",");
    info("B2 class display order after the replace", `[${afterOrder}] (the app's order is [A,B]; a recreated class sorts after the untouched one, the accepted cosmetic change)`);

    // B3: nothing to do
    const r3 = await replaceTo(api, deviceData());
    check("B3 replacing again with identical data sends nothing", r3.planned && r3.ops === 0 && r3.revisionDelta === 0 && r3.matches);

    // B4: stale
    const nowRev = (await api.pullSnapshot()).revision;
    const stale = await api.pushChanges(before.revision, [{ op: "add_class", id: "stale1", name: "Stale", color: "#000000" }]);
    check("B4 a push at an old revision is stale and writes nothing", stale.status === "stale" && (await api.pullSnapshot()).revision === nowRev);

    // B5: all or nothing, over the real HTTP path
    const sig = async () => {
      const s = await api.pullSnapshot();
      return `${s.revision}|${snapshotKey(s.snapshot)}`;
    };
    const keep = await sig();
    let code: string | null = null;
    try {
      await api.pushChanges(nowRev, [
        { op: "delete_class", id: "A", expectedSessions: 2 },
        { op: "add_class", id: "A", name: "Math", color: "#ef4444" },
        { op: "add_session", id: "zz", classId: "missing", groupId: null, startedAt: T0, seconds: 10, mode: "stopwatch" },
      ]);
    } catch (e) {
      code = errCode(e);
    }
    check("B5 a valid delete+recreate followed by a bad operation is rejected (22023) and undone", code === "22023" && (await sig()) === keep, `code ${code}`);
    code = null;
    try {
      await api.pushChanges(nowRev, [{ op: "add_class", id: "Z", name: "Zed", color: "#000000" }, { op: "delete_class", id: "B", expectedSessions: 99 }]);
    } catch (e) {
      code = errCode(e);
    }
    check("B6 a wrong expectedSessions is refused (ST004) and undoes the earlier operation", code === "ST004" && (await sig()) === keep, `code ${code}`);

    // B7: two writers at once (two real HTTP requests, one lock)
    const [x, y] = await Promise.allSettled([
      api.pushChanges(nowRev, [{ op: "add_class", id: "R1", name: "Race 1", color: "#000000" }]),
      api.pushChanges(nowRev, [{ op: "add_class", id: "R2", name: "Race 2", color: "#000000" }]),
    ]);
    const statuses = [x, y].map((r) => (r.status === "fulfilled" ? r.value.status : `error:${errCode(r.reason)}`)).sort();
    const racers = (await api.pullSnapshot()).snapshot.classes.filter((c) => c.id.startsWith("R")).length;
    check("B7 two simultaneous pushes at one revision: exactly one applies, the other is stale", statuses.join(",") === "applied,stale" && racers === 1, statuses.join(","));
    // put the race winner back out of the way, as a replace from this device would
    await replaceTo(api, deviceData());

    // B8: size and time, step by step
    for (const n of [500, 2000, 4900]) {
      const r = await replaceTo(api, load(n));
      const detail = r.error ?? r.refusal ?? `${r.ops} operations, ${(r.bytes / 1024).toFixed(0)} KB, ${r.ms} ms`;
      check(`B8 replace with ${n} sessions in one push`, r.planned && !r.error && r.matches, detail);
    }
    const tooBig = await replaceTo(api, load(5100));
    check("B8 5,100 sessions are refused by the app before anything is sent", !tooBig.planned && (await api.pullSnapshot()).snapshot.sessions.length === 4900);

    // B9: names (information only). First empty the account; this must work, so the result is checked.
    const before9 = await rawDeleteClasses(api, "all");
    if (!before9.ok) throw new Error(`B9 setup: the account could not be emptied: ${before9.detail}`);
    const pairs: [string, string][] = [["Straße", "STRASSE"], ["İstanbul", "istanbul"], ["Éclair", "éclair"]];
    for (const [a, b] of pairs) {
      const rev = (await api.pullSnapshot()).revision;
      let accepted = false;
      try {
        const r = await api.pushChanges(rev, [{ op: "add_class", id: "u1", name: a, color: "#000000" }, { op: "add_class", id: "u2", name: b, color: "#000000" }]);
        if (r.status !== "applied") throw new Error(`B9 push for "${a}" and "${b}" was answered ${r.status} instead of applied`);
        accepted = true;
      } catch (e) {
        // Only ST003 (a name or id conflict) is the expected, informational outcome. Anything else (network, sign-in, server,
        // database, a stale answer) is rethrown and stops the run.
        if (!(e instanceof SyncError) || e.code !== "ST003") throw e;
        info(`B9 names "${a}" and "${b}"`, `refused with ST003 (the same name to the database; the app's validator calls the pair ${appCallsDuplicate(a, b) ? "a duplicate" : "different"})`);
      }
      if (accepted) {
        info(`B9 names "${a}" and "${b}"`, `both accepted (different names to the database; the app's validator calls the pair ${appCallsDuplicate(a, b) ? "a duplicate" : "different"})`);
        // Cleanup runs outside the block above, so a failure here can never be reported as a name collision. It removes only
        // this pair's own classes, with raw operations: the app's planner refuses a snapshot the app's validator rejects
        // (which is exactly what an accepted "duplicate" pair is), so it could not clean this up.
        const cleanup = await rawDeleteClasses(api, ["u1", "u2"]);
        if (!cleanup.ok) throw new Error(`B9 cleanup after "${a}" and "${b}" failed: ${cleanup.detail}`);
      }
    }
  } catch (e) {
    check("the run finished without an unexpected error", false, e instanceof Error ? e.message : String(e));
  } finally {
    // 5. Always leave the account empty (raw operations, so data the app's validator refuses can be removed too).
    try {
      const end = await rawDeleteClasses(api, "all");
      check("cleanup: the test account is empty again", end.ok, end.detail);
    } catch (e) {
      check("cleanup: the test account is empty again", false, e instanceof Error ? e.message : String(e));
    }
  }
  return finish();
}

/** `--cleanup`: empties the throwaway account after a stopped run. Refuses an account holding classes this script never creates. */
async function cleanupOnly(api: SyncApi, classes: { id: string; name: string }[]) {
  console.log(`CLEANUP ONLY: the account holds ${classes.length} class(es): ${classes.map((c) => `${c.id}`).join(", ") || "(none)"}.`);
  const foreign = unknownClasses(classes);
  if (foreign.length > 0) {
    console.log(`Refused: ${foreign.length} class(es) are not ones this script creates (${foreign.map((c) => c.id).join(", ")}). This does not look like the throwaway account. Nothing was changed.`);
    process.exit(2);
  }
  try {
    // The identity check is made again on the fresh snapshot the delete itself is based on (the first one was a separate read).
    const r = await rawDeleteClasses(api, "all", { allowedIds: KNOWN_TEST_CLASS_IDS });
    if (r.unexpected) {
      console.log(`Refused: the account now holds class(es) this script does not create (${r.unexpected.join(", ")}). Nothing was sent or changed.`);
      process.exit(2);
    }
    check("cleanup-only: the test account is empty", r.ok, r.detail);
  } catch (e) {
    check("cleanup-only: the test account is empty", false, e instanceof Error ? e.message : String(e));
  }
  return finish();
}

function finish() {
  const failed = rows.filter((r) => !r.ok);
  console.log(`\n${rows.filter((r) => !r.info).length - failed.length} passed, ${failed.length} failed, ${rows.filter((r) => r.info).length} informational.`);
  console.log(failed.length === 0 ? "STAGE B: ALL CHECKS PASSED" : "STAGE B: FAILURES, see above");
  process.exit(failed.length === 0 ? 0 : 1);
}

void main();
