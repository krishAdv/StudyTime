// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthRetryableFetchError } from "@supabase/supabase-js";
import { AuthProvider, LAST_USER_KEY } from "@/features/auth/auth-provider";
import { AccountBoundary } from "@/features/data/account-boundary";
import { StudyDataProvider, useStudyData } from "@/features/data/study-data-provider";
import { SettingsProvider } from "@/features/settings/settings-provider";
import { SyncProvider, useSync } from "@/features/sync/sync-provider";
import { TimerCard } from "@/features/timer/timer-card";
import { PERSIST_WARNING, TimerProvider, useTimer } from "@/features/timer/timer-provider";
import { accountKey, createAccountStore } from "@/lib/account-store";
import { parseActiveRecord } from "@/lib/active-session";
import { saveBaseline, saveSyncEnabled } from "@/lib/sync/device-store";
import { fromSyncSnapshot } from "@/lib/sync/from-snapshot";
import { DATA_VERSION, serializeData, type StoredData } from "@/lib/storage";
import type { Session } from "@/lib/types";
import { createFakeAuth } from "./helpers/fake-auth";
import { createFakeSyncServer } from "./helpers/fake-sync-server";
import { baseSnapshot } from "./helpers/merge-fixtures";
import { createMemoryStorage, type MemoryStorage } from "./helpers/memory-storage";
import { canon, seed } from "./helpers/sync-plan-harness";

/**
 * A running session must survive the page being reloaded or killed (iOS discards a backgrounded web app's page;
 * reopening it starts the app from scratch). "Closing the app" here is unmounting every provider; "reopening" is
 * mounting a fresh tree on the same storage, exactly like a new page load.
 */

const USER = "user-a";
const EMAIL = "her@example.com";
const T0 = new Date(2026, 10, 9, 9, 0, 0).getTime();
const MIN = 60_000;
const HOUR = 60 * MIN;
const ACTIVE = accountKey(USER, "active-session");
const DATA = accountKey(USER, "data");

afterEach(cleanup);
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(T0);
});
afterEach(() => vi.useRealTimers());

const classes: StoredData["classes"] = [
  { id: "math", name: "Math", color: "#3b82f6", groups: [{ id: "alg", name: "Algebra" }] },
  { id: "art", name: "Art", color: "#8b5cf6", groups: [] },
];
const freshStorage = (sessions: Session[] = []) =>
  createMemoryStorage({ [DATA]: JSON.stringify({ version: DATA_VERSION, classes, sessions }) });

const storedSessions = (mem: MemoryStorage): Session[] => JSON.parse(mem.map.get(DATA) ?? "{}").sessions ?? [];
const storedRecord = (mem: MemoryStorage) => parseActiveRecord(mem.map.get(ACTIVE) ?? null);

type Handle = { timer: ReturnType<typeof useTimer>; data: ReturnType<typeof useStudyData> };
function Probe({ report }: { report: (h: Handle) => void }) {
  const timer = useTimer();
  const data = useStudyData();
  report({ timer, data });
  return <p data-testid="status">{timer.state.status}</p>;
}

/** Opens the whole app (auth → account boundary → data → timer) on `mem`, signed in as USER by default. */
function openApp(mem: MemoryStorage, opts: { auth?: ReturnType<typeof createFakeAuth> } = {}) {
  const auth = opts.auth ?? createFakeAuth([], { user: { id: USER, email: EMAIL } });
  const handleRef: { current: Handle | null } = { current: null };
  const view = render(
    <SettingsProvider>
      <AuthProvider client={auth.client} getStorage={() => mem}>
        <AccountBoundary getStorage={() => mem}>
          <Probe report={(v) => void (handleRef.current = v)} />
        </AccountBoundary>
      </AuthProvider>
    </SettingsProvider>,
  );
  const h = () => {
    if (!handleRef.current) throw new Error("the app is not showing study data");
    return handleRef.current;
  };
  return { auth, view, h, close: () => view.unmount() };
}

const settle = () => act(async () => void (await vi.advanceTimersByTimeAsync(0)));
const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));
/** Time passes while the app is closed: nothing is mounted, only the clock moves. */
const closedFor = (ms: number) => vi.setSystemTime(Date.now() + ms);

async function startTimer(h: () => Handle, opts: { classId?: string; groupId?: string; countdownMinutes?: number } = {}) {
  act(() => h().timer.setClassId(opts.classId ?? "math"));
  if (opts.groupId) act(() => h().timer.setGroupId(opts.groupId!));
  if (opts.countdownMinutes !== undefined) {
    act(() => h().timer.setMode("countdown"));
    act(() => h().timer.setDurationMinutes(opts.countdownMinutes!));
  }
  act(() => h().timer.start());
}

describe("starting a session persists it immediately", () => {
  it("the record is on disk as soon as Start returns, with id, start time, class, subgroup and mode", async () => {
    const mem = freshStorage();
    const app = openApp(mem);
    await settle();
    await startTimer(app.h, { groupId: "alg" });
    // No interval, effect or page-hide event has run yet.
    const r = storedRecord(mem);
    expect(r.active).toMatchObject({
      sessionId: app.h().timer.state.context!.sessionId,
      startedAt: T0,
      classId: "math",
      groupId: "alg",
      mode: "stopwatch",
      status: "running",
      accumulatedMs: 0,
      runStartedAt: T0,
      targetMs: null,
    });
  });
});

describe("reload and iOS killing the page", () => {
  it("a reload restores the running session with its class and subgroup, before any empty timer is shown", async () => {
    const mem = freshStorage();
    let app = openApp(mem);
    await settle();
    await startTimer(app.h, { groupId: "alg" });
    const id = app.h().timer.state.context!.sessionId;
    await advance(5 * MIN);
    app.close();

    app = openApp(mem);
    await settle();
    const t = app.h().timer;
    expect(t.state.status).toBe("running");
    expect(t.state.context).toEqual({ sessionId: id, startedAt: T0, classId: "math", groupId: "alg" });
    expect(t.classId).toBe("math");
    expect(t.groupId).toBe("alg");
    expect(Math.round(t.elapsedMs / 1000)).toBe(5 * 60);
  });

  it("a stopwatch left running for an hour while the app was closed counts the full hour, from timestamps", async () => {
    const mem = freshStorage();
    let app = openApp(mem);
    await settle();
    await startTimer(app.h);
    await advance(2 * MIN);
    app.close(); // iOS terminates the page: no unload handler, no interval
    closedFor(HOUR);

    app = openApp(mem);
    await settle();
    expect(app.h().timer.state.status).toBe("running");
    expect(Math.round(app.h().timer.elapsedMs / 1000)).toBe(62 * 60);
    await advance(MIN);
    act(() => app.h().timer.stop());
    const saved = storedSessions(mem);
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ classId: "math", startedAt: T0, seconds: 63 * 60, mode: "stopwatch" });
    expect(mem.map.has(ACTIVE)).toBe(false);
  });

  it("a countdown that ended while the app was closed is logged with its full length on reopen, once", async () => {
    const mem = freshStorage();
    let app = openApp(mem);
    await settle();
    await startTimer(app.h, { countdownMinutes: 25 });
    await advance(MIN);
    app.close();
    closedFor(HOUR);

    app = openApp(mem);
    await settle(); // sign-in resolves and the timer mounts
    await advance(10); // its first tick runs right after mount, before any interval
    expect(app.h().timer.state.status).toBe("idle");
    expect(app.h().timer.state.message).toBe("Session complete. 25m logged.");
    expect(storedSessions(mem)).toEqual([expect.objectContaining({ seconds: 25 * 60, mode: "countdown", startedAt: T0 })]);
    expect(mem.map.has(ACTIVE)).toBe(false);

    app.close();
    app = openApp(mem);
    await settle();
    expect(storedSessions(mem)).toHaveLength(1);
  });

  it("a countdown still running is restored with the right time left and completes on time", async () => {
    const mem = freshStorage();
    let app = openApp(mem);
    await settle();
    await startTimer(app.h, { countdownMinutes: 7 }); // a custom length
    app.close();
    closedFor(3 * MIN);

    app = openApp(mem);
    await settle();
    const t = app.h().timer;
    expect(t.state).toMatchObject({ status: "running", mode: "countdown", targetMs: 7 * MIN });
    expect(Math.round(t.displayMs / 1000)).toBe(4 * 60);
    await advance(4 * MIN + 500);
    expect(app.h().timer.state.status).toBe("idle");
    expect(storedSessions(mem)).toEqual([expect.objectContaining({ seconds: 7 * 60, mode: "countdown" })]);
  });

  it("a paused session stays paused: the closed time is not counted, and resuming continues from there", async () => {
    const mem = freshStorage();
    let app = openApp(mem);
    await settle();
    await startTimer(app.h);
    await advance(10 * MIN);
    act(() => app.h().timer.pause());
    app.close();
    closedFor(HOUR);

    app = openApp(mem);
    await settle();
    expect(app.h().timer.state.status).toBe("paused");
    expect(Math.round(app.h().timer.elapsedMs / 1000)).toBe(10 * 60);
    act(() => app.h().timer.resume());
    await advance(5 * MIN);
    app.close(); // killed again while running after the resume
    closedFor(5 * MIN);

    app = openApp(mem);
    await settle();
    expect(Math.round(app.h().timer.elapsedMs / 1000)).toBe(20 * 60);
    act(() => app.h().timer.stop());
    expect(storedSessions(mem)).toEqual([expect.objectContaining({ seconds: 20 * 60, startedAt: T0 })]);
  });

  it("a paused countdown keeps its length and remaining time", async () => {
    const mem = freshStorage();
    let app = openApp(mem);
    await settle();
    await startTimer(app.h, { countdownMinutes: 30 });
    await advance(12 * MIN);
    act(() => app.h().timer.pause());
    app.close();
    closedFor(2 * HOUR);

    app = openApp(mem);
    await settle();
    expect(app.h().timer.state).toMatchObject({ status: "paused", targetMs: 30 * MIN });
    expect(Math.round(app.h().timer.displayMs / 1000)).toBe(18 * 60);
  });

  it("an unreadable record is ignored and the timer starts empty", async () => {
    const mem = freshStorage();
    mem.map.set(ACTIVE, "{not json");
    const app = openApp(mem);
    await settle();
    expect(app.h().timer.state.status).toBe("idle");
  });
});

describe("authentication and the network", () => {
  it("while sign-in is still being checked nothing is cleared, and the session comes back once it resolves", async () => {
    const mem = freshStorage();
    let app = openApp(mem);
    await settle();
    await startTimer(app.h);
    app.close();
    closedFor(HOUR);
    const before = mem.map.get(ACTIVE);

    const auth = createFakeAuth([], null);
    auth.auth.getSession.mockImplementation(() => new Promise(() => {})); // a slow network: never answers
    app = openApp(mem, { auth });
    await advance(30_000);
    expect(screen.getByText(/Checking sign-in/)).toBeTruthy();
    expect(mem.map.get(ACTIVE)).toBe(before); // untouched while loading
    expect(mem.writes.filter((w) => w.endsWith(ACTIVE))).toHaveLength(1); // only the Start write, earlier

    await act(async () => void auth.signInAs(USER, EMAIL)); // e.g. the token refresh finally answered
    expect(app.h().timer.state.status).toBe("running");
    expect(Math.round(app.h().timer.elapsedMs / 1000)).toBe(HOUR / 1000 + 30);
  });

  /** supabase-js reopened without a usable session: `error` is what getSession returns (see AuthProvider). */
  const noSession = (error: unknown) => {
    const auth = createFakeAuth([], null);
    auth.auth.getSession.mockResolvedValue({ data: { session: null }, error } as never);
    return auth;
  };
  const offline = () => new AuthRetryableFetchError("Failed to fetch", 0);

  it("offline with an expired access token: still signed in as the account last seen here, and the timer is restored", async () => {
    const mem = freshStorage();
    let app = openApp(mem); // signed in normally: the account is remembered
    await settle();
    expect(JSON.parse(mem.map.get(LAST_USER_KEY)!)).toEqual({ id: USER, email: EMAIL });
    await startTimer(app.h);
    app.close();
    closedFor(HOUR);

    // supabase-js offline after an hour: it can't refresh, sends INITIAL_SESSION null and getSession returns no
    // session with an AuthRetryableFetchError (it keeps the stored session and refreshes it once back online).
    const auth = noSession(offline());
    app = openApp(mem, { auth });
    await act(async () => void auth.emit("INITIAL_SESSION", null));
    await settle();
    expect(app.h().timer.state.status).toBe("running");
    expect(Math.round(app.h().timer.elapsedMs / 1000)).toBe(HOUR / 1000);

    // The refresh succeeds later: same account, nothing remounts, the timer keeps going.
    const timerBefore = app.h().timer.state;
    await act(async () => void auth.emit("TOKEN_REFRESHED", { user: { id: USER, email: EMAIL } }));
    expect(app.h().timer.state).toBe(timerBefore);
  });

  it("offline, but no account was ever seen signed in here: the sign-in screen, as before", async () => {
    const mem = freshStorage();
    openApp(mem, { auth: noSession(offline()) });
    await settle();
    expect(screen.queryByTestId("status")).toBeNull();
    expect(screen.queryByText(/Checking sign-in/)).toBeNull();
  });

  it("a rejected session (non-network error) or nothing stored is signed out, and forgets the account", async () => {
    for (const error of [{ name: "AuthApiError", status: 400, __isAuthError: true }, null]) {
      const mem = freshStorage();
      mem.map.set(LAST_USER_KEY, JSON.stringify({ id: USER, email: EMAIL }));
      const app = openApp(mem, { auth: noSession(error) });
      await settle();
      expect(screen.queryByTestId("status")).toBeNull();
      expect(mem.map.has(LAST_USER_KEY)).toBe(false);
      app.close();
    }
  });

  it("a real sign-out (SIGNED_OUT) shows the sign-in wall and forgets the account", async () => {
    const mem = freshStorage();
    const auth = createFakeAuth([], { user: { id: USER, email: EMAIL } });
    openApp(mem, { auth });
    await settle();
    expect(mem.map.has(LAST_USER_KEY)).toBe(true);
    await act(async () => void auth.signOutEvent());
    expect(screen.queryByTestId("status")).toBeNull();
    expect(mem.map.has(LAST_USER_KEY)).toBe(false);
  });

  it("another account on the same device never sees this account's active session", async () => {
    const mem = freshStorage();
    let app = openApp(mem);
    await settle();
    await startTimer(app.h);
    app.close();
    mem.map.set(accountKey("user-b", "data"), serializeData({ classes, sessions: [] }));
    app = openApp(mem, { auth: createFakeAuth([], { user: { id: "user-b", email: "b@example.com" } }) });
    await settle();
    expect(app.h().timer.state.status).toBe("idle");
    expect(mem.map.has(ACTIVE)).toBe(true); // still kept for user-a
  });
});

describe("completion is recorded exactly once", () => {
  it("the finished session is written to the record before the data, and the record is cleared only after", async () => {
    const mem = freshStorage();
    const app = openApp(mem);
    await settle();
    await startTimer(app.h);
    await advance(3 * MIN);
    mem.writes.length = 0;
    act(() => app.h().timer.stop());
    expect(mem.writes.slice(0, 3)).toEqual([`set:${ACTIVE}`, `set:${DATA}`, `remove:${ACTIVE}`]);
    // The provider's usual save after the re-render writes the same data again; nothing else is written.
    expect(mem.writes.slice(3).every((w) => w === `set:${DATA}`)).toBe(true);
  });

  it("killed after the record was marked finished but before the data was saved: added on the next start", async () => {
    const session: Session = { id: "session-x", classId: "math", groupId: "alg", startedAt: T0, seconds: 1500, mode: "stopwatch" };
    const mem = freshStorage();
    mem.map.set(ACTIVE, JSON.stringify({ version: 1, active: null, unsaved: [session] }));
    let app = openApp(mem);
    await settle();
    expect(storedSessions(mem)).toEqual([session]);
    expect(mem.map.has(ACTIVE)).toBe(false);
    app.close();
    app = openApp(mem);
    await settle();
    expect(storedSessions(mem)).toEqual([session]);
  });

  it("killed after the data was saved but before the record was cleared: no duplicate", async () => {
    const session: Session = { id: "session-x", classId: "math", groupId: null, startedAt: T0, seconds: 1500, mode: "stopwatch" };
    const mem = freshStorage([session]);
    mem.map.set(ACTIVE, JSON.stringify({ version: 1, active: null, unsaved: [{ ...session, seconds: 999 }] }));
    const app = openApp(mem);
    await settle();
    expect(storedSessions(mem)).toEqual([session]);
    expect(mem.map.has(ACTIVE)).toBe(false);
    expect(app.h().data.sessions).toHaveLength(1);
  });

  it("Stop twice, or Stop racing a countdown's completion, saves one session", async () => {
    const mem = freshStorage();
    const app = openApp(mem);
    await settle();
    await startTimer(app.h, { countdownMinutes: 1 });
    await advance(59_999);
    act(() => {
      vi.setSystemTime(Date.now() + 2);
      app.h().timer.stop();
      app.h().timer.stop();
    });
    await advance(1_000);
    expect(storedSessions(mem)).toHaveLength(1);
  });

  it("a session whose class was deleted meanwhile is dropped and the record cleared", async () => {
    const mem = freshStorage();
    mem.map.set(
      ACTIVE,
      JSON.stringify({ version: 1, active: null, unsaved: [{ id: "s-gone", classId: "deleted", groupId: null, startedAt: T0, seconds: 60, mode: "stopwatch" }] }),
    );
    openApp(mem);
    await settle();
    expect(storedSessions(mem)).toHaveLength(0);
    expect(mem.map.has(ACTIVE)).toBe(false);
  });

  it("a stale tab keeps the finished session in the record; the next start adds it", async () => {
    const mem = freshStorage();
    let app = openApp(mem);
    await settle();
    await startTimer(app.h);
    await advance(4 * MIN);
    // Another tab of the same account changes the data: this tab becomes stale and can't save.
    const other = JSON.parse(mem.map.get(DATA)!);
    mem.map.set(DATA, JSON.stringify({ ...other, classes: [...other.classes, { id: "bio", name: "Bio", color: "#10b981", groups: [] }] }));
    act(() => void window.dispatchEvent(new StorageEvent("storage", { key: DATA })));
    expect(app.h().data.staleTab).toBe(true);
    act(() => app.h().timer.stop());
    expect(storedSessions(mem)).toHaveLength(0);
    expect(storedRecord(mem).unsaved).toHaveLength(1);

    app.close(); // the stale tab is reloaded
    app = openApp(mem);
    await settle();
    expect(storedSessions(mem)).toEqual([expect.objectContaining({ seconds: 4 * 60 })]);
    expect(JSON.parse(mem.map.get(DATA)!).classes.map((c: { id: string }) => c.id)).toContain("bio");
    expect(mem.map.has(ACTIVE)).toBe(false);
  });
});

/** Makes writes of the given keys throw, like a full or blocked localStorage. */
function failWrites(mem: MemoryStorage) {
  const failing = new Set<string>();
  const set = mem.setItem;
  const remove = mem.removeItem;
  mem.setItem = (k, v) => {
    if (failing.has(k)) throw new Error("QuotaExceededError");
    set(k, v);
  };
  mem.removeItem = (k) => {
    if (failing.has(k)) throw new Error("SecurityError");
    remove(k);
  };
  return failing;
}

describe("storage write failures are never silent", () => {
  it("a session that can't be persisted keeps running, with a warning that it would be lost; it clears once a write works", async () => {
    const mem = freshStorage();
    const failing = failWrites(mem);
    const app = openApp(mem);
    await settle();
    failing.add(ACTIVE);
    await startTimer(app.h);
    expect(app.h().timer.state.status).toBe("running"); // the timer still works
    expect(app.h().timer.persistWarning).toBe(PERSIST_WARNING);
    expect(mem.map.has(ACTIVE)).toBe(false); // nothing on disk, and nothing claims otherwise
    await advance(MIN);
    act(() => app.h().timer.pause());
    expect(app.h().timer.persistWarning).toBe(PERSIST_WARNING); // retried with the change, still failing

    failing.delete(ACTIVE);
    act(() => app.h().timer.resume());
    expect(app.h().timer.persistWarning).toBeNull();
    expect(storedRecord(mem).active).toMatchObject({ status: "running", accumulatedMs: MIN });
  });

  it("the write is retried when the app goes to the background (before iOS may close it)", async () => {
    const mem = freshStorage();
    const failing = failWrites(mem);
    const app = openApp(mem);
    await settle();
    failing.add(ACTIVE);
    await startTimer(app.h);
    expect(app.h().timer.persistWarning).toBe(PERSIST_WARNING);
    failing.delete(ACTIVE); // e.g. space was freed
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    expect(app.h().timer.persistWarning).toBeNull();
    expect(storedRecord(mem).active?.sessionId).toBe(app.h().timer.state.context!.sessionId);
  });

  it("the warning is shown on the timer card", async () => {
    const mem = freshStorage();
    const failing = failWrites(mem);
    const handleRef: { current: Handle | null } = { current: null };
    render(
      <SettingsProvider>
        <AuthProvider client={createFakeAuth([], { user: { id: USER, email: EMAIL } }).client} getStorage={() => mem}>
          <AccountBoundary getStorage={() => mem}>
            <Probe report={(v) => void (handleRef.current = v)} />
            <TimerCard />
          </AccountBoundary>
        </AuthProvider>
      </SettingsProvider>,
    );
    await settle();
    failing.add(ACTIVE);
    await startTimer(() => handleRef.current!);
    expect(screen.getByRole("alert").textContent).toBe(PERSIST_WARNING);
  });

  it("no warning while idle, or when the writes work", async () => {
    const mem = freshStorage();
    const app = openApp(mem);
    await settle();
    expect(app.h().timer.persistWarning).toBeNull();
    await startTimer(app.h);
    expect(app.h().timer.persistWarning).toBeNull();
  });

  it("a finished session whose data save failed stays in the record, the save error is shown, and Retry saves it once", async () => {
    const mem = freshStorage();
    const failing = failWrites(mem);
    const app = openApp(mem);
    await settle();
    await startTimer(app.h);
    await advance(6 * MIN);
    failing.add(DATA);
    act(() => app.h().timer.stop());
    expect(app.h().data.saveError).toBe(true); // "Your latest changes haven't been saved yet" + Retry save
    expect(storedSessions(mem)).toHaveLength(0);
    const unsaved = storedRecord(mem).unsaved;
    expect(unsaved).toEqual([expect.objectContaining({ seconds: 6 * 60 })]); // still recoverable after a reload

    failing.delete(DATA);
    act(() => app.h().data.retrySave());
    await settle();
    expect(app.h().data.saveError).toBe(false);
    expect(storedSessions(mem)).toEqual([expect.objectContaining({ id: unsaved[0].id, seconds: 6 * 60 })]);
    expect(mem.map.has(ACTIVE)).toBe(false);
  });

  it("a record that couldn't be cleared after its session was saved doesn't bring that session back", async () => {
    const mem = freshStorage();
    const failing = failWrites(mem);
    let app = openApp(mem);
    await settle();
    await startTimer(app.h);
    const id = app.h().timer.state.context!.sessionId;
    await advance(3 * MIN);
    failing.add(ACTIVE); // the record can't be updated or removed any more
    act(() => app.h().timer.stop());
    expect(storedSessions(mem).map((s) => s.id)).toEqual([id]);
    expect(storedRecord(mem).active?.sessionId).toBe(id); // the old running record is still on disk
    app.close();

    failing.delete(ACTIVE);
    app = openApp(mem);
    await settle();
    expect(app.h().timer.state.status).toBe("idle");
    expect(storedSessions(mem).map((s) => s.id)).toEqual([id]);
    expect(mem.map.has(ACTIVE)).toBe(false);
  });
});

describe("two tabs of the same account", () => {
  it("a tab follows a stop made in another tab and never brings the stopped session back", async () => {
    const mem = freshStorage();
    const a = openApp(mem);
    await settle();
    await startTimer(a.h);
    const b = openApp(mem); // second tab opened while the session runs: it shows the same session
    await settle();
    const [ha, hb] = [a.h, b.h];
    expect(hb().timer.state.status).toBe("running");
    await advance(2 * MIN);
    act(() => ha().timer.stop());
    // tab B gets the storage event
    act(() => void window.dispatchEvent(new StorageEvent("storage", { key: ACTIVE })));
    expect(hb().timer.state.status).toBe("idle");
    act(() => hb().timer.pause());
    expect(mem.map.has(ACTIVE)).toBe(false);
  });

  it("without a storage event (a suspended Safari tab) an action first re-reads the record and adopts it", async () => {
    const mem = freshStorage();
    const a = openApp(mem);
    await settle();
    await startTimer(a.h);
    const b = openApp(mem);
    await settle();
    await advance(MIN);
    act(() => a.h().timer.stop());
    act(() => b.h().timer.pause()); // no event delivered: pause must not write the stopped session back
    expect(b.h().timer.state.status).toBe("idle");
    expect(mem.map.has(ACTIVE)).toBe(false);
  });
});

function SyncProbe({ report }: { report: (h: Handle & { sync: ReturnType<typeof useSync> }) => void }) {
  report({ timer: useTimer(), data: useStudyData(), sync: useSync() });
  return null;
}

describe("a recovered session syncs like any other", () => {
  it("completed after a reload (offline at first), it reaches the cloud once and is never duplicated", async () => {
    const server = createFakeSyncServer();
    const pulled = await seed(server, USER, baseSnapshot());
    const initial = fromSyncSnapshot(pulled.snapshot);
    if (!initial.ok) throw new Error("bad seed");
    const mem = createMemoryStorage({ [DATA]: serializeData(initial.data) });
    saveBaseline(mem, USER, pulled);
    saveSyncEnabled(mem, USER, true);
    const getStorage = () => mem;

    const open = () => {
      const handleRef: { current: (Handle & { sync: ReturnType<typeof useSync> }) | null } = { current: null };
      const report = (v: Handle & { sync: ReturnType<typeof useSync> }) => void (handleRef.current = v);
      const view = render(
        <SettingsProvider>
          <StudyDataProvider store={createAccountStore(USER, getStorage)}>
            <TimerProvider persistKey={ACTIVE} getStorage={getStorage}>
              <SyncProvider userId={USER} api={server.apiFor(USER)} getStorage={getStorage} buildEnabled>
                <SyncProbe report={report} />
              </SyncProvider>
            </TimerProvider>
          </StudyDataProvider>
        </SettingsProvider>,
      );
      return { h: () => handleRef.current!, close: () => view.unmount() };
    };

    let app = open();
    await advance(10);
    act(() => app.h().timer.setClassId("B"));
    act(() => app.h().timer.start());
    const id = app.h().timer.state.context!.sessionId;
    await advance(MIN);
    app.close();
    closedFor(HOUR);

    server.setMode("network_down");
    app = open();
    await advance(10);
    expect(app.h().timer.state.status).toBe("running");
    act(() => app.h().timer.stop());
    await advance(3_500);
    expect(app.h().data.sessions.filter((s) => s.id === id)).toHaveLength(1); // kept locally while offline
    expect(canon(server.state(USER).snapshot).sessions.map((s) => s.id)).not.toContain(id);

    server.setMode("normal");
    act(() => void window.dispatchEvent(new Event("online")));
    await advance(3_500);
    await act(async () => void (await app.h().sync.syncNow())); // a retried pass changes nothing
    const onServer = canon(server.state(USER).snapshot).sessions.filter((s) => s.id === id);
    expect(onServer).toHaveLength(1);
    expect(onServer[0]).toMatchObject({ classId: "B", seconds: 61 * 60, mode: "stopwatch" });

    app.close(); // reopening never adds it again
    app = open();
    await advance(3_500);
    expect(app.h().data.sessions.filter((s) => s.id === id)).toHaveLength(1);
    expect(canon(server.state(USER).snapshot).sessions.filter((s) => s.id === id)).toHaveLength(1);
    expect(mem.map.has(ACTIVE)).toBe(false);
  });
});
