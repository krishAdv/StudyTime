// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthProvider } from "@/features/auth/auth-provider";
import { AccountBoundary } from "@/features/data/account-boundary";
import { useStudyData } from "@/features/data/study-data-provider";
import { SettingsProvider } from "@/features/settings/settings-provider";
import { SettingsView } from "@/features/settings/settings-view";
import { ThemeProvider } from "@/features/theme/theme-provider";
import { useTimer } from "@/features/timer/timer-provider";
import { accountKey } from "@/lib/account-store";
import { createLocalStorageStore } from "@/lib/data-store";
import { DATA_VERSION, RESET_MARKER_KEY, type StoredData } from "@/lib/storage";
import { createFakeAuth } from "./helpers/fake-auth";
import { createMemoryStorage } from "./helpers/memory-storage";

const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

const own = (id: string): StoredData => ({
  classes: [{ id: `c-${id}`, name: `Class ${id}`, color: "#10b981", groups: [] }],
  sessions: [],
});
const payload = (d: StoredData) => JSON.stringify({ version: DATA_VERSION, ...d });

function Probe() {
  const timer = useTimer();
  const data = useStudyData();
  return (
    <div>
      <p data-testid="timer">{timer.state.status}</p>
      <p data-testid="sessions">{data.sessions.length}</p>
      <button onClick={() => timer.setClassId(data.classes[0]?.id ?? "")}>pick</button>
      <button onClick={() => timer.start()}>start</button>
      <button onClick={() => timer.stop()}>stop</button>
    </div>
  );
}

function setup(ui: React.ReactNode = <Probe />) {
  const storage = createMemoryStorage({
    [RESET_MARKER_KEY]: "done",
    [accountKey("user-a", "data")]: payload(own("a")),
    [accountKey("user-b", "data")]: payload(own("b")),
  });
  const auth = createFakeAuth(
    [{ id: "user-a", email: "a@example.com", password: "pw-a" }],
    { user: { id: "user-a", email: "a@example.com" } },
  );
  render(
    <ThemeProvider>
      <SettingsProvider>
        <AuthProvider client={auth.client}>
          <AccountBoundary legacyStore={createLocalStorageStore(() => storage)} getStorage={() => storage}>
            {ui}
          </AccountBoundary>
        </AuthProvider>
      </SettingsProvider>
    </ThemeProvider>,
  );
  return { storage, auth };
}

const startTimer = () => {
  fireEvent.click(screen.getByText("pick"));
  fireEvent.click(screen.getByText("start"));
};
const sessionsIn = (storage: ReturnType<typeof createMemoryStorage>, id: string) =>
  (JSON.parse(storage.map.get(accountKey(id, "data")) ?? "{}").sessions ?? []).length;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(new Date(2026, 9, 27, 12, 0, 0));
  window.matchMedia ??= (() => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
  })) as unknown as typeof window.matchMedia;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("a running timer belongs to one account", () => {
  it("stopping in the same account saves into that account's bucket only", async () => {
    const { storage } = setup();
    await flush();
    startTimer();
    expect(screen.getByTestId("timer").textContent).toBe("running");
    act(() => void vi.advanceTimersByTime(90_000));
    fireEvent.click(screen.getByText("stop"));
    expect(sessionsIn(storage, "user-a")).toBe(1);
    expect(sessionsIn(storage, "user-b")).toBe(0);
  });

  it("a switch to another account never carries the timer over or saves into the new account", async () => {
    const { storage, auth } = setup();
    await flush();
    startTimer();
    act(() => void vi.advanceTimersByTime(60_000));
    await act(async () => void auth.signInAs("user-b")); // another tab signed in as someone else
    expect(screen.getByTestId("timer").textContent).toBe("idle");
    expect(screen.getByTestId("sessions").textContent).toBe("0");
    act(() => void vi.advanceTimersByTime(60_000));
    fireEvent.click(screen.getByText("stop")); // nothing to stop in this account
    expect(sessionsIn(storage, "user-b")).toBe(0);
    expect(sessionsIn(storage, "user-a")).toBe(0);
  });

  it("an involuntary sign-out ends the timer without saving it anywhere, and sign-in elsewhere shows no session", async () => {
    const { storage, auth } = setup();
    await flush();
    startTimer();
    act(() => void vi.advanceTimersByTime(60_000));
    await act(async () => void auth.signOutEvent());
    await act(async () => void auth.signInAs("user-b"));
    expect(screen.getByTestId("timer").textContent).toBe("idle");
    expect(sessionsIn(storage, "user-a")).toBe(0);
    expect(sessionsIn(storage, "user-b")).toBe(0);
  });

  it("signing back in as the original account does not resurrect the old timer", async () => {
    const { auth } = setup();
    await flush();
    startTimer();
    await act(async () => void auth.signOutEvent());
    await act(async () => void auth.signInAs("user-a"));
    expect(screen.getByTestId("timer").textContent).toBe("idle");
  });
});

describe("signing out from Settings", () => {
  it("is blocked while a timer is running or paused, and allowed once it is stopped", async () => {
    function Controls() {
      const timer = useTimer();
      const data = useStudyData();
      return (
        <>
          <button onClick={() => timer.setClassId(data.classes[0].id)}>pick</button>
          <button onClick={() => timer.start()}>start</button>
          <button onClick={() => timer.pause()}>pause</button>
          <button onClick={() => timer.stop()}>stop</button>
        </>
      );
    }
    const { auth } = setup(
      <>
        <Controls />
        <SettingsView />
      </>,
    );
    await flush();
    const signOutButton = () => screen.getByRole("button", { name: /Sign out/ }) as HTMLButtonElement;
    expect(signOutButton().disabled).toBe(false);

    fireEvent.click(screen.getByText("pick"));
    fireEvent.click(screen.getByText("start"));
    expect(signOutButton().disabled).toBe(true);
    expect(screen.getByText(/Stop the running timer before signing out/)).toBeTruthy();
    fireEvent.click(signOutButton());
    expect(auth.auth.signOut).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText("pause"));
    expect(signOutButton().disabled).toBe(true);

    fireEvent.click(screen.getByText("stop"));
    expect(signOutButton().disabled).toBe(false);
    fireEvent.click(signOutButton());
    await flush();
    expect(auth.auth.signOut).toHaveBeenCalledWith({ scope: "local" });
  });
});
