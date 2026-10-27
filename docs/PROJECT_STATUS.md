# StudyTime project status

Last updated: 2026-10-27 (end of Phase 1: stabilization). Everything below reflects the code and the checks actually run on that date.

## What is implemented

- **Stack:** Next.js 16.4.3 (App Router, Turbopack, `cacheComponents` and `partialPrefetching` on), React 19, Tailwind 4, TypeScript. Client-side only: no backend, auth or Supabase.
- **Routes** (thin wrappers around `src/features/*`): `/` Dashboard (timer), `/classes`, `/history`, `/insights`, `/settings`, plus `manifest.webmanifest`.
- **Timer:** Stopwatch (default) and Countdown. Start, Pause, Resume, Stop. Paused time is not counted. A countdown that reaches zero saves the full target. Sessions under 1 second are not saved. The mode is locked while a session is active. Only the countdown length is remembered.
- **Classes and subgroups:** create, rename, delete. Subgroups are one level deep. Class names are unique app-wide, subgroup names unique per class (trimmed, spaces collapsed, case-insensitive). The UI disables the button and explains why when a name is a duplicate.
- **History:** sessions grouped by day, class filter, tap a session to change its class or subgroup (only those two fields change). Subgroup pages show only that subgroup's sessions.
- **Insights:** daily and weekly charts, streaks, per-class totals with a Today / This week / This month / All time dropdown. Local calendar, Monday-start weeks; a session that crosses a boundary is split proportionally.
- **Settings:** light / dark / system theme, and Backup: export study data to a JSON file, or import one (replaces current data after a confirmation).
- **Persistence:** localStorage on this device (see below). PWA manifest and icons exist; there is no service worker.

## Persistence, migrations and reset

- `studytime:data` holds `{version, classes, sessions}`; current version is 2. Version 1 is still read.
- Nested groups from older data are flattened on load (`Parent › Child`), original saved to `studytime:data:pre-flatten-backup`.
- Old sample data is removed once (v1 to v2), original saved to `studytime:data:pre-seed-cleanup-backup`.
- A one-time reset (marker `studytime:reset:2026-10-27`) copied existing data to `studytime:data:pre-reset-backup` and started empty. It does not repeat.
- Unreadable data is kept under `studytime:data:corrupt` and the app starts empty.
- Never delete the `*:pre-*-backup` or `*:corrupt` keys. Theme (`studytime-theme`) and `studytime:countdown-minutes` are separate keys.

## Phase 1 changes

- Fixed: deleting a class while its timer was running, then pressing Stop, saved an orphan session pointing at the deleted class. Deleting a subgroup mid-session saved a session pointing at a missing subgroup. `logSession` now drops the first and clears the group on the second, matching what the delete buttons do to existing sessions.
- Fixed: stray extra period in the History empty-state text.
- Added `tests/session-saving.test.tsx` (6 tests: duplicate saves and deletion during a running timer).
- Corrected `README.md` and `CLAUDE.md` (Pomodoro, nested groups, Settings contents).

## Verified

| Check | Result (2026-10-27) |
| --- | --- |
| `npm test` | 11 files, 105 tests pass |
| `npx tsc --noEmit` | no errors |
| `npx eslint` | no output |
| `npm run build` | succeeds, 7 routes prerendered, no warnings |
| Desktop Chrome (headless, `playwright-core`, against `next dev`, 1000px wide) | Passed: create / rename / delete class, add subgroup, duplicate class and subgroup blocked, stopwatch start/stop (double-click Stop saved one session), countdown stop, session shown in History, reassign class, dark theme persists across reload, sessions persist across reload, deleting a class removes its sessions, Insights timeframe options switch, no console errors other than the diagnostic below |
| Chrome at 375px wide (desktop browser resized, not a phone) | Passed: no horizontal overflow, bottom tab bar navigates, Insights timeframe menu stays inside the viewport |

Automated coverage (vitest/jsdom): naming rules, flatten migration, seed cleanup, one-time reset, session reassignment, subgroup session filtering, timeframe boundaries, dropdown placement, timer modes, duplicate saves.

The browser script was a throwaway and is not in the repo. Not browser-checked: subgroup pages in the browser (covered by jsdom tests), a countdown running to completion, the migration paths in a real browser (covered by jsdom tests), and the light theme visually.

## Known issues and limitations

- **`instant-unrendered-segment` in `next dev` (all routes).** Text: `Route "/history": Could not validate that a segment in your UI has instant navigation. This segment was dropped from rendering. Issues that would prevent instant navigation will go undetected. Dropped segment: src/app/history/page.tsx`. `/`, `/classes`, `/insights` and `/settings` give the same message naming their own `page.tsx`. Reproduced in Chrome by clicking through the sidebar. It was not specific to History.
  - Cause (from the code, not confirmed by changing it): `AppShell` renders "Loading…" instead of `children` until after hydration, so each page segment is never rendered during Next's validation pass.
  - Impact: development-only per the Next docs. The production build is clean and client-side navigation worked in the browser. It means Next cannot check these routes for instant navigation.
  - Not fixed on purpose. `instant = false` would hide the message without fixing it. The real fix is to stop gating `children` on mount (for example, read localStorage through `useSyncExternalStore` in the data provider), which touches every view. Treat it as part of the data-layer work below.
- **Not tested on iPhone or iPad Safari, or any real touch device.** The 375px check was a resized desktop Chrome window. iOS input zoom, safe-area insets and "Add to Home Screen" are unverified.
- Not tested in Firefox or desktop Safari.
- Data is per browser and device. Clearing site data erases it; use Backup → Export to keep a copy.
- Import (M1) is verified by unit tests and one desktop Chrome run (export, invalid file, cancel, confirm, reload). Not tested on iPhone/iPad Safari, where file download and the file picker may behave differently. The success message appears once the data is replaced in the app; if saving then fails, the existing "changes haven’t been saved" banner appears. Import validates strictly, so a file whose names or ids break the current rules (for example duplicate names from very old data) is rejected rather than repaired. Import is blocked while a timer is running.
- No service worker; the app does not work offline.
- The timer exists only in memory: reloading or closing the tab during a session loses it.

## Not implemented

Supabase, accounts and sign-in, cross-device sync, merging imports (import only replaces), Pomodoro, nested subgroups, offline support, manual session entry, session deletion, notifications.

## Next milestone

Plan Supabase authentication and multi-device synchronization (design first, no code yet). Suggested order:

1. ~~Put localStorage behind a small storage interface~~ Done (Phase 2): `StudyDataStore` in `src/lib/data-store.ts`.
1b. ~~Async-capable store, provider load status, retry, save gating, serialized writes~~ Done (M0). Verified by unit tests with fake async stores only; no real async store or browser run exists yet. A session finished while status is not `ready` is not queued (unreachable today because the timer needs a loaded class); the durable outbox is a later milestone.
2. Resolve the dev diagnostic above by removing the mount gate, since remote data loads will need a proper loading state anyway.
3. Decide the data model (classes, subgroups, sessions with stable ids, `updatedAt`, soft delete) and the conflict rules for two devices.
4. Decide how existing local data is uploaded after first sign-in, keeping the backups.
5. Add export/import as a safety net before any sync is turned on.
