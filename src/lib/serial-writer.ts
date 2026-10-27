export const isPromise = (v: unknown): v is PromiseLike<unknown> =>
  typeof v === "object" && v !== null && typeof (v as { then?: unknown }).then === "function";

export type SerialWriter<T> = {
  /** Queues a full snapshot; it replaces any snapshot still waiting. */
  submit(snapshot: T): void;
  /** Tries the latest snapshot again after a failure. No-op if nothing failed. */
  retry(): void;
};

/**
 * Runs `write` with at most one call in flight, so an older snapshot can never
 * land after a newer one. Writes are whole snapshots, so while one is in flight
 * only the newest waiting snapshot matters and older waiting ones are dropped.
 * A synchronous `write` runs inside `submit`. A failed snapshot is never
 * discarded: it is retried by `retry()` or superseded by the next `submit`,
 * and `onFailureChange(true)` stays raised until a write succeeds.
 */
export function createSerialWriter<T>(
  write: (snapshot: T) => void | PromiseLike<void>,
  onFailureChange: (failed: boolean) => void = () => {},
): SerialWriter<T> {
  let latest: T;
  let waiting = false;
  let inFlight = false;
  let failed = false;

  const setFailed = (next: boolean) => {
    if (failed === next) return;
    failed = next;
    onFailureChange(next);
  };

  function drain() {
    while (waiting && !inFlight) {
      waiting = false;
      const snapshot = latest;
      let result: void | PromiseLike<void>;
      try {
        result = write(snapshot);
      } catch {
        setFailed(true);
        continue;
      }
      if (isPromise(result)) {
        inFlight = true;
        result.then(
          () => {
            inFlight = false;
            if (!waiting) setFailed(false);
            drain();
          },
          () => {
            inFlight = false;
            setFailed(true);
            drain();
          },
        );
        return;
      }
      if (!waiting) setFailed(false);
    }
  }

  return {
    submit(snapshot) {
      latest = snapshot;
      waiting = true;
      drain();
    },
    retry() {
      if (!failed || inFlight) return;
      waiting = true;
      drain();
    },
  };
}
