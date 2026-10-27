// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { StudyDataProvider, useStudyData } from "@/features/data/study-data-provider";
import { DataTransferCard } from "@/features/settings/data-transfer";
import { SettingsProvider } from "@/features/settings/settings-provider";
import { TimerProvider, useTimer } from "@/features/timer/timer-provider";
import { createLocalStorageStore, type StorageLike, type StudyDataStore } from "@/lib/data-store";
import { serializeExport } from "@/lib/data-export";
import { DATA_KEY, DATA_VERSION, RESET_MARKER_KEY, type StoredData } from "@/lib/storage";

afterEach(cleanup);

// jsdom has no <dialog> modal support; model just enough of it for the confirm dialog.
beforeAll(() => {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.removeAttribute("open");
  };
});

const CURRENT: StoredData = {
  classes: [{ id: "c-old", name: "Old class", color: "#3b82f6", groups: [] }],
  sessions: [{ id: "s-old", classId: "c-old", groupId: null, startedAt: 1_700_000_000_000, seconds: 90, mode: "stopwatch" }],
};
const INCOMING: StoredData = {
  classes: [{ id: "c-new", name: "Biology", color: "#10b981", groups: [{ id: "g-new", name: "Cells" }] }],
  sessions: [{ id: "s-new", classId: "c-new", groupId: "g-new", startedAt: 1_700_000_500_000, seconds: 1200, mode: "countdown" }],
};

function fakeStorage(seed: StoredData) {
  const map = new Map<string, string>([
    [RESET_MARKER_KEY, "done"],
    [DATA_KEY, JSON.stringify({ version: DATA_VERSION, ...seed })],
    ["studytime-theme", "dark"],
    ["studytime:countdown-minutes", "25"],
  ]);
  const storage: StorageLike & { map: Map<string, string> } = {
    map,
    getItem: (k) => map.get(k) ?? null,
    setItem: (k, v) => void map.set(k, v),
    removeItem: (k) => void map.delete(k),
  };
  return storage;
}
const stored = (s: { map: Map<string, string> }) => JSON.parse(s.map.get(DATA_KEY)!) as StoredData;

const flush = () =>
  act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });

describe("replaceAllData (provider)", () => {
  function setup(store: StudyDataStore) {
    return renderHook(() => useStudyData(), {
      wrapper: ({ children }) => <StudyDataProvider store={store}>{children}</StudyDataProvider>,
    });
  }

  it("replaces everything, keeps ids and relationships, and persists through the store", () => {
    const storage = fakeStorage(CURRENT);
    const { result } = setup(createLocalStorageStore(() => storage));
    let r!: ReturnType<typeof result.current.replaceAllData>;
    act(() => {
      r = result.current.replaceAllData(INCOMING);
    });
    expect(r.ok).toBe(true);
    expect(result.current.classes).toEqual(INCOMING.classes);
    expect(result.current.sessions).toEqual(INCOMING.sessions);
    expect(stored(storage)).toMatchObject(INCOMING);
    expect(storage.map.get("studytime-theme")).toBe("dark");
    expect(storage.map.get("studytime:countdown-minutes")).toBe("25");
  });

  it("rejects invalid data and leaves state and storage untouched", () => {
    const storage = fakeStorage(CURRENT);
    const { result } = setup(createLocalStorageStore(() => storage));
    const before = storage.map.get(DATA_KEY);
    const broken: StoredData = { classes: INCOMING.classes, sessions: [{ ...INCOMING.sessions[0], groupId: "ghost" }] };
    let r!: ReturnType<typeof result.current.replaceAllData>;
    act(() => {
      r = result.current.replaceAllData(broken);
    });
    expect(r.ok).toBe(false);
    expect(result.current.classes).toEqual(CURRENT.classes);
    expect(result.current.sessions).toEqual(CURRENT.sessions);
    expect(storage.map.get(DATA_KEY)).toBe(before);
  });

  it("is refused while loading, and nothing is saved", async () => {
    let resolve!: (d: StoredData) => void;
    const save = vi.fn();
    const { result } = setup({ load: () => new Promise<StoredData>((r) => (resolve = r)), save });
    let r!: ReturnType<typeof result.current.replaceAllData>;
    act(() => {
      r = result.current.replaceAllData(INCOMING);
    });
    expect(r.ok).toBe(false);
    resolve(CURRENT);
    await flush();
    expect(result.current.classes).toEqual(CURRENT.classes); // the refused import did not leak in
    expect(save).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledWith(CURRENT);
  });

  it("is refused after a failed load, and nothing is saved", async () => {
    const save = vi.fn();
    const { result } = setup({ load: () => Promise.reject(new Error("down")), save });
    await flush();
    expect(result.current.status).toBe("error");
    let r!: ReturnType<typeof result.current.replaceAllData>;
    act(() => {
      r = result.current.replaceAllData(INCOMING);
    });
    expect(r.ok).toBe(false);
    expect(result.current.classes).toEqual([]);
    expect(save).not.toHaveBeenCalled();
  });
});

describe("Import in Settings", () => {
  function renderCard(storage = fakeStorage(CURRENT)) {
    let timer!: ReturnType<typeof useTimer>;
    function Probe() {
      timer = useTimer();
      return null;
    }
    const view = render(
      <SettingsProvider>
        <StudyDataProvider store={createLocalStorageStore(() => storage)}>
          <TimerProvider>
            <Probe />
            <DataTransferCard />
          </TimerProvider>
        </StudyDataProvider>
      </SettingsProvider>,
    );
    return { storage, view, getTimer: () => timer };
  }

  const pick = async (content: string) => {
    const input = screen.getByLabelText("Choose an export file to import") as HTMLInputElement;
    const file = new File([content], "backup.json", { type: "application/json" });
    Object.defineProperty(file, "text", { value: () => Promise.resolve(content) }); // jsdom's File has no text()
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
    });
  };

  it("an invalid file shows the reason, opens no confirmation and changes nothing", async () => {
    const { storage } = renderCard();
    const before = storage.map.get(DATA_KEY);
    await pick("{not json");
    expect(screen.getByRole("alert").textContent).toMatch(/valid JSON.*unchanged/);
    expect(screen.queryByText("Replace my data")).toBeNull();
    expect(storage.map.get(DATA_KEY)).toBe(before);
  });

  it("a valid file asks for confirmation, and cancelling changes nothing", async () => {
    const { storage } = renderCard();
    const before = storage.map.get(DATA_KEY);
    await pick(serializeExport(INCOMING));
    expect(await screen.findByText("Replace your study data?")).toBeTruthy();
    expect(screen.getByText(/will be replaced/).textContent).toMatch(/1 class and 1 session.*current 1 class and 1 session/);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await flush();
    expect(storage.map.get(DATA_KEY)).toBe(before);
    expect(screen.queryByText(/^Imported/)).toBeNull();
  });

  it("confirming replaces the data, saves it and then reports success", async () => {
    const { storage } = renderCard();
    await pick(serializeExport(INCOMING));
    fireEvent.click(await screen.findByRole("button", { name: "Replace my data" }));
    await waitFor(() => expect(screen.getByRole("status").textContent).toMatch(/^Imported 1 class and 1 session/));
    expect(stored(storage)).toMatchObject(INCOMING);
  });

  it("blocks importing while a timer is running", async () => {
    const { getTimer } = renderCard();
    act(() => getTimer().setClassId("c-old"));
    act(() => getTimer().start());
    expect((screen.getByRole("button", { name: /Import data/ }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Stop the running timer before importing.")).toBeTruthy();
    act(() => getTimer().stop());
  });
});
