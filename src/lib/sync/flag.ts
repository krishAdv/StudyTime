/**
 * Build-time switch for cloud sync (M4.3). Sync is off unless the app is built with
 * `NEXT_PUBLIC_STUDYTIME_SYNC=1`. Even then it will also need a per-device opt-in (S7). Until a real two-device test
 * passes this stays off, so nothing in the app can sync by accident.
 */
export const syncBuildEnabled = (): boolean => process.env.NEXT_PUBLIC_STUDYTIME_SYNC === "1";
