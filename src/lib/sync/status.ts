import type { SyncOutcome } from "./engine";
import type { EscapeOutcome } from "./escape";
import type { LinkOutcome } from "./link";

/**
 * What the user sees about sync (M4.3 S7): four states plus "not linked yet", each with a plain message. Pure, so it
 * is tested without any UI.
 *
 *  - synced     everything is up to date.
 *  - syncing    a pass is running.
 *  - offline    the network is unreachable; local data works and the next pass runs when it is back.
 *  - attention  something needs the user (or the developer): a conflict, a refusal, a sign-in problem, a server problem.
 *  - not_linked sync is on for this device but it has not been linked to the cloud yet (the first-link panel in the Settings card does that, after the user confirms).
 */
export type SyncStatus = "synced" | "syncing" | "offline" | "attention" | "not_linked";

export type SyncView = {
  status: SyncStatus;
  message: string;
  /** Worth trying again by itself (network, server, busy). Conflicts and refusals are not. */
  retryable: boolean;
};

export function describeOutcome(outcome: SyncOutcome): SyncView {
  switch (outcome.status) {
    case "up_to_date":
    case "synced":
      return { status: "synced", message: "Everything is synced.", retryable: false };
    case "not_linked":
      return {
        status: "not_linked",
        message: "Sync is on for this device, but it isn’t linked to your cloud data yet. Open Settings to link it. Nothing is uploaded or changed until you confirm.",
        retryable: false,
      };
    case "ineligible":
      return {
        status: "attention",
        message: "Some of your data can’t be synced yet (a name or limit the cloud doesn’t accept). Nothing was changed.",
        retryable: false,
      };
    case "conflicted":
      return {
        status: "attention",
        message: "Two of your devices changed the same thing in different ways. Nothing was changed on either side. Open Settings to choose what to keep.",
        retryable: false,
      };
    case "refused":
      return { status: "attention", message: `Sync stopped to keep your data safe. ${outcome.message}`, retryable: false };
    case "busy":
      return { status: "attention", message: "Your other devices are syncing at the same time. It will try again shortly.", retryable: true };
    case "error": {
      const kind = outcome.error.kind;
      if (kind === "network") {
        return { status: "offline", message: "You’re offline. Your changes are saved on this device and will sync when you’re back online.", retryable: true };
      }
      if (kind === "server") {
        return { status: "attention", message: "The sync server isn’t responding right now. Your data is safe on this device. It will try again.", retryable: true };
      }
      if (kind === "auth" || kind === "forbidden") {
        return { status: "attention", message: "Your sign-in has expired. Sign in again to keep syncing. Your data is safe on this device.", retryable: false };
      }
      if (outcome.stage === "backup") {
        return { status: "attention", message: "Couldn’t save a safety copy of your data, so the newer data wasn’t applied. Free up some space and try again.", retryable: true };
      }
      if (kind === "unavailable") {
        return { status: "attention", message: "Sync isn’t set up on the server yet.", retryable: false };
      }
      return { status: "attention", message: "Sync hit a problem. Your data is safe on this device.", retryable: true };
    }
  }
}

/** What the user is told when a first-link step did not finish. Nothing is linked, and their data on this device is intact. */
export function describeLinkOutcome(outcome: LinkOutcome): string | null {
  switch (outcome.status) {
    case "linked":
      return null;
    case "changed":
      return "Something changed while you were deciding (on this device or in the cloud). Nothing was done. Please look again and confirm.";
    case "not_allowed":
      return "That choice isn’t available any more. Nothing was done.";
    case "timer_running":
      return "Stop the timer first, then link. Linking can replace the data on this device.";
    case "conflicted":
      return "Some classes or subgroups on the two sides have the same name, so they can’t be combined automatically. Nothing was changed.";
    case "refused":
      return `${outcome.message} Nothing was changed.`;
    case "error": {
      const view = describeOutcome(outcome.outcome);
      return outcome.outcome.stage === "backup" ? "Couldn’t save a safety copy of this device’s data, so nothing was replaced. Free up some space and try again." : `${view.message} Linking didn’t finish; you can try again.`;
    }
  }
}

/** What the user is told when "use cloud" or "replace cloud" did not finish. This device's data is as it was. */
export function describeEscapeOutcome(outcome: EscapeOutcome): string | null {
  switch (outcome.status) {
    case "done":
      return null;
    case "changed":
      return "Something changed while you were deciding (on this device or in the cloud). Nothing was done. Please look again and confirm.";
    case "not_allowed":
      return "That choice isn’t available any more. Nothing was done.";
    case "timer_running":
      return "Stop the timer first. This choice replaces the data on this device.";
    case "refused":
      return outcome.message;
    case "error": {
      if (outcome.outcome.stage === "backup") return "Couldn’t save a safety copy first, so nothing was changed. Free up some space and try again.";
      return `${describeOutcome(outcome.outcome).message} Nothing was changed on this device; you can try again.`;
    }
  }
}
