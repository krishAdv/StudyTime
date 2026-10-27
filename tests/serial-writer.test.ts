import { describe, expect, it, vi } from "vitest";
import { createSerialWriter } from "@/lib/serial-writer";

function deferred() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("createSerialWriter", () => {
  it("runs a synchronous write inside submit", () => {
    const written: number[] = [];
    const failures: boolean[] = [];
    const w = createSerialWriter<number>((n) => void written.push(n), (f) => failures.push(f));
    w.submit(1);
    w.submit(2);
    expect(written).toEqual([1, 2]);
    expect(failures).toEqual([]);
  });

  it("never overlaps writes and writes the newest waiting snapshot after the one in flight", async () => {
    const gates = [deferred(), deferred(), deferred()];
    const started: number[] = [];
    let running = 0;
    let maxRunning = 0;
    const w = createSerialWriter<number>(async (n) => {
      started.push(n);
      running++;
      maxRunning = Math.max(maxRunning, running);
      await gates[started.length - 1].promise;
      running--;
    });
    w.submit(1);
    w.submit(2);
    w.submit(3);
    expect(started).toEqual([1]);
    gates[0].resolve();
    await tick();
    expect(started).toEqual([1, 3]); // 2 was superseded, 3 is the newest
    gates[1].resolve();
    await tick();
    expect(started).toEqual([1, 3]);
    expect(maxRunning).toBe(1);
  });

  it("keeps a failed snapshot flagged, and retry writes the latest again", async () => {
    const failures: boolean[] = [];
    const attempts: number[] = [];
    let fail = true;
    const w = createSerialWriter<number>(
      async (n) => {
        attempts.push(n);
        if (fail) throw new Error("offline");
      },
      (f) => failures.push(f),
    );
    w.submit(1);
    await tick();
    expect(failures).toEqual([true]);
    fail = false;
    w.retry();
    await tick();
    expect(attempts).toEqual([1, 1]);
    expect(failures).toEqual([true, false]);
  });

  it("a newer submit after a failure supersedes it and clears the failure", async () => {
    const failures: boolean[] = [];
    const attempts: number[] = [];
    let fail = true;
    const w = createSerialWriter<number>(
      async (n) => {
        attempts.push(n);
        if (fail) throw new Error("offline");
      },
      (f) => failures.push(f),
    );
    w.submit(1);
    await tick();
    fail = false;
    w.submit(2);
    await tick();
    expect(attempts).toEqual([1, 2]);
    expect(failures).toEqual([true, false]);
  });

  it("a snapshot submitted while a write fails is still attempted", async () => {
    const first = deferred();
    const attempts: number[] = [];
    const w = createSerialWriter<number>((n) => {
      attempts.push(n);
      return attempts.length === 1 ? first.promise : Promise.resolve();
    });
    w.submit(1);
    w.submit(2);
    first.reject(new Error("offline"));
    await tick();
    expect(attempts).toEqual([1, 2]);
  });

  it("treats a synchronous throw as a failure that retry can recover", () => {
    const failures: boolean[] = [];
    let fail = true;
    const write = vi.fn(() => {
      if (fail) throw new Error("quota");
    });
    const w = createSerialWriter<number>(write, (f) => failures.push(f));
    w.submit(1);
    expect(failures).toEqual([true]);
    fail = false;
    w.retry();
    expect(write).toHaveBeenCalledTimes(2);
    expect(failures).toEqual([true, false]);
  });

  it("retry does nothing when nothing failed", () => {
    const write = vi.fn();
    const w = createSerialWriter<number>(write);
    w.retry();
    w.submit(1);
    w.retry();
    expect(write).toHaveBeenCalledTimes(1);
  });
});
