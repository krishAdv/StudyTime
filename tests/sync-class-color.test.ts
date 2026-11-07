import { describe, expect, it } from "vitest";
import { createFakeSyncServer, type FakeSyncServer } from "./helpers/fake-sync-server";
import { baseSnapshot } from "./helpers/merge-fixtures";
import { seedAndLink } from "./helpers/sync-device";
import { canon } from "./helpers/sync-plan-harness";
import { createClass, updateClassIn } from "@/lib/class-rules";
import { describeConflicts } from "@/lib/sync/conflict-text";

/** Class colors chosen in the app travel through the existing sync ops (add_class / update_class with `color`). */

const USER = "u1";
const serverData = (server: FakeSyncServer) => canon(server.state(USER).snapshot);
const colorOf = (d: { classes: { id: string; color: string }[] }, id: string) => d.classes.find((c) => c.id === id)?.color;
const pushes = (server: FakeSyncServer) => server.calls.filter((c) => c.fn === "push_changes").map((c) => c.args);

type Device = Awaited<ReturnType<typeof seedAndLink>>["a"];
/** Applies the same rule function the app's provider uses, as a new object (like the provider does). */
function recolor(device: Device, id: string, color: string) {
  const r = updateClassIn(device.local.classes, id, { color });
  if (!r.ok) throw new Error(r.error);
  device.setLocal({ ...device.local, classes: r.value });
}

describe("syncing class colors", () => {
  it("a color change on one device reaches the cloud and the other device as update_class", async () => {
    const server = createFakeSyncServer();
    const { a, b } = await seedAndLink(server, USER, baseSnapshot());
    recolor(a, "A", "#ef4444");
    expect((await a.sync()).status).toBe("synced");
    const ops = JSON.stringify(pushes(server).at(-1));
    expect(ops).toContain('"op":"update_class"');
    expect(ops).toContain('"color":"#ef4444"');
    expect(ops).not.toContain('"name"'); // only the color travels
    expect(colorOf(serverData(server), "A")).toBe("#ef4444");
    expect((await b.sync()).status).toBe("synced");
    expect(colorOf(b.local, "A")).toBe("#ef4444");
    expect(b.snapshot()).toEqual(serverData(server));
  });

  it("a new class's chosen color is uploaded with it", async () => {
    const server = createFakeSyncServer();
    const { a, b } = await seedAndLink(server, USER, baseSnapshot());
    const r = createClass(a.local.classes, "Biology", "C", "#84cc16");
    if (!r.ok) throw new Error(r.error);
    a.setLocal({ ...a.local, classes: r.value });
    expect((await a.sync()).status).toBe("synced");
    expect(colorOf(serverData(server), "C")).toBe("#84cc16");
    await b.sync();
    expect(colorOf(b.local, "C")).toBe("#84cc16");
  });

  it("a color change on one device and a rename on the other merge without a conflict", async () => {
    const server = createFakeSyncServer();
    const { a, b } = await seedAndLink(server, USER, baseSnapshot());
    recolor(a, "A", "#0ea5e9");
    const renamed = updateClassIn(b.local.classes, "A", { name: "Calculus" });
    if (!renamed.ok) throw new Error(renamed.error);
    b.setLocal({ ...b.local, classes: renamed.value });
    expect((await b.sync()).status).toBe("synced");
    expect((await a.sync()).status).toBe("synced");
    expect(serverData(server).classes.find((c) => c.id === "A")).toMatchObject({ name: "Calculus", color: "#0ea5e9" });
  });

  it("different colors picked on both devices are a conflict the user settles; nothing is pushed until then", async () => {
    const server = createFakeSyncServer();
    const { a, b } = await seedAndLink(server, USER, baseSnapshot());
    recolor(a, "A", "#ef4444");
    recolor(b, "A", "#10b981");
    await b.sync();
    const pushesBefore = pushes(server).length;
    const first = await a.sync();
    if (first.status !== "conflicted") throw new Error("expected a conflict");
    expect(first.conflicts.map((c) => [c.code, c.field])).toEqual([["class_field_conflict", "color"]]);
    expect(pushes(server)).toHaveLength(pushesBefore);
    expect(colorOf(a.local, "A")).toBe("#ef4444"); // nothing replaced while conflicted
    const [view] = describeConflicts(first.decisionPoints, first.conflicts, first.snapshots);
    expect(view.title).toContain("color of the class");
    expect(view.choices.map((c) => c.label)).toEqual(["Use this device’s color", "Use the cloud’s color"]);

    const decisions = first.decisionPoints.map((p) => ({ fingerprint: p.fingerprint, choice: "keep_remote" }));
    expect((await a.sync({ decisions })).status).toBe("synced");
    expect(colorOf(a.local, "A")).toBe("#10b981");
    expect(colorOf(serverData(server), "A")).toBe("#10b981");
  });

  it("the same color picked on both devices is not a conflict", async () => {
    const server = createFakeSyncServer();
    const { a, b } = await seedAndLink(server, USER, baseSnapshot());
    recolor(a, "A", "#6366f1");
    recolor(b, "A", "#6366f1");
    await b.sync();
    expect((await a.sync()).status).not.toBe("conflicted");
    expect(colorOf(serverData(server), "A")).toBe("#6366f1");
  });
});
