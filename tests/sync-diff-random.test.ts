import { describe, expect, it } from "vitest";
import type { SyncChange } from "@/lib/sync/changes";
import { diffToOps } from "@/lib/sync/diff";
import { fromSyncSnapshot } from "@/lib/sync/from-snapshot";
import type { SyncSnapshot } from "@/lib/sync/snapshot";
import { createFakeSyncServer } from "./helpers/fake-sync-server";
import { applyBatches, canon, cls, grp, planOk, seed, ses, snap } from "./helpers/sync-plan-harness";

/**
 * Seeded property-style tests. Each seed builds a valid remote snapshot and a valid target (renames,
 * swaps and cycles, name reuse, deletes, re-created subgroups, moved and added sessions, sessions
 * dropped only together with their class), plans the difference, applies every batch to the in-memory
 * server, and requires the server to end exactly at the target. The generator is deterministic, so a
 * failing seed can be replayed.
 */

function makeRand(seedValue: number) {
  let a = seedValue >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    int: (n: number) => Math.floor(next() * n),
    chance: (p: number) => next() < p,
    pick: <T>(list: T[]): T => list[Math.floor(next() * list.length)],
    shuffle: <T>(list: T[]): T[] => {
      const out = [...list];
      for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(next() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    },
  };
}
type Rand = ReturnType<typeof makeRand>;

const CLASS_NAMES = ["Math", "Art", "Bio", "Chem", "History", "Physics", "Econ", "Lit", "Music", "Law", "Geo", "Psych"];
const GROUP_NAMES = ["Unit 1", "Unit 2", "Unit 3", "Unit 4", "Unit 5", "Unit 6"];
const COLORS = ["#3b82f6", "#8b5cf6", "#f59e0b", "#10b981", "#ec4899", "#14b8a6"];

/** The next unused name (compared ignoring capitals) from a candidate list, or a numbered one. */
function takeName(candidates: string[], used: Set<string>, prefix: string): string {
  for (const name of candidates) {
    if (!used.has(name.toLowerCase())) {
      used.add(name.toLowerCase());
      return name;
    }
  }
  for (let n = used.size + 1; ; n++) {
    const name = `${prefix} ${n}`;
    if (!used.has(name.toLowerCase())) {
      used.add(name.toLowerCase());
      return name;
    }
  }
}

type Size = { classes: number; groups: number; sessions: number };

function genRemote(rand: Rand, size: Size): SyncSnapshot {
  const used = new Set<string>();
  const names = rand.shuffle(CLASS_NAMES);
  const classes = Array.from({ length: size.classes }, (_, i) => cls(`c${i}`, takeName(names, used, "Class"), rand.pick(COLORS)));
  const groups: SyncSnapshot["groups"] = [];
  for (const c of classes) {
    const usedG = new Set<string>();
    const pool = rand.shuffle(GROUP_NAMES);
    for (let j = rand.int(size.groups + 1); j > 0; j--) groups.push(grp(`g${c.id}-${groups.length}`, c.id, takeName(pool, usedG, "Group")));
  }
  const sessions: SyncSnapshot["sessions"] = [];
  if (classes.length > 0) {
    for (let i = 0; i < size.sessions; i++) {
      const c = rand.pick(classes);
      const own = groups.filter((g) => g.classId === c.id);
      sessions.push(ses(`s${i}`, c.id, own.length > 0 && rand.chance(0.5) ? rand.pick(own).id : null, 1_700_000_000_000 + rand.int(1_000_000_000), 1 + rand.int(5000), rand.chance(0.5) ? "stopwatch" : "countdown"));
    }
  }
  return snap(classes, groups, sessions);
}

/** A target with brand-new ids that reuses the same names (everything old goes, everything new comes). */
function genFresh(rand: Rand, size: Size): SyncSnapshot {
  const used = new Set<string>();
  const names = rand.shuffle(CLASS_NAMES);
  const classes = Array.from({ length: rand.int(size.classes + 1) }, (_, i) => cls(`f${i}`, takeName(names, used, "Class"), rand.pick(COLORS)));
  const groups: SyncSnapshot["groups"] = [];
  for (const c of classes) {
    const usedG = new Set<string>();
    for (let j = rand.int(3); j > 0; j--) groups.push(grp(`fg${c.id}-${groups.length}`, c.id, takeName(rand.shuffle(GROUP_NAMES), usedG, "Group")));
  }
  const sessions = classes.length === 0 ? [] : Array.from({ length: rand.int(size.sessions + 1) }, (_, i) => {
    const c = rand.pick(classes);
    const own = groups.filter((g) => g.classId === c.id);
    return ses(`fs${i}`, c.id, own.length > 0 && rand.chance(0.5) ? rand.pick(own).id : null, 1_700_000_000_000 + i);
  });
  return snap(classes, groups, sessions);
}

function genTarget(rand: Rand, remote: SyncSnapshot, size: Size): SyncSnapshot {
  if (rand.chance(0.08)) return genFresh(rand, size);

  // ---- classes: some kept (with new names and colors), some deleted, some new
  const kept = new Set(remote.classes.filter(() => rand.chance(0.75)).map((c) => c.id));
  const order: { id: string; kept: boolean }[] = remote.classes.filter((c) => kept.has(c.id)).map((c) => ({ id: c.id, kept: true }));
  for (let i = rand.int(4); i > 0; i--) order.splice(rand.int(order.length + 1), 0, { id: `n${i}`, kept: false });

  const remoteClass = new Map(remote.classes.map((c) => [c.id, c]));
  const usedNames = new Set<string>();
  const given = new Map<string, string>();
  for (const o of order) {
    if (o.kept && rand.chance(0.4)) {
      const own = remoteClass.get(o.id)!.name;
      usedNames.add(own.toLowerCase());
      given.set(o.id, own);
    }
  }
  const pool = rand.shuffle([...remote.classes.map((c) => c.name), ...CLASS_NAMES]);
  const classes = order.map((o) => {
    let name = given.get(o.id) ?? takeName(pool, usedNames, "Class");
    if (rand.chance(0.2)) name = name.toUpperCase();
    const color = o.kept && !rand.chance(0.3) ? remoteClass.get(o.id)!.color : rand.pick(COLORS);
    return cls(o.id, name, color);
  });
  const classIds = classes.map((c) => c.id);

  // ---- subgroups: kept, deleted, re-created under another class, and new ones
  const entries: { id: string; classId: string; origin: string | null }[] = [];
  for (const g of remote.groups) {
    if (!kept.has(g.classId)) {
      if (classIds.length > 0 && rand.chance(0.15)) entries.push({ id: g.id, classId: rand.pick(classIds), origin: g.classId });
      continue;
    }
    if (rand.chance(0.2)) continue;
    entries.push({ id: g.id, classId: rand.chance(0.12) ? rand.pick(classIds) : g.classId, origin: g.classId });
  }
  for (const c of classIds) for (let j = rand.int(3); j > 0; j--) entries.push({ id: `ng-${c}-${j}`, classId: c, origin: null });
  const remoteGroup = new Map(remote.groups.map((g) => [g.id, g]));
  const groups: SyncSnapshot["groups"] = [];
  for (const c of classIds) {
    const members = rand.shuffle(entries.filter((e) => e.classId === c));
    const used = new Set<string>();
    const names = new Map<string, string>();
    for (const m of members) {
      if (m.origin === c && rand.chance(0.6)) {
        const own = remoteGroup.get(m.id)!.name;
        if (!used.has(own.toLowerCase())) {
          used.add(own.toLowerCase());
          names.set(m.id, own);
        }
      }
    }
    const gpool = rand.shuffle([...members.map((m) => remoteGroup.get(m.id)?.name ?? ""), ...GROUP_NAMES].filter((n) => n !== ""));
    for (const m of members) groups.push(grp(m.id, c, names.get(m.id) ?? takeName(gpool, used, "Group")));
  }

  // ---- sessions: kept ones may move; sessions of a deleted class either move to a surviving class or go with it
  const dest = (): { classId: string; groupId: string | null } | null => {
    if (classIds.length === 0) return null;
    const classId = rand.pick(classIds);
    const own = groups.filter((g) => g.classId === classId);
    return { classId, groupId: own.length > 0 && rand.chance(0.6) ? rand.pick(own).id : null };
  };
  const sessions: SyncSnapshot["sessions"] = [];
  for (const s of remote.sessions) {
    if (kept.has(s.classId)) {
      let to = { classId: s.classId, groupId: s.groupId !== null && groups.some((g) => g.id === s.groupId && g.classId === s.classId) ? s.groupId : null };
      if (rand.chance(0.3)) to = dest() ?? to;
      sessions.push({ ...s, ...to });
    } else if (rand.chance(0.5)) {
      const to = dest();
      if (to) sessions.push({ ...s, ...to });
    }
  }
  for (let i = rand.int(size.sessions / 2 + 1); i > 0 && classIds.length > 0; i--) {
    const to = dest()!;
    sessions.push(ses(`ns${i}`, to.classId, to.groupId, 1_700_000_000_000 + rand.int(1_000_000_000), 1 + rand.int(900), "stopwatch"));
  }
  return snap(classes, groups, rand.shuffle(sessions));
}

type Stats = { ops: Record<string, number>; tempRenames: number; recreatedGroups: number; deleteWithSessions: number; batches: number };
const newStats = (): Stats => ({ ops: {}, tempRenames: 0, recreatedGroups: 0, deleteWithSessions: 0, batches: 0 });

function record(stats: Stats, ops: SyncChange[]) {
  for (const op of ops) {
    stats.ops[op.op] = (stats.ops[op.op] ?? 0) + 1;
    if (op.op === "update_class" && /^~sync-\d+$/.test(op.name ?? "")) stats.tempRenames++;
    if (op.op === "rename_group" && /^~sync-\d+$/.test(op.name)) stats.tempRenames++;
    if (op.op === "delete_class" && op.expectedSessions > 0) stats.deleteWithSessions++;
  }
  const deleted = new Set(ops.filter((o) => o.op === "delete_group").map((o) => (o as { id: string }).id));
  stats.recreatedGroups += ops.filter((o) => o.op === "add_group" && deleted.has(o.id)).length;
}

/** Where classes and subgroups can end up: existing ones keep their order, new ones follow in target order. */
function expectedOrders(before: SyncSnapshot, target: SyncSnapshot) {
  const beforeClassIds = before.classes.map((c) => c.id);
  const targetIds = new Set(target.classes.map((c) => c.id));
  const classes = [
    ...beforeClassIds.filter((id) => targetIds.has(id)),
    ...target.classes.map((c) => c.id).filter((id) => !beforeClassIds.includes(id)),
  ];
  const groups = new Map<string, string[]>();
  for (const c of target.classes) {
    const mine = target.groups.filter((g) => g.classId === c.id);
    const stays = (id: string) => before.groups.some((g) => g.id === id && g.classId === c.id);
    groups.set(c.id, [
      ...before.groups.filter((g) => g.classId === c.id && mine.some((m) => m.id === g.id)).map((g) => g.id),
      ...mine.filter((g) => !stays(g.id)).map((g) => g.id),
    ]);
  }
  return { classes, groups };
}

async function runSeed(seedValue: number, size: Size, stats: Stats, maxChanges?: number) {
  const rand = makeRand(seedValue);
  const remote = genRemote(rand, size);
  const target = genTarget(rand, remote, size);
  const valid = fromSyncSnapshot(target);
  if (!valid.ok) throw new Error("the generator produced an invalid target: " + JSON.stringify(valid.issues.slice(0, 3)));

  const server = createFakeSyncServer();
  const before = await seed(server, "u", remote);
  const options = maxChanges ? { maxChanges } : undefined;
  const plan = planOk(diffToOps(before.snapshot, target, options));
  record(stats, plan.ops);
  stats.batches += plan.batches.length;

  // Deterministic: the same inputs give the same plan.
  expect(planOk(diffToOps(before.snapshot, target, options))).toEqual(plan);
  if (maxChanges) expect(plan.batches.every((b) => b.length <= maxChanges)).toBe(true);
  expect(plan.batches.flat()).toEqual(plan.ops);

  const revision = await applyBatches(server, "u", plan.batches, before.revision); // every batch accepted, every op effective
  const after = await server.apiFor("u").pullSnapshot();
  expect(after.revision).toBe(revision);
  expect(canon(after.snapshot)).toEqual(canon(target));

  // Creation order: existing rows keep their order, new ones follow in target order.
  const orders = expectedOrders(before.snapshot, target);
  expect(after.snapshot.classes.map((c) => c.id)).toEqual(orders.classes);
  for (const [classId, ids] of orders.groups) {
    expect(after.snapshot.groups.filter((g) => g.classId === classId).map((g) => g.id)).toEqual(ids);
  }

  // Nothing is left to do.
  expect(planOk(diffToOps(after.snapshot, target, options)).ops).toEqual([]);
}

async function runMany(seeds: number[], size: (rand: Rand) => Size, stats: Stats, maxChanges?: (rand: Rand) => number | undefined) {
  for (const s of seeds) {
    const sizeRand = makeRand(s ^ 0x9e3779b9);
    try {
      await runSeed(s, size(sizeRand), stats, maxChanges?.(sizeRand));
    } catch (e) {
      throw new Error(`seed ${s}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

const range = (from: number, to: number) => Array.from({ length: to - from }, (_, i) => from + i);

describe("randomized plans applied to the in-memory server", () => {
  it("small snapshots: the server always ends exactly at the target (400 seeds)", async () => {
    const stats = newStats();
    await runMany(range(0, 400), (r) => ({ classes: r.int(7), groups: r.int(5), sessions: r.int(30) }), stats);
    // The generator really does exercise the hard cases.
    expect(stats.tempRenames).toBeGreaterThan(20);
    expect(stats.recreatedGroups).toBeGreaterThan(5);
    expect(stats.deleteWithSessions).toBeGreaterThan(20);
    for (const op of ["add_class", "update_class", "delete_class", "add_group", "rename_group", "delete_group", "add_session", "move_session"]) {
      expect(stats.ops[op] ?? 0, `${op} was never planned`).toBeGreaterThan(20);
    }
  }, 120_000);

  it("the same seeds with tiny batch limits: every batch is valid on its own (400 seeds)", async () => {
    const stats = newStats();
    await runMany(range(1000, 1400), (r) => ({ classes: r.int(7), groups: r.int(5), sessions: r.int(30) }), stats, (r) => 1 + r.int(6));
    expect(stats.batches).toBeGreaterThan(400);
  }, 120_000);

  it("larger snapshots (40 seeds)", async () => {
    const stats = newStats();
    await runMany(range(5000, 5040), (r) => ({ classes: 10 + r.int(30), groups: 2 + r.int(5), sessions: 100 + r.int(300) }), stats);
    expect(stats.ops.move_session ?? 0).toBeGreaterThan(50);
  }, 120_000);

  it("larger snapshots with small batches (15 seeds)", async () => {
    const stats = newStats();
    await runMany(range(7000, 7015), (r) => ({ classes: 10 + r.int(20), groups: 2 + r.int(4), sessions: 80 + r.int(120) }), stats, (r) => 5 + r.int(40));
    expect(stats.batches).toBeGreaterThan(15);
  }, 120_000);
});

describe("randomized refusals", () => {
  it("a session that cannot be edited or deleted on its own always makes the plan refuse, never invent an operation", () => {
    let edited = 0;
    let removed = 0;
    for (const s of range(0, 200)) {
      const rand = makeRand(s);
      const remote = genRemote(rand, { classes: 1 + rand.int(5), groups: 3, sessions: 1 + rand.int(15) });
      if (remote.sessions.length === 0) continue;
      const victim = rand.pick(remote.sessions);

      // Same snapshot with one session's duration changed.
      const changed = { ...remote, sessions: remote.sessions.map((x) => (x.id === victim.id ? { ...x, seconds: x.seconds + 1 } : x)) };
      const a = diffToOps(remote, changed);
      expect(a.ok).toBe(false);
      if (!a.ok) expect(a.error.code).toBe("session_data_changed");
      edited++;

      // Same snapshot with one session missing while its class stays.
      const dropped = { ...remote, sessions: remote.sessions.filter((x) => x.id !== victim.id) };
      const b = diffToOps(remote, dropped);
      expect(b.ok).toBe(false);
      if (!b.ok) expect(b.error.code).toBe("session_removal_unsupported");
      removed++;
    }
    expect(edited).toBeGreaterThan(100);
    expect(removed).toBeGreaterThan(100);
  });
});
