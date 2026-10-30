# M4: cloud sync plan and decisions

Status key: **Implemented** (in the code and covered by tests), **Planned** (not built; do not assume it works).

## Decisions (from the owner)

1. Supabase configured: a sign-in wall and no study data while signed out. Supabase not configured: the existing local-only behavior, unchanged.
2. Legacy device data (`studytime:data` and every backup key) is never uploaded or claimed automatically. Linking it to an account needs explicit confirmation naming the account (M4.3).
3. Accounts are separate (each person has their own). In-app password change: built in M4.1. Password recovery (reset by email): later.
4. Cross-device deletion (future sync): preserve sessions and resurrect a class if deleting it would destroy sessions added or edited on another device. Not built; no cloud conflict resolution exists yet.
5. No change to deployed migrations, schema, RPCs, RLS or production data in M4.0/M4.1. See "Security note" below.
6. SQL tests never run against production. See "Test environment before M4.2".
7. Sync cadence (future): polling plus focus/visibility and online triggers. Realtime deferred.
8. Strictly per-user data, no shared classes. Sized for thousands of sessions per user per year.

## Milestones

| Milestone | Status | Summary |
| --- | --- | --- |
| M4.0 | **Implemented** | Test helpers: `tests/helpers/fake-auth.ts` (fake Supabase auth that signs in/out, switches users, emits token-refresh events) and `tests/helpers/memory-storage.ts` (records every read and write). Decisions recorded here. A fake sync backend was **not** built: nothing uses it until M4.2/M4.4. |
| M4.1 | **Implemented** | Per-account local storage, sign-in wall, provider remount per account, sign-out guard while a timer runs, read-only legacy-data notice and download, in-app password change. No network sync. |
| M4.2 | **Verified on a test project; not applied to production** | Migration `20261029120000_studytime_sync.sql` (`sync_state`, `pull_snapshot()`, `push_changes()`, `import_and_init_sync()`, direct writes revoked) and `supabase/tests/sync_verify.sql`. Passed on local PGlite (shimmed), the SQL suites on a separate Supabase test project (owner-reported) and the core API verification there (43 checks, 0 failed, cleanup verified clean). Not yet tested: the 20-request concurrency stress check, the 1,000-row snapshot case, a real two-connection lock test. Not applied to production. Details in `supabase/README.md`. |
| M4.3 | Planned | First link: upload or adopt legacy data with named confirmation, read-back verification. |
| M4.4 | Planned | Push/pull engine, three-way merge, retry/backoff, sync status UI. |
| M4.5 | Planned | Polling, focus/online triggers, multi-tab safety. |
| M4.6 | Planned | Sign-out flush and warning, session-expiry recovery, real-device checks. |

Recommended sync design for M4.2+ (unchanged from the plan): a per-user revision number; clients push deltas with the revision they last saw; the server applies them atomically only if the revision still matches; on mismatch the client pulls a consistent snapshot and does a three-way merge (base, local, remote) by stable id. Sessions are a union by id. Delete versus edit keeps the class (decision 4).

## What M4.1 does (implemented)

- `AccountBoundary` (`features/data/account-boundary.tsx`) sits inside `AuthProvider` and mounts `StudyDataProvider` and `TimerProvider`:
  - `disabled` (Supabase not configured): legacy bucket `studytime:data`, as before.
  - `loading` / `signed-out`: `SignInWall`. No data provider is mounted, nothing is read from storage.
  - `signed-in`: that user's bucket `studytime:u:<userId>:data`, keyed by user id so a different user remounts everything.
- `lib/account-store.ts`: `createAccountStore(userId)`; no reset, no migrations, no backup writes. An unreadable payload is kept aside under `studytime:u:<userId>:data:corrupt`. `peekLegacyData()` reads the legacy bucket without writing.
- Sign-out never removes any key. Backups (`*:pre-flatten-backup`, `*:pre-seed-cleanup-backup`, `*:pre-reset-backup`, `*:corrupt`) are untouched by accounts.
- A running timer is owned by the provider instance of the account that started it. Switching account remounts it (idle). Signing out from Settings is disabled while the timer is running or paused.
- Settings shows a "Saved before accounts" card to a signed-in user when the legacy bucket has data. It only reports counts and offers a download after a confirmation that names the account. It does not upload, claim, or modify anything.
- Change password (signed-in): re-checks the current password, then `updateUser({ password })`. Minimum 8 characters client-side; the server may enforce more. Other devices stay signed in.

## Limitations of M4.1 (known, intentional)

- **Nothing syncs.** Data is per browser, per account. Another device sees nothing.
- **A new account starts empty on a device that has legacy data.** The legacy data is not shown. Until M4.3, the only way to use it in an account is: Settings → "Saved before accounts" → download, then Backup → Import data (this replaces that account's local data after the existing confirmation).
- **Involuntary sign-out loses a running timer.** If the session ends while a timer is running (another tab signs out, or the refresh token is rejected), the wall replaces the app and the in-memory timer is discarded, unsaved. It is never saved into another account. The timer was already memory-only (lost on reload). Settings blocks the voluntary case.
- **Isolation is in the UI, not encryption.** Anyone with dev tools on a shared device can read every bucket.
- **Two tabs on the same account can still overwrite each other** (each writes whole snapshots). This existed before; M4.5 addresses it.
- Local save failures (quota, private mode) are swallowed, as in the legacy store; the account store does not surface them.
- Not verified: a real sign-in against the live project, iPhone/iPad Safari, the iOS home-screen app keeping the session.

## Security note: direct table writes (closed in the M4.2 migration; verified on a test project, not applied to production)

The deployed M2 schema lets `authenticated` write the data tables directly (RLS limits rows to the owner), which would bypass a revision check. The M4.2 migration closes this: it revokes insert/update/delete on the data tables (and insert on `local_imports`) from `authenticated` and routes all writes through `SECURITY DEFINER` RPCs that derive the owner from `auth.uid()`. This reverses the M2 "invoker only" choice on purpose; the rules that make it safe are in the migration header and `supabase/README.md`. Residual risk: `service_role`, the dashboard and the `postgres` role still bypass the gate. On the test project all 13 direct write attempts were denied with `42501`. Production still has the M2 grants until the migration is applied there.

## Test environment before M4.2

M4.2 changes the schema, so its SQL must be tried somewhere that is not your real data first. Options, in order of preference:

1. **A second, free Supabase project** named e.g. `studytime-test`. In its SQL editor run the two existing migrations in order, then the new M4.2 migration, then the new `supabase/tests/sync_verify.sql`. Create two test users (Authentication → Users, Auto Confirm). Never put its URL or keys in your real `.env.local`.
2. **Local Supabase** (`npx supabase start`) if Docker Desktop is installed; the migrations in `supabase/migrations/` apply automatically. Fully offline and disposable.
3. Only after both pass: you review the M4.2 migration and apply it to your real project yourself.

For app testing against the test project, put its URL and anon key in a separate env file or temporarily in `.env.local`, then switch back. Use dummy study data there.
