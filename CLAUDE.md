# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

@AGENTS.md

## Commands

```bash
npm run dev                  # dev server on :3000 (add `-- -H 0.0.0.0` to test from a phone/iPad)
npm run build                # production build (also type-checks)
npm start                    # serve the production build (what browser checks run against)
npm run lint                 # ESLint (same as `npx eslint`)
npx tsc --noEmit             # type-check, includes tests/
npm test                     # vitest run (all tests)
npx vitest run tests/timeframe.test.ts          # one file
npx vitest run -t "week boundaries"             # by test name
node scripts/generate-icons.mjs                 # regenerate PNG app icons in public/icons
```

Before calling a change done, run tests, `tsc`, eslint and `npm run build`; all four currently pass.

## Architecture

Next.js App Router (Next 16, React 19, Tailwind 4), client-side only: no backend. Study data is still local (kept per signed-in account since M4.1); Supabase is used for sign-in only (M3). No sync yet; see `docs/M4-SYNC-PLAN.md`. Routes in `src/app/*/page.tsx` are thin wrappers around views in `src/features/*`. Path alias `@/*` → `src/*`.

**State is nested providers** (`src/components/providers.tsx`): Theme → Settings → Auth → `AccountBoundary` → (StudyData → Timer, mounted per owner).
- `AccountBoundary` (`features/data/account-boundary.tsx`) picks the data owner: `disabled` (no Supabase env) → legacy bucket `studytime:data`; `loading`/`signed-out` → `SignInWall`, no data provider mounted, nothing read; `signed-in` → bucket `studytime:u:<userId>:data` via `lib/account-store.ts`, keyed by user id so an account change remounts StudyData and Timer (a running timer can never be saved into another account). Account stores do no reset/migrations/backups; sign-out deletes nothing; the legacy bucket and all `*:pre-*-backup`/`*:corrupt` keys are never touched by accounts. `peekLegacyData` reads the legacy bucket read-only.
- `StudyDataProvider` is the single source of truth for `classes` and `sessions`, mirrored to localStorage (`studytime:data`). Every Insights, History and Classes number is derived from `sessions`; never store totals.
- `TimerProvider` holds the running session in memory only. Timestamps are the source of truth (the 250ms interval just refreshes the UI), and `stateRef` is read synchronously so a double click or tick racing Stop can't save a session twice. Default mode is Stopwatch (`lib/timer-defaults.ts`); mode is not persisted, only the countdown length is.
- `AuthProvider` (`features/auth`) exposes `status` (`disabled|loading|signed-out|signed-in`), `user`, `signIn`, `signOut`. It is UI state only (the database trusts the JWT, never this), and it never touches `studytime:data`. Email + password only, no in-app sign-up (accounts are created in the Supabase dashboard); signed-in users can change their password (`changePassword` re-verifies the current one). `signOut` uses `scope: "local"` so one device doesn't sign out the others. The client comes from `lib/supabase/client.ts` (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`; see `.env.example`) and is `null` when unset, which means local-only (`status: "disabled"`). Never use the service-role key in this app. supabase-js keeps its session in localStorage under `sb-<project-ref>-auth-token`; leave it alone.
- `AppShell` renders children only after hydration, so providers may read localStorage in their `useState` initializers.

**Domain rules live in pure modules under `src/lib/`, not in components.** Providers route all mutations through them so the rules hold on any code path, and they are written so a database could enforce the same constraints later:
- `class-rules.ts`: name normalization (trim, collapse spaces, case-insensitive), class names unique app-wide, subgroup names unique per class, and subgroups only attach directly to a class. Mutations return `Result<T>` (`{ok, value} | {ok:false, error}`); the UI shows `error` inline (`NameDialog` takes `validate` and an `onSubmit` that may return an error string).
- `class-tree.ts`, `session-rules.ts`: one-level group helpers, session reassignment (changes only `classId`/`groupId`) and `sessionsForGroup`.
- `timeframe.ts`: Insights ranges use local calendar, Monday-start weeks. A session is treated as one contiguous block from `startedAt`, so boundary-crossing sessions are split proportionally.
- `menu-position.ts` + `components/ui/dropdown.tsx`: Insights timeframe dropdown is a portal/fixed-position listbox clamped to the viewport (the old native select could overflow on phones/iPad).

**Provider mutations validate against refs.** `StudyDataProvider` keeps `classesRef`/`sessionsRef` so an action can validate against the latest data and return its result synchronously (two same-name adds in one batch must not both succeed). Keep new mutations on that pattern. `logSession` is idempotent by session id and follows the delete rules: a session for a class deleted mid-timer is dropped, and one for a deleted subgroup is saved on the class with `groupId: null`.

## Data and migrations (localStorage)

- `StudyDataProvider` does not touch localStorage itself: it takes a `store` prop (`StudyDataStore` in `lib/data-store.ts`, default `localStorageStore`) with `load()` (one-time reset, migrations, backups) and `save()`. Each may return a value (localStorage: ready on first render) or a Promise (future remote store, which should reject, not throw). The provider exposes `status` (`loading|ready|error`), `retryLoad`, `saveError`, `retrySave`; it never saves before a successful load, refuses mutations until ready, ignores superseded load attempts, and writes snapshots through `lib/serial-writer.ts` (one in flight, newest wins, failed snapshot kept and retried). `DataStatusGate` (in `layout.tsx`, inside `AppShell`) shows the loading/error/save-error UI. Reset/migration/backup logic lives in `createLocalStorageStore`; tests can inject a fake `StorageLike`.
- Backup (Settings → Backup): `lib/data-export.ts` defines the export file (`format: "studytime-export"`, `formatVersion: 1`, `exportedAt`, `data: {classes, sessions}`; documented at the top of the file), strict `validateStudyData`, and `parseExport`. Import goes through `replaceAllData` on the provider (refused until ready, re-validates, replaces atomically, saved through the normal writer); the UI asks for confirmation first and is disabled while a timer runs. Theme and countdown length are never exported or imported.
- Payload `{version, classes, sessions}`; current `DATA_VERSION = 2` (`lib/storage.ts`). `parseStoredData` also accepts v1 and sanitizes input.
- Groups are exactly one level deep. Older nested data is flattened on load (`flattenLegacyGroups`): ids kept so sessions stay valid, nested names become "Parent › Child", original saved to `studytime:data:pre-flatten-backup`.
- `lib/legacy-seed.ts` only recognizes the old sample data for the v1→v2 cleanup (backup: `studytime:data:pre-seed-cleanup-backup`). It is never loaded as data; fresh installs start empty.
- A one-time reset ran via marker `studytime:reset:2026-10-27` (`loadInitial` in `study-data-provider.tsx`); it copies the old data to `studytime:data:pre-reset-backup` and must never become recurring.
- Never delete the `*:pre-flatten-backup`, `*:pre-seed-cleanup-backup`, `*:pre-reset-backup` or `*:corrupt` keys. Theme (`studytime-theme`) and `studytime:countdown-minutes` are separate settings keys.
- Tests that seed `studytime:data` must first set `RESET_MARKER_KEY`, otherwise the one-time reset wipes the seed. Account buckets have no reset. Shared test helpers (`tests/helpers/fake-auth.ts`, `memory-storage.ts`) fake Supabase auth with user switching and record storage reads/writes.
- `AccountCard` takes a required `timerActive` prop (Settings passes it) so sign-out is blocked while a timer runs.

## Database (supabase/, not used for data yet)

`supabase/migrations/` holds the schema (`classes`, `groups`, `sessions`, `local_imports`), RLS and `import_local_data`; `supabase/README.md` explains the decisions; `supabase/tests/verify.sql` is a manual script. Both migrations were applied to the user's Supabase project and `verify.sql` passed. The app does not read or write these tables yet (sync is a later milestone). Needs PostgreSQL 15+. Keep the SQL rules in step with `class-rules.ts` / `data-export.ts` (names normalized, group ids unique per user, one level, session group belongs to its class). The only Supabase code in the app is sign-in (`lib/supabase/client.ts`, `features/auth`).

## Testing notes

Vitest config is in `vitest.config.ts` (alias `@`, tests in `tests/`). Component/provider tests opt into jsdom with `// @vitest-environment jsdom` and use `@testing-library/react` (call `cleanup()` yourself; globals are off) and fake timers for the timer. Browser checks used `playwright-core` driving the installed Chrome against `next start`.

## Gotchas

- `docs/PROJECT_STATUS.md` records what is verified, known issues and the next milestone; keep it current.
- In `next dev`, every route logs `instant-unrendered-segment` because `AppShell` renders a "Loading…" placeholder instead of `children` until hydration. It is development-only and does not affect the build; do not silence it with `instant = false`. Fixing it properly means removing that gate (a larger refactor, see the status doc).
- `AGENTS.md` says this Next.js version differs from training data; read `node_modules/next/dist/docs/` before using Next APIs.
- UI is mobile-first (iPhone/iPad, light and dark themes): use the CSS variable tokens in `globals.css` (`bg-card`, `text-muted-foreground`, `text-danger`, …), 44px touch targets, and `text-base sm:text-sm` on inputs to avoid iOS zoom.
