"use client";

import { AlertTriangle, CloudOff, RefreshCw } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardTitle } from "@/components/ui/card";
import { serializeExport } from "@/lib/data-export";
import { describeConflicts, notDecisions, toDecision } from "@/lib/sync/conflict-text";
import type { EscapeAction } from "@/lib/sync/escape";
import type { LinkAction, LinkCounts } from "@/lib/sync/link";
import { useSync, type ProviderStatus } from "./sync-provider";

const LABEL: Record<ProviderStatus, string> = {
  off: "Off",
  waiting: "Waiting to sync",
  syncing: "Syncing…",
  synced: "Synced",
  offline: "Offline",
  attention: "Needs attention",
  not_linked: "Not linked yet",
};

function lastSynced(at: number | null) {
  return at === null ? null : `Last synced ${new Date(at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const describeCounts = (c: LinkCounts) =>
  c.classes === 0 && c.sessions === 0 ? "no data" : `${plural(c.classes, "class", "classes")}, ${plural(c.groups, "subgroup")} and ${plural(c.sessions, "session")}`;

const ACTION: Record<LinkAction, { label: string; confirm: string; detail: string; replaces: boolean }> = {
  link: { label: "Link this device", confirm: "Yes, link this device", detail: "Both already match, so nothing is uploaded or changed. Linking only records that they match.", replaces: false },
  upload: { label: "Upload this device’s data", confirm: "Yes, upload and link", detail: "This device’s data is copied to the account. Nothing on this device changes.", replaces: false },
  adopt: { label: "Use the cloud data here", confirm: "Yes, copy it to this device", detail: "The cloud’s data is copied to this device. The cloud doesn’t change.", replaces: true },
  use_cloud: {
    label: "Use the cloud data",
    confirm: "Yes, replace this device’s data",
    detail: "This device’s data is replaced by the cloud’s. A safety copy of this device’s data is saved first, and the cloud doesn’t change. Anything that exists only on this device will no longer show here (it stays in the safety copy).",
    replaces: true,
  },
  combine: {
    label: "Combine both",
    confirm: "Yes, combine both",
    detail: "Everything from both sides is kept, on both sides. Nothing is deleted. A safety copy of this device’s data is saved first.",
    replaces: true,
  },
};

/** First link: says what linking would do, offers the choices that fit, and asks for a confirmation before doing anything. */
function LinkPanel() {
  const { link } = useSync();
  const [pending, setPending] = useState<LinkAction | null>(null);
  const account = link.account ?? "your account";
  const i = link.inspection;
  const working = link.phase === "linking";

  if (link.phase === "checking" && !i) return <p className="mt-4 text-sm text-muted-foreground">Checking your cloud data…</p>;
  if (!i) {
    return link.message ? (
      <div className="mt-4 text-sm">
        <p className="text-muted-foreground">{link.message}</p>
        <Button className="mt-2" variant="secondary" onClick={() => void link.refresh()}>Check again</Button>
      </div>
    ) : null;
  }

  const intro: Record<typeof i.scenario, string> = {
    match: `This device and the cloud data for ${account} already match (${describeCounts(i.local)}).`,
    upload: `This device has ${describeCounts(i.local)}. The cloud account ${account} has no data yet.`,
    adopt: `The cloud account ${account} has ${describeCounts(i.cloud)}. This device has no data yet.`,
    both: `This device has ${describeCounts(i.local)}. The cloud account ${account} has ${describeCounts(i.cloud)}. They are different, so nothing is chosen for you.`,
    ineligible: `This device has ${describeCounts(i.local)}, but some of it can’t be uploaded yet (a name or limit the cloud doesn’t accept).`,
  };

  const chosen = pending && i.actions.includes(pending) ? pending : null;
  const blocked = chosen !== null && ACTION[chosen].replaces && link.timerRunning;

  return (
    <div className="mt-4 rounded-2xl border border-border p-4 text-sm" aria-live="polite">
      <p className="font-medium">Link this device to {account}</p>
      <p className="mt-1 text-muted-foreground">{intro[i.scenario]}</p>
      {i.scenario === "ineligible" && i.issues.length > 0 && (
        <ul className="mt-2 list-disc pl-5 text-muted-foreground">
          {i.issues.slice(0, 3).map((issue, n) => (
            <li key={n}>{issue.message}</li>
          ))}
        </ul>
      )}
      {i.scenario === "both" && i.combineBlockedReason && <p className="mt-2 text-muted-foreground">{i.combineBlockedReason}</p>}
      {link.message && <p className="mt-2 text-danger" role="alert">{link.message}</p>}

      {!chosen && (
        <div className="mt-3 space-y-3">
          {i.actions.map((a) => (
            <div key={a}>
              <Button variant={i.actions.length === 1 ? "primary" : "secondary"} onClick={() => setPending(a)} disabled={working}>
                {ACTION[a].label}
              </Button>
              {i.scenario === "both" && <p className="mt-1 text-xs text-muted-foreground">{ACTION[a].detail}</p>}
            </div>
          ))}
          {i.scenario === "both" && <p className="text-xs text-muted-foreground">You can also leave sync off on this device; nothing changes until you choose.</p>}
        </div>
      )}

      {chosen && (
        <div className="mt-3 rounded-xl bg-muted p-3">
          <p className="font-medium">Link {account}?</p>
          <p className="mt-1 text-muted-foreground">{ACTION[chosen].detail}</p>
          {blocked && <p className="mt-2 text-danger">Stop the timer first. Linking can replace the data on this device.</p>}
          <div className="mt-3 flex flex-wrap gap-3">
            <Button
              variant="primary"
              disabled={working || blocked}
              onClick={async () => {
                await link.confirm(chosen);
                setPending(null);
              }}
            >
              {working ? "Linking…" : ACTION[chosen].confirm}
            </Button>
            <Button variant="secondary" disabled={working} onClick={() => setPending(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

/** The conflict screen: what differs, the choices with what each does to the study sessions, and one button to apply them. */
function ConflictPanel() {
  const { conflict } = useSync();
  const [picked, setPicked] = useState<Record<string, string>>({});
  const [names, setNames] = useState<Record<string, Record<string, string>>>({});
  const [busy, setBusy] = useState(false);
  const views = useMemo(() => (conflict ? describeConflicts(conflict.points, conflict.conflicts, conflict.snapshots) : []), [conflict]);
  if (!conflict) return null;
  const others = notDecisions(conflict.conflicts, conflict.points);
  const blocked = views.some((v) => v.blocked);

  const namesOf = (v: (typeof views)[number]) => Object.fromEntries((v.renames ?? []).map((r) => [r.id, names[v.fingerprint]?.[r.id] ?? r.current]));
  const decided = (v: (typeof views)[number]) => {
    const key = picked[v.fingerprint];
    if (!key) return false;
    if (key !== "rename") return true;
    const values = Object.values(namesOf(v)).map((n) => n.trim().toLowerCase());
    return values.every((n) => n.length > 0) && new Set(values).size === values.length;
  };
  const ready = views.length > 0 && !blocked && views.every(decided);

  const apply = async () => {
    setBusy(true);
    try {
      await conflict.resolve(views.map((v) => toDecision(v, picked[v.fingerprint], picked[v.fingerprint] === "rename" ? namesOf(v) : undefined)));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-4 rounded-2xl border border-border p-4 text-sm" aria-live="polite">
      <p className="font-medium">This device and the cloud disagree</p>
      <p className="mt-1 text-muted-foreground">
        Nothing has been changed on either side, and nothing will be until you apply your choices. No study session is deleted by any choice here.
      </p>
      {conflict.rejected > 0 && (
        <p className="mt-2 text-danger" role="alert">
          Some choices couldn’t be used (something changed, or a name was already taken). Please check them and apply again.
        </p>
      )}
      <div className="mt-3 space-y-4">
        {views.map((v) => (
          <fieldset key={v.fingerprint} className="rounded-xl bg-muted p-3">
            <legend className="px-1 font-medium">{v.title}</legend>
            <p className="text-muted-foreground">{v.detail}</p>
            <div className="mt-2 space-y-2">
              {v.choices.map((c) => (
                <label key={c.key} className={`flex items-start gap-2 ${c.available ? "" : "opacity-60"}`}>
                  <input
                    type="radio"
                    name={v.fingerprint}
                    className="mt-1"
                    disabled={!c.available || busy}
                    checked={picked[v.fingerprint] === c.key}
                    onChange={() => setPicked((p) => ({ ...p, [v.fingerprint]: c.key }))}
                  />
                  <span>
                    <span className="block">{c.label}</span>
                    <span className="block text-xs text-muted-foreground">{c.consequence}</span>
                  </span>
                </label>
              ))}
            </div>
            {picked[v.fingerprint] === "rename" && v.renames && (
              <div className="mt-2 space-y-2">
                {v.renames.map((r) => (
                  <label key={r.id} className="block text-xs text-muted-foreground">
                    {r.label}
                    <input
                      className="mt-1 block h-11 w-full rounded-xl border border-border bg-card px-3 text-base text-foreground sm:text-sm"
                      value={names[v.fingerprint]?.[r.id] ?? r.current}
                      onChange={(e) => setNames((n) => ({ ...n, [v.fingerprint]: { ...n[v.fingerprint], [r.id]: e.target.value } }))}
                      disabled={busy}
                    />
                  </label>
                ))}
              </div>
            )}
            {v.blocked && (
              <p className="mt-2 text-xs text-muted-foreground">
                This can’t be settled one by one. Use “Use the cloud’s data” or “Replace the cloud’s data” below.
              </p>
            )}
          </fieldset>
        ))}
        {others.map((c, n) => (
          <p key={n} className="text-muted-foreground">
            {c.message} It will be settled once the timer is stopped; then choose Sync now.
          </p>
        ))}
      </div>
      {views.length > 0 && (
        <Button className="mt-3" variant="primary" disabled={!ready || busy} onClick={() => void apply()}>
          {busy ? "Applying…" : "Apply my choices"}
        </Button>
      )}
    </div>
  );
}

const BACKUP_LABEL: Record<string, string> = {
  before_apply_remote: "This device, before newer cloud data was applied",
  before_first_link: "This device, before linking",
  before_use_cloud: "This device, before using the cloud’s data",
  before_replace_cloud: "This device, before replacing the cloud",
  cloud_before_replace_cloud: "The cloud’s data, before it was replaced",
};

function download(data: Parameters<typeof serializeExport>[0], savedAt: string) {
  try {
    const blob = new Blob([serializeExport(data, new Date(savedAt))], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `studytime-safety-copy-${savedAt.slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  } catch {
    // nothing to do: the copy is still stored on this device
  }
}

/** The copies sync keeps before it replaces anything. Each can be downloaded and restored with Settings → Backup → Import. */
function SafetyCopies() {
  const sync = useSync();
  const copies = useMemo(() => sync.backups(), [sync]);
  if (copies.length === 0) return null;
  return (
    <details className="mt-4 text-sm">
      <summary className="cursor-pointer font-medium">Safety copies on this device ({copies.length})</summary>
      <p className="mt-1 text-muted-foreground">Saved automatically before sync replaced something. Download one and restore it with Backup → Import.</p>
      <ul className="mt-2 space-y-2">
        {[...copies].reverse().map((c) => (
          <li key={c.key} className="flex flex-wrap items-center justify-between gap-2">
            <span>
              {BACKUP_LABEL[c.reason] ?? "A copy of your data"}
              <span className="block text-xs text-muted-foreground">
                {new Date(c.savedAt).toLocaleString()} · {c.data.classes.length} classes, {c.data.sessions.length} sessions
              </span>
            </span>
            <Button variant="secondary" onClick={() => download(c.data, c.savedAt)}>Download</Button>
          </li>
        ))}
      </ul>
    </details>
  );
}

/** "Use the cloud's data" and "Replace the cloud's data" for a linked device, each behind an explicit confirmation. */
function EscapePanel() {
  const { escape } = useSync();
  const [pending, setPending] = useState<EscapeAction | null>(null);
  const [understood, setUnderstood] = useState(false);
  const i = escape.inspection;
  const working = escape.phase === "working";
  const account = escape.account ?? "your account";
  const chosen = pending && i?.actions.includes(pending) ? pending : null;
  const blocked = chosen === "use_cloud" && escape.timerRunning;

  const choose = (a: EscapeAction | null) => {
    setPending(a);
    setUnderstood(false);
  };

  return (
    <details className="mt-4 text-sm" onToggle={(e) => (e.currentTarget.open ? void escape.open() : (escape.close(), choose(null)))}>
      <summary className="cursor-pointer font-medium">Not working out? Use the cloud’s data, or replace it</summary>
      <p className="mt-1 text-muted-foreground">Last resorts. Each one saves a safety copy first and asks you to confirm.</p>
      {escape.phase === "checking" && <p className="mt-2 text-muted-foreground">Checking your cloud data…</p>}
      {!i && escape.message && <p className="mt-2 text-muted-foreground">{escape.message}</p>}
      {i && (
        <div className="mt-3 rounded-2xl border border-border p-4">
          <p className="text-muted-foreground">
            This device has {describeCounts(i.local)}. The cloud account {account} has {describeCounts(i.cloud)}.
            {i.localOnlySessions > 0 && ` ${plural(i.localOnlySessions, "session")} exist${i.localOnlySessions === 1 ? "s" : ""} only on this device.`}
            {i.cloudOnlySessions > 0 && ` ${plural(i.cloudOnlySessions, "session")} exist${i.cloudOnlySessions === 1 ? "s" : ""} only in the cloud.`}
          </p>
          {escape.message && <p className="mt-2 text-danger" role="alert">{escape.message}</p>}
          {!chosen && (
            <div className="mt-3 space-y-3">
              <div>
                <Button variant="secondary" onClick={() => choose("use_cloud")} disabled={working}>Use the cloud’s data</Button>
                <p className="mt-1 text-xs text-muted-foreground">This device becomes a copy of the cloud. Changes here that aren’t in the cloud are replaced (saved as a safety copy first).</p>
              </div>
              <div>
                <Button variant="secondary" onClick={() => choose("replace_cloud")} disabled={working || !i.actions.includes("replace_cloud")}>Replace the cloud’s data</Button>
                <p className="mt-1 text-xs text-muted-foreground">
                  {i.replaceBlockedReason ?? "The cloud becomes a copy of this device, and your other devices follow. Cloud-only sessions are removed from the cloud (saved here as a safety copy first)."}
                </p>
              </div>
            </div>
          )}
          {chosen === "use_cloud" && (
            <div className="mt-3 rounded-xl bg-muted p-3">
              <p className="font-medium">Replace this device’s data with the cloud’s?</p>
              <p className="mt-1 text-muted-foreground">
                This device will hold {describeCounts(i.cloud)}, the same as {account}’s cloud.
                {i.localOnlySessions > 0 ? ` ${plural(i.localOnlySessions, "session")} that exist only on this device will no longer show here (they stay in the safety copy).` : ""} A safety copy of this device’s data is saved first. The cloud doesn’t change.
              </p>
              <label className="mt-2 flex items-start gap-2">
                <input type="checkbox" className="mt-1" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} disabled={working} />
                <span>I understand that changes on this device that aren’t in the cloud will be replaced.</span>
              </label>
              {blocked && <p className="mt-2 text-danger">Stop the timer first. This replaces the data on this device.</p>}
              <div className="mt-3 flex flex-wrap gap-3">
                <Button variant="primary" disabled={!understood || working || blocked} onClick={async () => { await escape.confirm("use_cloud"); choose(null); }}>
                  {working ? "Working…" : "Yes, replace this device’s data"}
                </Button>
                <Button variant="secondary" disabled={working} onClick={() => choose(null)}>Cancel</Button>
              </div>
            </div>
          )}
          {chosen === "replace_cloud" && (
            <div className="mt-3 rounded-xl bg-muted p-3">
              <p className="font-medium">Replace {account}’s cloud data with this device’s?</p>
              <p className="mt-1 text-muted-foreground">
                The cloud will hold {describeCounts(i.local)}, the same as this device.
                {i.cloudOnlySessions > 0 ? ` ${plural(i.cloudOnlySessions, "session")} that exist only in the cloud will be removed from it, and will disappear from your other devices the next time they sync.` : " Your other devices will follow the next time they sync."} Safety copies of this device’s data and of the cloud’s data are saved on this device first.
              </p>
              <label className="mt-2 flex items-start gap-2">
                <input type="checkbox" className="mt-1" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} disabled={working} />
                <span>I understand the cloud’s data will be replaced and may disappear from my other devices.</span>
              </label>
              <div className="mt-3 flex flex-wrap gap-3">
                <Button variant="primary" disabled={!understood || working} onClick={async () => { await escape.confirm("replace_cloud"); choose(null); }}>
                  {working ? "Working…" : "Yes, replace the cloud’s data"}
                </Button>
                <Button variant="secondary" disabled={working} onClick={() => choose(null)}>Cancel</Button>
              </div>
            </div>
          )}
        </div>
      )}
    </details>
  );
}

/** Settings: the per-device switch, the current state, and Sync now. Rendered only when sync could be turned on. */
export function SyncCard() {
  const sync = useSync();
  if (!sync.available) return null;
  const busy = sync.status === "syncing";
  return (
    <Card>
      <CardTitle>Sync between devices</CardTitle>
      <p className="mt-0.5 text-sm text-muted-foreground">
        Keeps your classes, subgroups and sessions the same on every device you sign in to. It is off by default and this
        switch only affects this device. Your data always stays usable here, even when sync can’t reach the cloud.
      </p>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button variant={sync.enabled ? "secondary" : "primary"} onClick={() => sync.setEnabled(!sync.enabled)}>
          {sync.enabled ? "Turn off sync on this device" : "Turn on sync on this device"}
        </Button>
        {sync.enabled && (
          <Button variant="secondary" onClick={() => void sync.syncNow()} disabled={busy || sync.paused}>
            <RefreshCw className={busy ? "h-4 w-4 animate-spin" : "h-4 w-4"} aria-hidden /> Sync now
          </Button>
        )}
      </div>
      {sync.paused && (
        <p className="mt-4 text-sm text-danger" role="status">
          Sync is paused because StudyTime was changed in another tab. Reload this tab to continue.
        </p>
      )}
      {sync.enabled && <LinkPanel />}
      {sync.enabled && sync.conflict && <ConflictPanel />}
      {sync.enabled && (
        <div className="mt-4 text-sm" role="status" aria-live="polite">
          <p className="font-medium">{LABEL[sync.status]}</p>
          {sync.message && <p className="mt-0.5 text-muted-foreground">{sync.message}</p>}
          {lastSynced(sync.lastSyncedAt) && <p className="mt-0.5 text-xs text-muted-foreground">{lastSynced(sync.lastSyncedAt)}</p>}
        </div>
      )}
      {sync.enabled && sync.status !== "not_linked" && sync.link.phase === "none" && <EscapePanel />}
      {sync.enabled && <SafetyCopies />}
    </Card>
  );
}

/** A slim notice above the pages while sync is offline or needs attention, with a retry. Nothing when all is well. */
export function SyncBanner() {
  const sync = useSync();
  // While this tab is out of date the "changed in another tab" banner already says so (and a retry would do nothing).
  if (sync.paused || !sync.enabled || (sync.status !== "offline" && sync.status !== "attention")) return null;
  const Icon = sync.status === "offline" ? CloudOff : AlertTriangle;
  return (
    <div role="status" className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-border bg-card px-4 py-3 text-sm">
      <span className="flex items-start gap-2">
        <Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <span>{sync.message}</span>
      </span>
      {sync.conflict ? (
        <Link href="/settings" className="inline-flex h-11 items-center rounded-xl bg-muted px-4 text-sm font-medium hover:bg-border">
          Review
        </Link>
      ) : (
        <Button variant="secondary" onClick={() => void sync.syncNow()}>
          Retry
        </Button>
      )}
    </div>
  );
}
