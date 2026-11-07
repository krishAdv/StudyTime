# M4: cloud sync plan and decisions

Status key: **Implemented** (in the code and covered by tests), **Planned** (not built; do not assume it works).

## Decisions (from the owner)

1. Supabase configured: a sign-in wall and no study data while signed out. Supabase not configured: the existing local-only behavior, unchanged.
2. Legacy device data (`studytime:data` and every backup key) is never uploaded or claimed automatically. Linking it to an account needs explicit confirmation naming the account (M4.3).
3. Accounts are separate (each person has their own). In-app password change: built in M4.1. Password recovery (reset by email): later.
4. Cross-device deletion (sync): sessions are never silently discarded. As built in the S4 merge (`src/lib/sync/merge.ts`), a delete on one device against an edit, or against something added to or moved into the deleted class or subgroup on another device, is reported as a conflict and nothing is resolved automatically. (An earlier version of this plan said the class would simply be resurrected; that is not the approved behavior.) Two cases merge automatically: a session moved out of a deleted class to a class that survives keeps its move, and untouched sessions of a deleted subgroup stay in their class without a subgroup (with a warning). How a user resolves a conflict is designed and approved (S5) but not implemented; no cloud conflict resolution runs in the app.
5. No change to deployed migrations, schema, RPCs, RLS or production data in M4.0/M4.1. See "Security note" below.
6. SQL tests never run against production. See "Test environment before M4.2".
7. Sync cadence (future): polling plus focus/visibility and online triggers. Realtime deferred. The first version (M4.3) uses app start, a manual trigger, debounced local changes and reconnect; polling and focus triggers and cross-tab locking wait for M4.5.
8. Strictly per-user data, no shared classes. Sized for thousands of sessions per user per year.

## Milestones

| Milestone | Status | Summary |
| --- | --- | --- |
| M4.0 | **Implemented** | Test helpers: `tests/helpers/fake-auth.ts` (fake Supabase auth that signs in/out, switches users, emits token-refresh events) and `tests/helpers/memory-storage.ts` (records every read and write). Decisions recorded here. A fake sync backend was **not** built: nothing uses it until M4.2/M4.4. |
| M4.1 | **Implemented** | Per-account local storage, sign-in wall, provider remount per account, sign-out guard while a timer runs, read-only legacy-data notice and download, in-app password change. No network sync. |
| M4.2 | **Verified on a test project; not applied to production** | Migration `20261029120000_studytime_sync.sql` (`sync_state`, `pull_snapshot()`, `push_changes()`, `import_and_init_sync()`, direct writes revoked) and `supabase/tests/sync_verify.sql`. Passed on local PGlite (shimmed), the SQL suites on a separate Supabase test project (owner-reported) and the core API verification there (43 checks, 0 failed, cleanup verified clean). Not yet tested: the 20-request concurrency stress check, the 1,000-row snapshot case, a real two-connection lock test. Not applied to production. Details in `supabase/README.md`. |
| M4.3 | **In progress** (umbrella, steps S1 to S12) | The client sync engine, including safe legacy-bucket linking (upload or adopt legacy data with a confirmation that names the account, read-back verification). S1 to S4 are done; S5 has an approved design, its Phases 0 and 1 are done, Phases 2 and 3 (restore-only) are implemented but pending review, and Phases 4 and 5 are skipped for now; see "M4.3 steps" below. |
| M4.4 | Absorbed into M4.3 | The push/pull engine and the three-way merge are steps inside the M4.3 umbrella (the diff planner S3 and the merge S4 are done; the engine is a later step). Retry/backoff and the sync status UI are not yet placed in a numbered step. |
| M4.5 | Planned | Polling, focus/online triggers, multi-tab safety. |
| M4.6 | Planned | Sign-out flush and warning, session-expiry recovery, real-device checks. |

Recommended sync design for M4.2+ (unchanged from the plan): a per-user revision number; clients push deltas with the revision they last saw; the server applies them atomically only if the revision still matches; on mismatch the client pulls a consistent snapshot and does a three-way merge (base, local, remote) by stable id. Sessions are a union by id. A delete against an edit, or against an added or modified dependent, is a conflict for the user to decide (decision 4).

## M4.3 steps (umbrella)

S1 to S6 are pure TypeScript under `src/lib/sync/` with injected dependencies. S7 wires the engine into the app (`src/features/sync/`, mounted for signed-in accounts) behind the build flag `NEXT_PUBLIC_STUDYTIME_SYNC=1` and a per-device opt-in, both off by default; S8 and S9 add the first-link flow, the conflict screen and the two escapes to the Settings card. Per-step results and checks are in `docs/PROJECT_STATUS.md`.

| Step | Status | Summary |
| --- | --- | --- |
| S1 | **Done** | Flat snapshot model and the eligibility check against the server's constraints. |
| S2 | **Done** | RPC adapter, strict response validators, error classification and the in-memory fake server. |
| S3 | **Done** | Diff planner: ordered, batched `push_changes` operations from a remote and a target snapshot. Refuses removal of a single session. |
| S4 | **Done** | Three-way merge `merge3(base, local, remote)`: merged, conflicted or refused; detect-only. |
| S5 | **Design approved; Phases 0 and 1 done, Phases 2 and 3 implemented (pending review), Phases 4 and 5 skipped for now** | Conflict resolution and explicit session removal (below). Phase 0 (documentation) and Phase 1 (fingerprints, decision types and validation, immutable-mismatch refusal) are done, and Phase 2 (field, move, add-mismatch, rename, ungroup and ungroup-session decisions applied by `merge3`) is implemented but pending review; Phase 3 (restore a deleted class or subgroup: `keep_class` / `keep_group`) is implemented but pending review; Phases 4 and 5 are skipped for now. |
| S6 | **Done (pending review)** | Sync engine `src/lib/sync/engine.ts`: `createSyncEngine(deps).syncOnce()` is pull, three-way merge, push, then bring local data in line. Injected dependencies, tested against the fake server; wired into the app in S7. |
| S7 | **Done (pending review)** | App wiring: `SyncProvider` next to the data and timer providers (signed-in accounts only), triggers, status UI (Settings card and a banner), per-device opt-in, behind the build flag `NEXT_PUBLIC_STUDYTIME_SYNC=1` (off by default). No first link yet (S8). |
| S8 | **Done (pending review)** | First link (`lib/sync/link.ts`, a confirmation panel in the Settings card): upload this device's data to an empty account, adopt the cloud's data on an empty device, or choose on a device where both have data ("use the cloud data" with a backup, or "combine both" when nothing clashes). Baseline saved only after the link really happened. |
| S9 | **Done (pending review)** | Conflict screen (plain-language choices submitted to the engine as decisions) and the two escapes for a linked device: "Use the cloud's data" and "Replace the cloud's data" (`lib/sync/escape.ts`), each with safety copies, a confirmation bound to what was shown, and a verified baseline. Replace cloud was verified on the test project: Stage A (SQL) and Stage B (API) passed (owner-reported); see `docs/REPLACE-CLOUD-TEST-PLAN.md`. |
| S10 to S12 | Not yet defined step by step | The remaining engine, persistence, real-project integration and UI work; scope is agreed one step at a time. |

**S5 boundaries (approved).** S5 is the conflict-resolution domain model only: decision points (one per deleted class or group), versioned fingerprints and decisions, explicit session removal, and a plan returned by the merge that is bound to the remote revision it was generated against. It does **not** include: persistent decision storage (only pure serialize/parse and validation), the sync engine, any UI, background or automatic synchronization, any SQL migration or new RPC. Removal reuses the existing operations (`move_session` into a class the same plan deletes, then `delete_class`, in one atomic batch), so the SQL stays unchanged; S3 keeps refusing unauthorized removals. Net session removal stays a refused case (`session_removal_unsupported`) until S5 lands. Rename decisions are validated in Phase 1 only for the name's own validity and for collisions among the names inside one decision. Since Phase 2, `merge3` also checks every rename against the final merged data when it applies the decision, using the existing scopes (class names unique across the app, subgroup names unique within their final parent class); a colliding rename is rejected, never adjusted. Rename decisions are judged in rounds, so a decision that is rejected cannot reject another one (see the PROJECT_STATUS S5 Phase 2 entry).

**Verification that S5 will not provide.** S5 is tested against the in-memory fake server only. Real Supabase verification of a moved-in session being counted by `delete_class` in the same push, and of full rollback when an operation fails after earlier moves, is deferred to the real-project integration milestone (no existing SQL test covers either).

S5 implementation phases (from the approved plan): 0 documentation (done); 1 fingerprints, decision types and decision points (done); 2 simple decisions (implemented, pending review); 3 deleted class and group decisions (restore-only, `keep_class` / `keep_group`, implemented, pending review; the destructive choices are not implemented); 4 revisions guard, absence rules, removal planning and plan binding; 5 pure decision document and crash/retry tests. Phases 0 and 1 are done and Phase 2 is implemented but pending review, not approved (Phase 1 added the exact-pinned direct dependency `@noble/hashes@2.4.0`, which was not in the original lockfile, used only for `sha256`; Phase 2 applies the straightforward decisions, and the choices for deleted classes and subgroups and for session removal stay unavailable). Phase 3 was cut down to restore-only by the owner (a restored class or subgroup keeps everything the surviving side holds; nothing is deleted); Phases 4 and 5 (removal planning, plan binding, stored decision documents) are skipped for now because the sync engine does not need them: the app cannot delete a single session, an unresolvable merge simply does not push, and the engine keeps the older-remote revision refusal. Those steps are now complete: the sync engine (S6), app wiring (S7), first link (S8) and the conflict and escape UI (S9), behind a feature flag and a per-device opt-in; the flag stays off until a real two-device test passes, which has not been done yet.

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
