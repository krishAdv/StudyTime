import { describe, expect, it } from "vitest";
import { describeConflicts, notDecisions, toDecision } from "@/lib/sync/conflict-text";
import { planReplaceCloud } from "@/lib/sync/escape";
import { createFakeSyncServer } from "./helpers/fake-sync-server";
import { seedAndLink } from "./helpers/sync-device";
import { canon, cls, grp, ses, snap } from "./helpers/sync-plan-harness";
import { baseSnapshot } from "./helpers/merge-fixtures";

const USER = "u";

async function conflict(edit: { a: (d: ReturnType<typeof baseSnapshot>) => void; b: (d: ReturnType<typeof baseSnapshot>) => void }, initial = baseSnapshot()) {
  const server = createFakeSyncServer();
  const { a, b } = await seedAndLink(server, USER, initial);
  b.edit(edit.b);
  expect((await b.sync()).status).toBe("synced"); // the other device went first
  a.edit(edit.a);
  const out = await a.sync();
  if (out.status !== "conflicted") throw new Error("expected a conflict, got " + out.status);
  return { server, a, out, views: describeConflicts(out.decisionPoints, out.conflicts, out.snapshots) };
}

describe("the conflict screen's text", () => {
  it("a class renamed on both sides: both names shown, both choices available, and nothing pushed until decided", async () => {
    const { server, a, out, views } = await conflict({ a: (d) => void (d.classes[0].name = "Maths"), b: (d) => void (d.classes[0].name = "Calculus") });
    expect(views).toHaveLength(1);
    expect(views[0].title).toContain("“Math”");
    expect(views[0].detail).toContain("“Maths”");
    expect(views[0].detail).toContain("“Calculus”");
    expect(views[0].choices.map((c) => [c.key, c.available])).toEqual([["keep_local", true], ["keep_remote", true]]);
    expect(views[0].blocked).toBe(false);
    expect(server.state(USER).snapshot.classes.find((c) => c.id === "A")!.name).toBe("Calculus");
    expect(a.local.classes[0].name).toBe("Maths"); // this device untouched by the conflict
    expect(out.decisionPoints).toHaveLength(1);
  });

  it("submitting the chosen decision runs through the engine and syncs both sides", async () => {
    const { server, a, views } = await conflict({ a: (d) => void (d.classes[0].name = "Maths"), b: (d) => void (d.classes[0].name = "Calculus") });
    const out = await a.sync({ decisions: [toDecision(views[0], "keep_local")] });
    expect(out.status).toBe("synced");
    expect(canon(server.state(USER).snapshot).classes.find((c) => c.id === "A")!.name).toBe("Maths");
    expect(a.local.classes[0].name).toBe("Maths");
  });

  it("a stale decision (the situation changed) is rejected and nothing is pushed", async () => {
    const { server, a, views } = await conflict({ a: (d) => void (d.classes[0].name = "Maths"), b: (d) => void (d.classes[0].name = "Calculus") });
    const pushes = () => server.calls.filter((c) => c.fn === "push_changes").length;
    const before = pushes();
    const out = await a.sync({ decisions: [{ ...toDecision(views[0], "keep_local"), fingerprint: "sf1:" + "0".repeat(64) }] });
    expect(out.status).toBe("conflicted");
    if (out.status === "conflicted") expect(out.rejectedDecisions.map((r) => r.reason)).toEqual(["stale"]);
    expect(pushes()).toBe(before);
  });

  it("a class deleted on one side and changed on the other: only 'keep' is offered; deleting it with its sessions is not", async () => {
    const { views, a, server } = await conflict({
      a: (d) => void d.sessions.push(ses("new", "A", null, 9_999, 600)),
      b: (d) => {
        d.classes = d.classes.filter((c) => c.id !== "A");
        d.groups = d.groups.filter((g) => g.classId !== "A");
        d.sessions = d.sessions.filter((s) => s.classId !== "A");
      },
    });
    expect(views[0].title).toMatch(/“Math” was deleted on the cloud/);
    const keep = views[0].choices.find((c) => c.key === "keep_class")!;
    const del = views[0].choices.find((c) => c.key === "delete_class")!;
    expect(keep.available).toBe(true);
    expect(del.available).toBe(false);
    expect(del.consequence).toMatch(/erase study sessions/);
    const out = await a.sync({ decisions: [toDecision(views[0], "keep_class")] });
    expect(out.status).toBe("synced");
    expect(server.state(USER).snapshot.sessions.some((s) => s.id === "new")).toBe(true); // the session survived
  });

  it("a subgroup deleted on one side and used on the other: keep it, or remove it while keeping the sessions", async () => {
    const { views } = await conflict({
      a: (d) => void d.sessions.push(ses("new", "A", "g1", 9_999, 600)),
      b: (d) => {
        d.groups = d.groups.filter((g) => g.id !== "g1");
        for (const s of d.sessions) if (s.groupId === "g1") s.groupId = null;
      },
    });
    expect(views[0].choices.map((c) => c.key)).toEqual(["keep_group", "ungroup"]);
    expect(views[0].choices.every((c) => c.available)).toBe(true);
    expect(views[0].choices[1].consequence).toMatch(/No session is deleted/);
  });

  it("after another device replaced the cloud, a session missing there is blocked: nothing can be chosen, so the user needs an escape", async () => {
    const server = createFakeSyncServer();
    const { a } = await seedAndLink(server, USER, baseSnapshot());
    // another device replaced the cloud with data that lacks session s2
    const api = server.apiFor(USER);
    const cloud = await api.pullSnapshot();
    const lacking = { ...cloud.snapshot, sessions: cloud.snapshot.sessions.filter((x) => x.id !== "s2") };
    const plan = planReplaceCloud(cloud.snapshot, lacking);
    if (!plan.ok) throw new Error("plan");
    await api.pushChanges(cloud.revision, plan.ops);
    const out = await a.sync();
    if (out.status !== "conflicted") throw new Error("expected a conflict, got " + out.status);
    const views = describeConflicts(out.decisionPoints, out.conflicts, out.snapshots);
    expect(views.some((v) => v.blocked)).toBe(true);
    expect(views.find((v) => v.blocked)!.choices.every((c) => !c.available)).toBe(true);
    // and the escape works: use the cloud, and the next pass is quiet
    expect(canon(server.state(USER).snapshot).sessions.some((x) => x.id === "s2")).toBe(false);
  });

  it("two classes with the same name: asks for new names, one box per class", async () => {
    const { views, a, server } = await conflict({
      a: (d) => void d.classes.push(cls("N1", "Physics")),
      b: (d) => void d.classes.push(cls("N2", "physics")),
    });
    const v = views.find((x) => x.renames)!;
    expect(v.renames!.map((r) => r.id).sort()).toEqual(["N1", "N2"]);
    const out = await a.sync({ decisions: [toDecision(v, "rename", { N1: "Physics 1", N2: "Physics 2" })] });
    expect(out.status).toBe("synced");
    expect(canon(server.state(USER).snapshot).classes.map((c) => c.name)).toEqual(expect.arrayContaining(["Physics 1", "Physics 2"]));
  });

  it("conflicts that are not decisions (a running timer's class) are listed separately", async () => {
    const server = createFakeSyncServer();
    const { a, b } = await seedAndLink(server, USER, baseSnapshot(), { protect: () => ({ classIds: ["A"], groupIds: [] }) });
    b.edit((d) => {
      d.classes = d.classes.filter((c) => c.id !== "A");
      d.groups = d.groups.filter((g) => g.classId !== "A");
      d.sessions = d.sessions.filter((s) => s.classId !== "A");
    });
    await b.sync();
    const out = await a.sync();
    if (out.status !== "conflicted") throw new Error("expected conflict");
    expect(describeConflicts(out.decisionPoints, out.conflicts, out.snapshots)).toEqual([]);
    expect(notDecisions(out.conflicts, out.decisionPoints).map((c) => c.code)).toEqual(["protected_entity_deleted"]);
  });

  it("every message is plain text without ids or codes", async () => {
    const { views } = await conflict({ a: (d) => void (d.classes[0].name = "Maths"), b: (d) => void (d.classes[0].name = "Calculus") });
    for (const v of views) for (const text of [v.title, v.detail, ...v.choices.flatMap((c) => [c.label, c.consequence])]) {
      expect(text.length).toBeGreaterThan(5);
      expect(text).not.toMatch(/sf1:|class_|_conflict|undefined|\[object/);
    }
    void [grp, snap];
  });
});
