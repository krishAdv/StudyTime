"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useStudyData } from "@/features/data/study-data-provider";
import { useTimer } from "@/features/timer/timer-provider";
import type { StorageLike } from "@/lib/data-store";
import { getSupabase } from "@/lib/supabase/client";
import { createSupabaseSyncApi, type SyncApi } from "@/lib/sync/api";
import type { Decision, DecisionPoint } from "@/lib/sync/decisions";
import { listSyncBackups, loadBaseline, loadSyncEnabled, saveBaseline, saveSyncBackup, saveSyncEnabled } from "@/lib/sync/device-store";
import { createEscapes, type EscapeAction, type EscapeInspection, type Escapes } from "@/lib/sync/escape";
import { createSyncEngine, type SyncEngine, type SyncOptions } from "@/lib/sync/engine";
import type { MergeConflict } from "@/lib/sync/merge";
import type { SyncSnapshot } from "@/lib/sync/snapshot";
import { createLinker, type LinkAction, type LinkDeps, type LinkInspection, type Linker } from "@/lib/sync/link";
import { syncBuildEnabled } from "@/lib/sync/flag";
import { describeEscapeOutcome, describeLinkOutcome, describeOutcome, type SyncStatus } from "@/lib/sync/status";

/**
 * Connects the sync engine (M4.3 S6) to the app. All sync behavior lives in the engine; this provider only decides WHEN
 * to run it and shows the result.
 *
 * Off unless the build flag is on (`NEXT_PUBLIC_STUDYTIME_SYNC=1`), a backend is configured, and the user turned sync on
 * for this device (a per-device, per-account setting). With sync off the app behaves exactly as before.
 *
 * Triggers (no polling): app start / turning sync on, a short delay after a local change, the network coming back, and
 * the app coming back to the foreground (throttled). Automatic passes wait while a timer is running or paused and run
 * when it stops, so applying merged data never lands in the middle of a session; "Sync now" always works, and the
 * running timer's class and subgroup are protected from being deleted by the merge either way. Network and server
 * failures retry a few times with growing delays; a conflict or refusal is shown and never retried blindly.
 */
export type ProviderStatus = SyncStatus | "off" | "waiting";

/**
 * First link (S8). While the device is "not linked", the provider reads the cloud once (a pull, nothing is written) and
 * offers the choices that fit; `confirm(action)` does only what the user confirmed, and only if both sides are still as
 * they were shown. The link is never made by itself.
 */
export type LinkUi = {
  /** `none`: nothing to link; `checking`: reading the cloud; `ready`: choices shown; `linking`: doing the confirmed action. */
  phase: "none" | "checking" | "ready" | "linking";
  inspection: LinkInspection | null;
  /** Shown with the choices: a failure, or "something changed". */
  message: string | null;
  /** Who the data belongs to (the signed-in email), so the user sees which account is being linked. */
  account: string | null;
  /** A timer is running: choices that replace this device's data wait for it to stop. */
  timerRunning: boolean;
  refresh: () => Promise<void>;
  confirm: (action: LinkAction) => Promise<void>;
};

/** The unresolved conflicts of the last pass, with what the conflict screen needs to describe them. Nothing is pushed while they exist. */
export type ConflictUi = {
  points: DecisionPoint[];
  conflicts: MergeConflict[];
  snapshots: { base: SyncSnapshot; local: SyncSnapshot; remote: SyncSnapshot };
  /** Decisions the last submit sent that were not usable (the situation changed, a name was taken). */
  rejected: number;
  /** Runs the engine again with the user's decisions. Still conflicted means nothing was pushed. */
  resolve: (decisions: Decision[]) => Promise<void>;
};

/** "Use cloud" and "Replace cloud" for a linked device: `open()` reads both sides, `confirm` does the confirmed action. */
export type EscapeUi = {
  phase: "none" | "checking" | "ready" | "working";
  inspection: EscapeInspection | null;
  message: string | null;
  account: string | null;
  timerRunning: boolean;
  open: () => Promise<void>;
  close: () => void;
  confirm: (action: EscapeAction) => Promise<void>;
};

export type SyncUi = {
  /** Sync is paused because another tab changed this account's data and this tab is out of date (reload to continue). */
  paused: boolean;
  conflict: ConflictUi | null;
  escape: EscapeUi;
  /** Safety copies kept on this device, oldest first (so they can be downloaded). */
  backups: () => ReturnType<typeof listSyncBackups>;
  link: LinkUi;
  /** The build flag is on and a backend is configured, so sync could be turned on. */
  available: boolean;
  /** This device opted in. */
  enabled: boolean;
  setEnabled: (on: boolean) => void;
  status: ProviderStatus;
  message: string | null;
  lastSyncedAt: number | null;
  /** A manual pass (works while a timer runs; the running timer's class is protected). */
  syncNow: () => Promise<void>;
};

const NO_LINK: LinkUi = { phase: "none", inspection: null, message: null, account: null, timerRunning: false, refresh: async () => {}, confirm: async () => {} };

const NO_ESCAPE: EscapeUi = { phase: "none", inspection: null, message: null, account: null, timerRunning: false, open: async () => {}, close: () => {}, confirm: async () => {} };

const PAUSED_MESSAGE = "Sync is paused because StudyTime was changed in another tab. Reload this tab to continue.";

const OFF: SyncUi = {
  paused: false,
  conflict: null,
  escape: NO_ESCAPE,
  backups: () => [],
  link: NO_LINK,
  available: false, enabled: false, setEnabled: () => {}, status: "off", message: null, lastSyncedAt: null, syncNow: async () => {},
};

const SyncContext = createContext<SyncUi>(OFF);

/** Without a provider (sync not mounted) everything reads as "off". */
export const useSync = () => useContext(SyncContext);

type Props = {
  userId: string;
  children: React.ReactNode;
  /** Who is signed in (shown when linking, so the user sees which account's data is involved). */
  accountLabel?: string | null;
  /** Tests inject a fake (or null for "no backend"); the app uses the shared Supabase client. */
  api?: SyncApi | null;
  getStorage?: () => StorageLike | null;
  /** Tests override the build flag. */
  buildEnabled?: boolean;
  /** Delay after a local change before a pass runs. */
  changeDelayMs?: number;
  /** Minimum time between passes caused by returning to the app. */
  focusThrottleMs?: number;
  /** Delays before automatic retries after a network or server failure; when they run out the next trigger starts over. */
  retryDelaysMs?: number[];
};

export function SyncProvider({
  userId, children, accountLabel = null, api: injected, getStorage, buildEnabled, changeDelayMs = 3000, focusThrottleMs = 30_000, retryDelaysMs = [30_000, 120_000, 600_000],
}: Props) {
  const { status: dataStatus, classes, sessions, syncBridge, staleTab } = useStudyData();
  const timer = useTimer();
  const flag = buildEnabled ?? syncBuildEnabled();
  const api = useMemo<SyncApi | null>(() => {
    if (injected !== undefined) return injected;
    const client = getSupabase();
    return client ? createSupabaseSyncApi(client) : null;
  }, [injected]);
  const available = flag && api !== null;
  const storage = useMemo(() => (getStorage ? getStorage() : typeof window === "undefined" ? null : window.localStorage), [getStorage]);

  const [enabled, setEnabledState] = useState(() => available && loadSyncEnabled(storage, userId));
  const [view, setView] = useState<{ status: ProviderStatus; message: string | null }>({ status: "waiting", message: null });
  const [lastSyncedAt, setLastSyncedAt] = useState<number | null>(null);
  const [conflict, setConflict] = useState<Omit<ConflictUi, "resolve"> | null>(null);
  const [escape, setEscape] = useState<{ phase: EscapeUi["phase"]; inspection: EscapeInspection | null; message: string | null }>({ phase: "none", inspection: null, message: null });
  const [link, setLink] = useState<{ phase: LinkUi["phase"]; inspection: LinkInspection | null; message: string | null }>({ phase: "none", inspection: null, message: null });

  // Everything the callbacks below read lives in refs, so they stay stable and never act on stale values.
  const enabledRef = useRef(enabled);
  const readyRef = useRef(dataStatus === "ready");
  // When another tab changed this account's data, this tab's copy is out of date and NOTHING here may sync, link or replace
  // data (a stale pass would read the newer data as deleted). The data provider answers live (it re-reads storage), so a
  // change that arrived a moment ago is seen even before React has re-rendered.
  const bridgeRef = useRef(syncBridge);
  useEffect(() => {
    bridgeRef.current = syncBridge;
  });
  const isStaleNow = useCallback(() => bridgeRef.current.isStale(), []);
  const timerRef = useRef(timer.state);
  const appliedRef = useRef<unknown>(null);
  const pendingRef = useRef(false);
  const lastPassRef = useRef(0);
  const retryIndexRef = useRef(0);
  const delayTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const aliveRef = useRef(true);
  const retryDelaysRef = useRef(retryDelaysMs);
  useEffect(() => {
    enabledRef.current = enabled;
    readyRef.current = dataStatus === "ready";
    timerRef.current = timer.state;
    retryDelaysRef.current = retryDelaysMs;
  });

  // The engine is created in an effect (it captures refs that must not be read while rendering) and read from a ref.
  const engineRef = useRef<SyncEngine | null>(null);
  const linkerRef = useRef<Linker | null>(null);
  const escapesRef = useRef<Escapes | null>(null);
  const escapingRef = useRef(false);
  useEffect(() => {
    const deps: LinkDeps | null = api
      ? {
          api,
          loadBaseline: () => loadBaseline(storage, userId),
          saveBaseline: (b) => saveBaseline(storage, userId, b),
          getLocal: syncBridge.getData,
          replaceLocal: (expected, next) => {
            const ok = syncBridge.applyData(expected, next);
            if (ok) appliedRef.current = syncBridge.getData();
            return ok;
          },
          backup: (data, info) => saveSyncBackup(storage, userId, data, info),
          isLocalCurrent: () => !bridgeRef.current.isStale(),
          protect: () => {
            const c = timerRef.current.context;
            return c ? { classIds: [c.classId], groupIds: c.groupId ? [c.groupId] : [] } : undefined;
          },
          timerActive: () => timerRef.current.status !== "idle",
        }
      : null;
    engineRef.current = deps ? createSyncEngine(deps) : null;
    linkerRef.current = deps ? createLinker(deps) : null;
    escapesRef.current = deps ? createEscapes(deps) : null;
    return () => {
      engineRef.current = null;
      linkerRef.current = null;
      escapesRef.current = null;
    };
  }, [api, storage, userId, syncBridge]);
  const runPassRef = useRef<(options?: SyncOptions) => Promise<void>>(async () => {});
  const refreshLinkRef = useRef<() => Promise<void>>(async () => {});
  const linkingRef = useRef(false);

  const clearTimers = useCallback(() => {
    if (delayTimer.current) clearTimeout(delayTimer.current);
    if (retryTimer.current) clearTimeout(retryTimer.current);
    delayTimer.current = null;
    retryTimer.current = null;
  }, []);

  const runPass = useCallback(async (options?: SyncOptions) => {
    const engine = engineRef.current;
    if (!engine || !enabledRef.current || !readyRef.current || !aliveRef.current || isStaleNow()) return;
    lastPassRef.current = Date.now();
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      setView({ status: "offline", message: "You’re offline. Your changes are saved on this device and will sync when you’re back online." });
      return;
    }
    setView((v) => ({ status: "syncing", message: v.message }));
    const outcome = await engine.syncOnce(options);
    if (!aliveRef.current || !enabledRef.current) return;
    const result = describeOutcome(outcome);
    setView({ status: result.status, message: result.message });
    if (outcome.status === "not_linked") void refreshLinkRef.current();
    if (outcome.status === "conflicted") {
      setConflict({ points: outcome.decisionPoints, conflicts: outcome.conflicts, snapshots: outcome.snapshots, rejected: outcome.rejectedDecisions.length });
    } else if (outcome.status === "synced" || outcome.status === "up_to_date") {
      setConflict(null);
    }
    if (result.status === "synced") {
      setLastSyncedAt(Date.now());
      retryIndexRef.current = 0;
    } else if (result.retryable && retryIndexRef.current < retryDelaysRef.current.length) {
      const wait = retryDelaysRef.current[retryIndexRef.current++];
      if (retryTimer.current) clearTimeout(retryTimer.current);
      retryTimer.current = setTimeout(() => void runPassRef.current(), wait);
    }
  }, [isStaleNow]);
  useEffect(() => {
    runPassRef.current = runPass;
  }, [runPass]);

  /** An automatic trigger: waits while a timer is active, otherwise runs after `delay`. */
  const request = useCallback(
    (delay: number) => {
      if (!enabledRef.current || !engineRef.current || isStaleNow()) return;
      retryIndexRef.current = 0;
      if (timerRef.current.status !== "idle") {
        pendingRef.current = true;
        return;
      }
      if (delayTimer.current) clearTimeout(delayTimer.current);
      delayTimer.current = setTimeout(() => void runPass(), delay);
    },
    [runPass, isStaleNow],
  );

  const syncNow = useCallback(async () => {
    if (!enabledRef.current) return;
    clearTimers();
    retryIndexRef.current = 0;
    await runPass();
  }, [clearTimers, runPass]);

  /** Reads both sides (one pull, no writes) and offers the choices that fit. Never links by itself. */
  const refreshLink = useCallback(async () => {
    const linker = linkerRef.current;
    if (!linker || !enabledRef.current || !aliveRef.current || linkingRef.current || isStaleNow()) return;
    setLink((l) => ({ ...l, phase: "checking" }));
    const r = await linker.inspect();
    if (!aliveRef.current || !enabledRef.current || linkingRef.current) return;
    if (r.status === "ok") {
      setLink({ phase: "ready", inspection: r.inspection, message: null });
    } else if (r.status === "linked_already") {
      setLink({ phase: "none", inspection: null, message: null });
      request(0);
    } else {
      const view = describeOutcome(r.outcome);
      setLink((l) => ({ phase: l.inspection ? "ready" : "none", inspection: l.inspection, message: view.message }));
      setView({ status: view.status, message: view.message });
    }
  }, [request, isStaleNow]);
  useEffect(() => {
    refreshLinkRef.current = refreshLink;
  }, [refreshLink]);

  /** Does exactly the action the user confirmed, for exactly the situation they were shown. */
  const confirm = useCallback(
    async (action: LinkAction) => {
      const linker = linkerRef.current;
      const seen = link.inspection;
      if (!linker || !seen || !enabledRef.current || linkingRef.current) return;
      if (isStaleNow()) {
        setLink((l) => ({ ...l, message: PAUSED_MESSAGE }));
        return;
      }
      linkingRef.current = true;
      setLink((l) => ({ ...l, phase: "linking", message: null }));
      try {
        const outcome = await linker.link(action, seen.fingerprint);
        if (!aliveRef.current || !enabledRef.current) return;
        if (outcome.status === "linked") {
          setLink({ phase: "none", inspection: null, message: null });
          setView({ status: "synced", message: "Linked. Everything is synced." });
          setLastSyncedAt(Date.now());
          linkingRef.current = false;
          request(0); // anything recorded while linking goes up in a normal pass
          return;
        }
        const next = outcome.status === "changed" || outcome.status === "not_allowed" ? outcome.inspection : seen;
        setLink({ phase: "ready", inspection: next, message: describeLinkOutcome(outcome) });
      } finally {
        linkingRef.current = false;
      }
    },
    [link.inspection, request, isStaleNow],
  );

  /** Submits the user's choices to the engine. If anything is still unresolved nothing is pushed. */
  const resolve = useCallback(
    async (decisions: Decision[]) => {
      if (!enabledRef.current || isStaleNow()) return;
      clearTimers();
      retryIndexRef.current = 0;
      await runPass({ decisions });
    },
    [clearTimers, runPass, isStaleNow],
  );

  const openEscape = useCallback(async () => {
    const escapes = escapesRef.current;
    if (!escapes || !enabledRef.current || escapingRef.current || isStaleNow()) return;
    setEscape((e) => ({ ...e, phase: "checking", message: null }));
    const r = await escapes.inspect();
    if (!aliveRef.current || !enabledRef.current || escapingRef.current) return;
    if (r.status === "ok") setEscape({ phase: "ready", inspection: r.inspection, message: null });
    else if (r.status === "not_linked") setEscape({ phase: "none", inspection: null, message: "This device isn’t linked yet." });
    else setEscape({ phase: "none", inspection: null, message: describeOutcome(r.outcome).message });
  }, [isStaleNow]);

  const closeEscape = useCallback(() => setEscape({ phase: "none", inspection: null, message: null }), []);

  /** Does exactly the action the user confirmed, for exactly the situation they were shown. */
  const confirmEscape = useCallback(
    async (action: EscapeAction) => {
      const escapes = escapesRef.current;
      const seen = escape.inspection;
      if (!escapes || !seen || !enabledRef.current || escapingRef.current) return;
      if (isStaleNow()) {
        setEscape((e) => ({ ...e, message: PAUSED_MESSAGE }));
        return;
      }
      escapingRef.current = true;
      setEscape((e) => ({ ...e, phase: "working", message: null }));
      try {
        const outcome = await escapes.run(action, seen.fingerprint);
        if (!aliveRef.current || !enabledRef.current) return;
        if (outcome.status === "done") {
          setEscape({ phase: "none", inspection: null, message: null });
          setConflict(null);
          setView({ status: "synced", message: action === "use_cloud" ? "Done. This device now matches the cloud." : "Done. The cloud now matches this device." });
          setLastSyncedAt(Date.now());
          escapingRef.current = false;
          request(0);
          return;
        }
        const next = outcome.status === "changed" || outcome.status === "not_allowed" ? outcome.inspection : seen;
        setEscape({ phase: "ready", inspection: next, message: describeEscapeOutcome(outcome) });
      } finally {
        escapingRef.current = false;
      }
    },
    [escape.inspection, request, isStaleNow],
  );

  const setEnabled = useCallback(
    (on: boolean) => {
      if (!available) return;
      try {
        saveSyncEnabled(storage, userId, on);
      } catch {
        setView({ status: "attention", message: "Couldn’t save the sync setting on this device." });
        return;
      }
      enabledRef.current = on;
      setEnabledState(on);
      clearTimers();
      pendingRef.current = false;
      setLink({ phase: "none", inspection: null, message: null });
      setConflict(null);
      setEscape({ phase: "none", inspection: null, message: null });
      if (on) {
        setView({ status: "waiting", message: null });
        request(0);
      }
    },
    [available, storage, userId, clearTimers, request],
  );

  // trigger: app start (and as soon as the data has loaded)
  useEffect(() => {
    if (enabled && dataStatus === "ready") request(0);
  }, [enabled, dataStatus, request]);

  // trigger: a local change (changes made by applying synced data are not new changes)
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    if (!enabledRef.current || dataStatus !== "ready") return;
    if (syncBridge.getData() === appliedRef.current) return;
    request(changeDelayMs);
  }, [classes, sessions, dataStatus, syncBridge, request, changeDelayMs]);

  // trigger: a timer that was running has stopped
  useEffect(() => {
    if (timer.state.status === "idle" && pendingRef.current) {
      pendingRef.current = false;
      request(changeDelayMs);
    }
  }, [timer.state.status, request, changeDelayMs]);

  // triggers: the network is back, and the app is back in the foreground (throttled)
  useEffect(() => {
    const online = () => request(0);
    const foreground = () => {
      if (document.visibilityState === "hidden") return;
      if (Date.now() - lastPassRef.current < focusThrottleMs) return;
      request(0);
    };
    window.addEventListener("online", online);
    window.addEventListener("focus", foreground);
    document.addEventListener("visibilitychange", foreground);
    return () => {
      window.removeEventListener("online", online);
      window.removeEventListener("focus", foreground);
      document.removeEventListener("visibilitychange", foreground);
    };
  }, [request, focusThrottleMs]);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      clearTimers();
    };
  }, [clearTimers]);

  const linkUi = useMemo<LinkUi>(
    () => ({
      phase: enabled ? link.phase : "none",
      inspection: enabled ? link.inspection : null,
      message: enabled ? link.message : null,
      account: accountLabel,
      timerRunning: timer.state.status !== "idle",
      refresh: refreshLink,
      confirm,
    }),
    [enabled, link, accountLabel, timer.state.status, refreshLink, confirm],
  );

  const escapeUi = useMemo<EscapeUi>(
    () => ({
      phase: enabled ? escape.phase : "none",
      inspection: enabled ? escape.inspection : null,
      message: enabled ? escape.message : null,
      account: accountLabel,
      timerRunning: timer.state.status !== "idle",
      open: openEscape,
      close: closeEscape,
      confirm: confirmEscape,
    }),
    [enabled, escape, accountLabel, timer.state.status, openEscape, closeEscape, confirmEscape],
  );
  const conflictUi = useMemo<ConflictUi | null>(() => (enabled && conflict ? { ...conflict, resolve } : null), [enabled, conflict, resolve]);
  const backups = useCallback(() => listSyncBackups(storage, userId), [storage, userId]);

  const value = useMemo<SyncUi>(
    () => ({
      paused: enabled && staleTab,
      conflict: conflictUi,
      escape: escapeUi,
      backups,
      link: linkUi,
      available,
      enabled,
      setEnabled,
      status: enabled ? view.status : "off",
      message: enabled ? view.message : null,
      lastSyncedAt,
      syncNow,
    }),
    [staleTab, conflictUi, escapeUi, backups, linkUi, available, enabled, setEnabled, view, lastSyncedAt, syncNow],
  );

  return <SyncContext.Provider value={value}>{children}</SyncContext.Provider>;
}
