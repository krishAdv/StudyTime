# StudyTime database (Supabase)

Status: the first two migrations are applied to the owner's Supabase project and `tests/verify.sql` passed. The M4.2 sync migration (`20261029120000_studytime_sync.sql`) is applied to a **separate test project only** (ref `tjvpwextkocihvoevffo`) and is **not applied to production**. It has passed the PGlite run, the SQL suites on the test project (as reported by the owner) and the core API verification below. That is not a production-readiness sign-off: see "Not yet tested". The app uses Supabase for sign-in only (M3); it does not read or write these tables yet.

## Files

| File | What it does |
| --- | --- |
| `migrations/20261027120000_studytime_schema.sql` | `classes`, `groups` (the app's subgroups), `sessions`; constraints, indexes, `updated_at` triggers, column-level grants, Row Level Security |
| `migrations/20261027120100_studytime_import.sql` | `local_imports` table and `import_local_data(import_id, payload)` for the future first-login import of an M1 export file |
| `migrations/20261029120000_studytime_sync.sql` | **M4.2, applied to the test project only, not to production.** `sync_state`, `pull_snapshot()`, `push_changes()`, `import_and_init_sync()`; revokes direct writes to the data tables |
| `tests/verify.sql` | Manual verification of migrations 1 and 2 (isolation, constraints, deletion, import). Run it **before** the M4.2 migration; it cannot pass after it. Rolls back when finished |
| `tests/sync_verify.sql` | Manual verification of the M4.2 migration. Rolls back when finished |

## PostgreSQL version

The schema needs **PostgreSQL 15 or newer** for `ON DELETE SET NULL (group_id)` (column list added in PostgreSQL 15; 15.13+ recommended). Supabase's current default for new projects is PostgreSQL 17, and Postgres 14 is being retired there. Check the version of your project (Dashboard → Database, or `select version();`) before applying. On 14 the second foreign key would be a syntax error.

## Applying (when you are ready; not done yet)

Create a **disposable** project first. Either paste the two migration files, in order, into the dashboard SQL editor, or with the Supabase CLI link the project and run `supabase db push`. Then run `tests/verify.sql` (see its header). Only after it passes on the disposable project, apply the same files to the real one.

No secrets belong in this repository. The browser will use only the project URL and the public anon key; never the service-role key.

## Model and rules

- Primary keys are `(user_id, id)` with the app's existing text ids, so the same ids can exist in two accounts. `user_id` defaults to `auth.uid()`.
- Subgroup ids are unique per user across all classes (sessions reference them by id alone in the app). A subgroup has no parent column, so it is one level by construction.
- Class names are unique per user, subgroup names per class, after trim + whitespace collapse + lower-case. A check constraint also requires the stored name to already be normalized (the app always normalizes), which keeps the unique index equivalent to the app rule.
- A session's subgroup must belong to the session's class: composite foreign key `(user_id, class_id, group_id) -> groups(user_id, class_id, id)`.
- Class delete cascades to subgroups and sessions. Subgroup delete nulls only `sessions.group_id`.
- `sessions.started_at` is `timestamptz`; app epoch milliseconds convert exactly. Read back with `(extract(epoch from started_at) * 1000)::bigint`.
- Clients can update only: class `name`/`color`, subgroup `name`, session `class_id`/`group_id`. Everything else is immutable from the client.
- Order of classes/subgroups is `created_at`.
- No soft deletion, no `updated_at`-based sync yet; `updated_at` is maintained for the future sync milestone.

## Row Level Security

RLS is on for all four tables. Per command (select, insert, update, delete) there is one policy for `authenticated`, restricted to `user_id = (select auth.uid())`, with `WITH CHECK` on insert and update. `anon` has no grants and no policies. `local_imports` allows select and insert for the owner only.

## `import_local_data(p_import_id text, p_payload jsonb)`

Takes the whole M1 export file. It is **SECURITY INVOKER**, deliberately: nothing in it needs more than the caller already has, so RLS, column grants and ownership checks apply to every statement. Ownership is always `auth.uid()`; `user_id` fields in the payload are ignored. `search_path` is empty and all names are schema-qualified. Execute is granted to `authenticated` only.

One call is one transaction (all or nothing). Caps: 1000 classes, 1000 subgroups per class, 100000 sessions.

| Outcome | Meaning for the app |
| --- | --- |
| `{"status":"imported"}` | This call committed everything |
| `{"status":"already_imported"}` | Same import id **and** identical payload already committed: safe retry, treat as success |
| SQLSTATE `ST001` | Same import id, different payload: do not retry |
| SQLSTATE `ST002` | Account already has study data and there is no matching completed import: do not import (prefer cloud) |
| SQLSTATE `22023` (`invalid_payload: ...`) | Payload/id rejected; nothing was written |
| SQLSTATE `28000` | Not signed in |

Because the import is atomic, an incomplete import cannot exist. After a lost response, call again with the **same** import id: the answer is `already_imported` if it had committed, or it imports now if it had not. The app should generate the import id once per attempt and keep it until it sees a result.

## Not verified yet / needs a live project

**Owner-reported (not independently re-run in this session):** the two M2 migrations and `tests/verify.sql` were run on the separate Supabase test project.

**Verified in this session:** the M2 migrations and `verify.sql` passed on local PGlite (see "Preliminary PGlite run"; shimmed, not Supabase). The M4.2 migration and the core API verification were executed on the separate test project, and the API verification was run in this session (results under "API verification on the test project").

**Production:** the M4.2 migration has not been applied to production.

**Still not independently verified on real Supabase:** the column-list `SET NULL` foreign key and the class-delete cascade together (PGlite and the owner's run only); that `import_local_data` succeeds under an empty `search_path` for a real signed-in user (the API check exercised only its refusal path, `ST002`); and that the test script's `auth.users` inserts are accepted by the project (owner-reported).

## M4.2: sync primitives (verified on a test project; not applied to production)

Migration `20261029120000_studytime_sync.sql`. The app does not call any of this yet (client sync is M4.4).

### What it adds

| Object | Purpose |
| --- | --- |
| `sync_state(user_id, revision, updated_at)` | One row per user; `revision` counts committed changes (0 = never written through sync). The owner can read it; nobody can write it directly |
| `pull_snapshot()` | `SECURITY INVOKER`, read-only. One jsonb value: `{revision, classes, groups, sessions}` read in a single statement, so it is consistent. A scalar, so PostgREST's 1,000-row limit does not apply |
| `push_changes(p_base_revision, p_changes)` | `SECURITY DEFINER`. Takes the per-user advisory lock, compares the base revision with the current one, then applies an ordered list of changes. Stale base: returns `{"status":"stale","revision":n}` and writes nothing. Otherwise all changes apply atomically and the revision rises by exactly 1 (not at all if nothing changed) |
| `import_and_init_sync(p_import_id, p_payload)` | `SECURITY DEFINER`. Calls `import_local_data` and creates/raises `sync_state` in the same transaction. Same outcomes as the import (`imported`, `already_imported`, `ST001`, `ST002`, `22023`) plus `revision` |

Change types for `push_changes` (field names as in the export file; unknown keys, including any `user_id`, are ignored): `add_class`, `update_class`, `delete_class` (needs `expectedSessions`), `add_group`, `rename_group`, `delete_group`, `add_session`, `move_session` (only `classId`/`groupId` change). The full contract is in the comments above each function.

Errors: `28000` not signed in; `22023` invalid input (shape, unknown change type, constraint violation, missing reference, size limit); `ST003` name or id conflict; `ST004` `delete_class` found a different number of sessions than expected. Everything except a stale revision is an error and writes nothing. A stale revision is a normal return value, so callers must check `status`.

Limits: 5,000 changes and 4 MB per push; 1,000 classes, 1,000 subgroups per class, 100,000 sessions per user; import payload 32 MB.

### Security decisions

- **Direct writes are revoked.** `authenticated` loses insert/update/delete on `classes`, `groups`, `sessions` and insert on `local_imports`; it keeps `select` (RLS: own rows). Otherwise any client could write straight to the tables and skip the revision check. The M2 RLS write policies stay as a second layer.
- **Writes use `SECURITY DEFINER`** because the caller can no longer write. This reverses the M2 "invoker only" choice on purpose. Every definer function derives the owner from `auth.uid()` and never accepts a user id; filters or inserts by that id on every statement (RLS does not protect definer code); has `search_path = ''`, schema-qualified names and no dynamic SQL; and is executable by `authenticated` only.
- `import_local_data` is no longer callable by clients (it would write data without touching `sync_state`). `import_and_init_sync` calls it with the owner's privileges, and it still uses `auth.uid()`.
- The internal payload helpers (`sync_text`, `sync_opt_text`, `sync_whole`) are not executable by clients.
- **Deleting never silently loses sessions.** `delete_group` keeps sessions and clears their subgroup. `delete_class` deletes sessions only if their current count equals `expectedSessions`, else `ST004`. Sessions are deleted explicitly before the class, so no `SET NULL` cascade is involved. There is no session-delete change type.
- A repeated push with the same base revision is stale, never applied twice. A lost push response is recovered by pulling.
- Accounts with rows before this migration get `revision = 1`, so a client that never pulled (base 0) is stale. (None are expected.)

### Remaining risks

- Anything that bypasses PostgREST and RLS still bypasses the gate: the `service_role` key, the dashboard SQL editor, and the `postgres` role. Do not edit these tables there while devices sync. (A revision-bumping trigger was not added: it would double-count with the RPCs.)
- `pull_snapshot` returns the whole account in one response. At the caps this is roughly 15 MB and may hit Supabase's statement timeout or response limits; not measured. Revisit with paging before accounts get that large.
- Stale detection is all or nothing per user: any change from another device makes the next push stale, even if the changes do not overlap. Merging is the client's job (M4.4).
- `delete_class` trusts the client's `expectedSessions`. It stops unseen sessions being destroyed; it does not stop a client that miscounts on purpose (that only affects its own account).
- Name normalization differences between JavaScript and PostgreSQL (see the schema migration) still apply.
- The core behavior has been verified on a real Supabase test project (see "API verification on the test project"). Concurrency, large snapshots and production behavior are not; see "Not yet tested".

### How to test safely (nothing here touches production)

This repo is **linked to the production project**: `supabase/.temp/project-ref` is committed and `.env.local` holds its URL. Do not run `supabase db push` or `supabase db reset --linked`, and do not paste SQL into that project's SQL editor.

Option 1, a second free Supabase project (no Docker needed):
1. Create a project named e.g. `studytime-test` (PostgreSQL 15 or newer). Check that its project ref differs from the production one.
2. In its SQL editor run, one file at a time and in this order: the two M2 migrations, then `tests/verify.sql` (expects `ALL CHECKS PASSED`), then `migrations/20261029120000_studytime_sync.sql`, then `tests/sync_verify.sql`.
3. No test users are needed: both scripts create fake users inside a transaction that ends in `ROLLBACK`.
4. `sync_verify.sql` can be re-run at will. `verify.sql` only passes on a project that does not yet have the sync migration.

Option 2, local Supabase (needs Docker Desktop): `npx supabase init` (creates `supabase/config.toml`), `npx supabase start`, then run the same files in the same order with `psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f <file>`, using only the local URL it prints.

Only after both scripts pass on the test project should you review the migration and apply it to production yourself.

### Two-session concurrency check (manual)

`sync_verify.sql` runs in one transaction, so it cannot show two pushes racing. On the test project, use two SQL sessions signed in as the same fake user (set `request.jwt.claims` in each, as `st_test.login` does). In session 1 run `begin; select public.push_changes(0, '[{"op":"add_class","id":"r1","name":"Race","color":"#000000"}]');` and leave it open. In session 2 run the same call with class id `r2` and name `Race 2`. Session 2 should wait. Commit session 1: session 2 then returns `status: stale`, and only `r1` exists.

### Preliminary PGlite run (2026-10-29, local, in memory)

PGlite 0.5.13 (PostgreSQL 18.6 compiled to WASM) was installed outside the repo. A small shim created the roles `anon`, `authenticated`, `service_role`, an `auth.users` table, Supabase's `auth.uid()`, and Supabase's default grants for new `public` objects. Result: both M2 migrations applied, `verify.sql` passed (91 checks), the M4.2 migration applied, `sync_verify.sql` passed (228 checks). No migration or test was edited to get there. Three deliberately broken copies of the migration (direct writes left granted, revision check removed, `delete_class` count guard removed) each made `sync_verify.sql` fail, so the tests do detect those defects.

What this does not prove: the connection role was a superuser (the real `postgres` role is not); there is one connection, so no concurrency; no PostgREST, so no `supabase.rpc` behavior, response limits or statement timeout; not PostgreSQL 15 to 17; not Supabase's real `auth` schema or grants. Role-permission and RLS results are real engine behavior for a non-superuser role, but on shimmed grants.

### API verification on the test project (2026-10-29, core checks only)

**Where and how:** an external script (`verify-api.mjs`, kept outside the repo and not committed) ran against the separate test project `tjvpwextkocihvoevffo` using `@supabase/supabase-js`, the project's public publishable key and two test accounts. It never touched production, never used a service-role or secret key, and its guards (production-ref block, host lock, key-type check, session-issuer check) all passed. The optional 20-request stress check was not enabled.

**Result:** exit code 0; 43 checks passed, 0 failed, 0 review, 0 inconclusive, 0 skipped prerequisites (1 optional check skipped).

**Verified:**
- Both test users signed in as two distinct users.
- A can pull and push its own data; the pull returned the exact values pushed, and A can read its own `sync_state` row and class directly.
- User isolation: B's pull and direct selects never returned A's rows; five attempts by B to update, delete or move A's rows, or to add rows into A's class, were each rejected with `22023`; A's data stayed byte-identical.
- Forged ownership fields: a push whose payload named A as owner (`user_id` and `userId`) was accepted and landed in B's account only.
- All 13 direct write attempts (insert, update and delete on `classes`, `groups`, `sessions` and `sync_state`, and insert on `local_imports`) were denied with `42501 permission denied`.
- RPC permissions: `import_local_data` and the internal `sync_text` helper are not callable by an authenticated user; `import_and_init_sync` into an account that already has data was refused with `ST002`.
- Anonymous access: `pull_snapshot`, `push_changes` and selects on `classes` and `sync_state` were all rejected.
- Revision gate: an older base revision, a base from the future, and a replay of the first push were each returned as `stale` and created nothing and no duplicates.
- Cleanup was verified clean: everything the run created was removed through `push_changes` (`delete_class`), a final scan found no run-created class, subgroup, session or import record, and no test-created rows remain.
- The `sync_state` revision counters were intentionally left changed (now 2 for each test user): only the RPCs write them, so they cannot be reset through the API.

**Also reported by the owner, not re-run in this session:** the two M2 migrations, `tests/verify.sql`, the sync migration and `tests/sync_verify.sql` had been run successfully on the test project before this check.

### Not yet tested

- The optional 20-request concurrency stress check (and it would be a stress check, not proof of concurrency correctness).
- The 1,000-row snapshot case: `pull_snapshot` through the API with more than 1,000 rows, and its response size and timeout at larger sizes.
- A real two-connection lock test (the manual two-session check above).
- Direct local decoding of the publishable key's project and role claims: the key format cannot be decoded locally, so its project and role were not checked by the script. The test project accepted it, and the key was confirmed not to be a secret key.
- Production: the migration has not been applied to production, and nothing here says the whole sync system is ready for production. The client sync engine (M4.3 onward) does not exist yet.
