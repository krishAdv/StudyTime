import { describe, expect, it } from "vitest";
import { merge3, type MergeResult } from "@/lib/sync/merge";
import type { SyncSnapshot } from "@/lib/sync/snapshot";
import { clone, conflictKeys, deepFreeze, mergedTarget } from "./helpers/merge-harness";
import { canon, cls, grp, planAndApply, ses, snap } from "./helpers/sync-plan-harness";

/**
 * Seeded property tests for merge3. Each seed builds a valid base and two valid sides that edit it
 * independently (renames, recolors, adds, class and subgroup deletes with the app's cascade rules, session
 * adds and moves, occasionally the very same edit on both sides). The generator is deterministic, so a
 * failing seed can be replayed. Sides never delete a single session (the app cannot).
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

const POOL = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Zeta"];
const COLORS = ["#3b82f6", "#8b5cf6", "#f59e0b", "#10b981", "#ec4899"];

/** A name not used by `used` (case-insensitive): from the shared pool (so the two sides can collide) or unique. */
function freshName(rand: Rand, used: string[], unique: string): string {
  const taken = new Set(used.map((n) => n.toLowerCase()));
  const candidates = rand.shuffle(POOL).filter((n) => !taken.has(n.toLowerCase()));
  if (candidates.length > 0 && rand.chance(0.6)) return rand.chance(0.3) ? candidates[0].toUpperCase() : candidates[0];
  return unique;
}

function makeBase(rand: Rand): SyncSnapshot {
  const d = snap();
  const nClasses = 1 + rand.int(4);
  let t = 1_000;
  for (let c = 0; c < nClasses; c++) {
    d.classes.push(cls(`c${c}`, `Base class ${c}`, rand.pick(COLORS)));
    for (let g = rand.int(3); g > 0; g--) d.groups.push(grp(`g${c}-${g}`, `c${c}`, `Base group ${c}-${g}`));
  }
  for (let s = rand.int(9); s > 0; s--) {
    const c = rand.pick(d.classes);
    const groups = d.groups.filter((g) => g.classId === c.id);
    const group = groups.length > 0 && rand.chance(0.5) ? rand.pick(groups) : null;
    d.sessions.push(ses(`s${s}`, c.id, group?.id ?? null, (t += 1_000), 30 + s, rand.chance(0.5) ? "stopwatch" : "countdown"));
  }
  return d;
}

type Counter = { n: number };

function applyRandomEdit(rand: Rand, d: SyncSnapshot, base: SyncSnapshot, p: string, counter: Counter) {
  const kind = rand.int(11);
  const id = () => `${p}${counter.n++}`;
  switch (kind) {
    case 0:
    case 1: {
      if (d.classes.length === 0) return;
      const c = rand.pick(d.classes);
      c.name = freshName(rand, d.classes.filter((x) => x !== c).map((x) => x.name), `Class ${id()}`);
      return;
    }
    case 2: {
      if (d.classes.length > 0) rand.pick(d.classes).color = rand.pick(COLORS);
      return;
    }
    case 3: {
      const cid = id();
      d.classes.push(cls(cid, freshName(rand, d.classes.map((x) => x.name), `Class ${cid}`), rand.pick(COLORS)));
      return;
    }
    case 4: {
      if (d.classes.length === 0 || !rand.chance(0.7)) return;
      const c = rand.pick(d.classes);
      // Moving a base session into a class and then deleting that class would delete one session while its
      // original class survives, which the server cannot express (see the limitations in the status doc).
      const movedIn = d.sessions.some((x) => x.classId === c.id && base.sessions.some((b) => b.id === x.id && b.classId !== c.id));
      if (movedIn) return;
      d.classes = d.classes.filter((x) => x !== c);
      d.groups = d.groups.filter((g) => g.classId !== c.id);
      d.sessions = d.sessions.filter((s) => s.classId !== c.id);
      return;
    }
    case 5: {
      if (d.classes.length === 0) return;
      const c = rand.pick(d.classes);
      const gid = id();
      d.groups.push(grp(gid, c.id, freshName(rand, d.groups.filter((g) => g.classId === c.id).map((g) => g.name), `Group ${gid}`)));
      return;
    }
    case 6: {
      if (d.groups.length === 0) return;
      const g = rand.pick(d.groups);
      g.name = freshName(rand, d.groups.filter((x) => x.classId === g.classId && x !== g).map((x) => x.name), `Group ${id()}`);
      return;
    }
    case 7: {
      if (d.groups.length === 0) return;
      const g = rand.pick(d.groups);
      d.groups = d.groups.filter((x) => x !== g);
      for (const s of d.sessions) if (s.groupId === g.id) s.groupId = null;
      return;
    }
    case 8:
    case 9: {
      if (d.classes.length === 0) return;
      const c = rand.pick(d.classes);
      const groups = d.groups.filter((g) => g.classId === c.id);
      const group = groups.length > 0 && rand.chance(0.5) ? rand.pick(groups) : null;
      d.sessions.push(ses(id(), c.id, group?.id ?? null, 50_000 + counter.n, 10 + rand.int(50), "stopwatch"));
      return;
    }
    default: {
      if (d.sessions.length === 0 || d.classes.length === 0) return;
      const s = rand.pick(d.sessions);
      const c = rand.pick(d.classes);
      const groups = d.groups.filter((g) => g.classId === c.id);
      s.classId = c.id;
      s.groupId = groups.length > 0 && rand.chance(0.5) ? rand.pick(groups).id : null;
    }
  }
}

function makeCase(seedValue: number) {
  const rand = makeRand(seedValue);
  const base = makeBase(rand);
  const local = clone(base);
  const remote = clone(base);
  const lc: Counter = { n: 0 };
  const rc: Counter = { n: 0 };
  if (rand.chance(0.3) && base.classes.length > 0) {
    // the very same rename on both sides
    const c = rand.pick(base.classes);
    for (const d of [local, remote]) d.classes.find((x) => x.id === c.id)!.name = "Shared name";
  }
  for (let i = rand.int(5); i > 0; i--) applyRandomEdit(rand, local, base, "L", lc);
  for (let i = rand.int(5); i > 0; i--) applyRandomEdit(rand, remote, base, "R", rc);
  return { base, local, remote, rand };
}

const SEEDS = Array.from({ length: 300 }, (_, i) => i + 1);

/** Everything but the target, which is compared as data (list order is not part of the contract for swapped inputs). */
const report = (r: MergeResult) => (r.status === "refused" ? { status: r.status, code: r.error.code } : { status: r.status, resolutions: r.resolutions, warnings: r.warnings, conflicts: r.status === "conflicted" ? r.conflicts : [] });

describe("merge3 randomized", () => {
  it("is valid, deterministic, symmetric, never loses a session, and every merged result converges through S3 and the fake server", async () => {
    const tally = { merged: 0, conflicted: 0, refused: 0, codes: new Set<string>() };
    for (const seed of SEEDS) {
      const { base, local, remote } = makeCase(seed);
      for (const input of [base, local, remote]) deepFreeze(input); // any mutation by merge3 throws
      const why = `seed ${seed}`;

      const result = merge3(base, local, remote);
      expect(merge3(clone(base), clone(local), clone(remote)), why).toEqual(result);
      tally[result.status]++;
      if (result.status === "conflicted") for (const c of result.conflicts) tally.codes.add(c.code);
      expect(result.status, `${why}: valid inputs must never be refused (${result.status === "refused" ? result.error.code : ""})`).not.toBe("refused");

      // Swapping the sides: same outcome and same conflicts (labels aside), same data.
      const swapped = merge3(base, remote, local);
      expect(swapped.status, why).toBe(result.status);
      expect(conflictKeys(swapped), why).toEqual(conflictKeys(result));
      if (result.status === "merged" && swapped.status === "merged") {
        expect(canon(swapped.target), why).toEqual(canon(result.target));
        expect(swapped.warnings.map((w) => `${w.code}:${w.id}:${w.count}`), why).toEqual(result.warnings.map((w) => `${w.code}:${w.id}:${w.count}`));
      }
      if (result.status !== "merged") continue;

      // No session loss: a session may only be missing from the target if its class is.
      const targetClasses = new Set(result.target.classes.map((c) => c.id));
      const targetSessions = new Map(result.target.sessions.map((s) => [s.id, s]));
      for (const source of [base, local, remote]) {
        for (const s of source.sessions) {
          const kept = targetSessions.get(s.id);
          if (!kept) expect(targetClasses.has(s.classId), `${why}: session ${s.id} lost while its class ${s.classId} survives`).toBe(false);
          else expect([kept.startedAt, kept.seconds, kept.mode], `${why}: immutable fields of ${s.id}`).toEqual([s.startedAt, s.seconds, s.mode]);
        }
      }
      // Nothing is invented: every target entity exists on a side.
      const known = (list: "classes" | "groups" | "sessions") => new Set([...local[list], ...remote[list]].map((x) => x.id));
      for (const list of ["classes", "groups", "sessions"] as const) {
        for (const x of result.target[list]) expect(known(list).has(x.id), `${why}: invented ${list} ${x.id}`).toBe(true);
      }
      // A class deleted on either side without conflict is gone from the target only if it was deleted there.
      for (const c of base.classes) {
        if (!targetClasses.has(c.id)) {
          expect(local.classes.some((x) => x.id === c.id) && remote.classes.some((x) => x.id === c.id), `${why}: class ${c.id} dropped though both sides have it`).toBe(false);
        }
      }

      // S3 compatibility: plan, apply every batch to the fake server, end exactly at the target (also in tiny batches).
      await planAndApply(remote, result.target);
      await planAndApply(remote, result.target, { maxChanges: 3 });
    }
    expect(tally.merged, "the generator should produce plenty of clean merges").toBeGreaterThan(SEEDS.length * 0.3);
    expect(tally.conflicted, "and plenty of conflicts").toBeGreaterThan(SEEDS.length * 0.1);
    expect(tally.codes.size, `conflict kinds seen: ${[...tally.codes].join(", ")}`).toBeGreaterThanOrEqual(8);
  }, 120_000);

  it("is unaffected by the order of entities in the inputs", () => {
    for (const seed of SEEDS) {
      const { base, local, remote, rand } = makeCase(seed);
      const mix = (s: SyncSnapshot): SyncSnapshot => ({ classes: rand.shuffle(s.classes), groups: rand.shuffle(s.groups), sessions: rand.shuffle(s.sessions) });
      const a = merge3(base, local, remote);
      const b = merge3(mix(base), mix(local), clone(remote));
      expect(report(b), `seed ${seed}`).toEqual(report(a));
      if (a.status === "merged" && b.status === "merged") expect(canon(b.target), `seed ${seed}`).toEqual(canon(a.target));
    }
  });

  it("when only one side changed, the result is exactly that side", async () => {
    for (const seed of SEEDS.slice(0, 150)) {
      const { base, local, remote } = makeCase(seed);
      const onlyLocal = merge3(base, local, base);
      expect(canon(mergedTarget(onlyLocal)), `seed ${seed} local only`).toEqual(canon(local));
      const onlyRemote = merge3(base, base, remote);
      expect(canon(mergedTarget(onlyRemote)), `seed ${seed} remote only`).toEqual(canon(remote));
      expect(canon(mergedTarget(merge3(base, remote, remote))), `seed ${seed} same on both`).toEqual(canon(remote));
      if (seed % 10 === 0) await planAndApply(base, mergedTarget(onlyLocal));
    }
  }, 60_000);

  it("a no-change merge is a no-op with nothing to report", () => {
    for (const seed of SEEDS.slice(0, 50)) {
      const { base } = makeCase(seed);
      const r = merge3(base, base, base);
      expect(r.status === "merged" && r.resolutions.length + r.warnings.length).toBe(0);
      expect(canon(mergedTarget(r))).toEqual(canon(base));
    }
  });
});
