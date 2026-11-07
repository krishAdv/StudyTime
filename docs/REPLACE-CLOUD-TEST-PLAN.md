# Replace cloud: verification against the real test project

Status: **Stage A and Stage B have passed on the TEST project** (owner-reported; Stage B: 15 passed, 0 failed, 4 informational, account left empty). Nothing here ever ran against production. The scripts stay in the repository to re-run, for example after a change to Replace cloud.

Test project: `tjvpwextkocihvoevffo`. Production: `qnqsqxytmtonklhjwyrx` (never used, never modified).

## What is being verified

Replace cloud (M4.3 S9, `src/lib/sync/escape.ts`) deletes every cloud class that differs from this device's version and recreates it **with the same id** in ONE `push_changes` call. The SQL says that should work and be all or nothing. The fake server agrees, but no test has run it on a real database. Class **display order** after a replace is a known, accepted cosmetic change (a recreated class sorts after the untouched ones) and is only recorded, not asserted.

| Stage | What | Where it runs | Writes data? |
| --- | --- | --- | --- |
| Pre-flight | Shows which project the configuration points at; refuses production or anything but the test project | Your machine only | No, and makes no connection |
| A | `supabase/tests/replace_cloud_check.sql`: the SQL semantics, in one transaction that ends in ROLLBACK | The test project's database | Temporarily, rolled back |
| B | `scripts/stage-b/replace-cloud-check.ts`: the real adapter and planner over the real API, as a throwaway account | The test project's API | Yes, in one throwaway account; always emptied at the end |
| C | Two real devices | (later, after A and B) | Test project |

## The production guard (`scripts/lib/project-guard.ts`)

It is an allow-list: a run proceeds only if the project is **provably** the test project. It never connects to anything.

- **Project reference:** read from `NEXT_PUBLIC_SUPABASE_URL` (must be exactly `https://<ref>.supabase.co`; localhost, custom domains, `http`, ports and unreadable URLs are refused) or from `DATABASE_URL` (`db.<ref>.supabase.co`, or a pooler user `postgres.<ref>`).
- **Refused:** production, any other project, and anything where production's reference appears anywhere in the URL, key or database URL.
- **Keys:** an anon JWT must carry the same project reference as the URL (a mismatch is refused); a service-role or secret key is refused; `SUPABASE_SERVICE_ROLE_KEY` anywhere in the environment is refused; publishable keys (`sb_publishable_…`) are accepted but carry no reference, so the URL is the only proof there.
- **`.env.local` is never used.** The scripts are started with `scripts/vite.scripts.config.ts` (`envDir: false`), so the tool does not load it (it holds production's URL). As a second layer the guard refuses a URL or key identical to the one in `.env.local`. The pre-flight reports where `.env.local` and `supabase/.temp/project-ref` point, never printing a key.
- **Stage B also needs you to type the project reference** into `STAGE_CONFIRM_PROJECT`, and a dedicated **empty** throwaway account.
- **What the guard cannot do:** SQL cannot tell which project it runs on. For Stage A the protection is that you start it with a `DATABASE_URL` the pre-flight accepted (or paste into the SQL editor **of the test project only**, checking the project reference in the browser address bar first).

How it was checked offline (no connection was made): environments with nothing set, the production URL, another project, a localhost URL, a service-role key, a key of the wrong project, a key identical to `.env.local`'s, and production and test `DATABASE_URL`s (direct and pooler) all gave the expected accept or refuse.

## Before anything: create the throwaway account (Stage B only)

In the **test** project's dashboard (Authentication → Users), create a user such as `replace-test@example.test` with a password. This account must stay empty (never use it in the app). Do not use the real user.

## Pre-flight (always first, same terminal)

Set the variables for this terminal session only (do not put them in any file). PowerShell:

```powershell
$env:NEXT_PUBLIC_SUPABASE_URL = "https://tjvpwextkocihvoevffo.supabase.co"
$env:NEXT_PUBLIC_SUPABASE_ANON_KEY = "<the TEST project's anon or publishable key>"
npx vite-node -c scripts/vite.scripts.config.ts scripts/sync-preflight.ts app
```

Expected: `RESULT: OK` and `PRE-FLIGHT PASSED`. Any `REFUSED` line means stop and fix the setting. For Stage A also set `DATABASE_URL` (Dashboard → Connect → the **session pooler or direct** string, not the transaction pooler on 6543, which does not suit one long transaction) and run the same command with `db` instead of `app`.

## Stage A: SQL semantics

Prerequisite: the three migrations (schema, import, sync) are applied to the test project.

```powershell
$env:DATABASE_URL = "postgresql://postgres.tjvpwextkocihvoevffo:<password>@<session-pooler-host>:5432/postgres"
npx vite-node -c scripts/vite.scripts.config.ts scripts/sync-preflight.ts db     # must say PRE-FLIGHT PASSED
psql $env:DATABASE_URL -v ON_ERROR_STOP=1 -f supabase/tests/replace_cloud_check.sql
```

Alternative without psql: open the SQL editor of the test project (check `tjvpwextkocihvoevffo` in the address bar), paste the file, run it.

- **What it does:** one transaction with fake users, ends in `ROLLBACK`; nothing is left behind. It checks: delete and recreate class, subgroup and session ids in one push (revision +1, B untouched, new values, new color); `delete_group` keeps the session (column-list `SET NULL` on the real database); name reuse; a subgroup id reused under another class; all-or-nothing for a bad operation, a wrong `expectedSessions` (`ST004`), a duplicate id and a case-only name clash (`ST003`), and a missing subgroup (`22023`); stale and empty pushes; delete everything and refill; another account unaffected. Section 7 only prints how the database folds case for a few names (INFO).
- **Pass:** a row `ALL CHECKS PASSED` and no error. **Fail:** an error naming the check; stop and report it, do not retry blindly.

## Stage B: the real adapter and planner

```powershell
npx vite-node -c scripts/vite.scripts.config.ts scripts/stage-b/replace-cloud-check.ts --offline   # no network: proves it loads (safe)

$env:STAGE_CONFIRM_PROJECT = "tjvpwextkocihvoevffo"
$env:STAGE_B_EMAIL = "replace-test@example.test"
$env:STAGE_B_PASSWORD = "<its password>"
npx vite-node -c scripts/vite.scripts.config.ts scripts/sync-preflight.ts app        # must pass
npx vite-node -c scripts/vite.scripts.config.ts scripts/stage-b/replace-cloud-check.ts
```

- **Order of safety:** guard, then sign-in as the throwaway account, then it refuses unless the account is empty, then the checks; it always ends by emptying the account and verifying that. Cleanup uses raw `delete_class` operations (`scripts/stage-b/cleanup.ts`), not the app's planner: B9 stores names the database accepts but the app's validator calls duplicates, and the planner cannot plan anything for a snapshot the validator rejects.
- **Checks:** B1 seed; B2 the same-id replace through the real plan (one call accepted, revision +1, reads back exactly equal, class A deleted and recreated, class B untouched) and the resulting class order (recorded); B3 an identical replace sends nothing; B4 stale; B5 and B6 a failed push undoes everything over real HTTP; B7 two simultaneous pushes (one applies, one is stale); B8 replace with 500, 2,000 and 4,900 sessions (time, size, any gateway or timeout limit) and 5,100 refused by the app; B9 name folding (INFO: for each pair it reports whether the database accepted it and what the app's validator makes of it; an accepted pair is removed again with raw deletes of just its own two classes, and any error other than the expected `ST003` stops the run).
- **Interrupted or failed run:** see "Recovery after an interrupted run" below. Do not delete rows by hand, and do not rerun the full Stage B first (it refuses a non-empty account, by design).
- **Afterwards:** clear the variables:

```powershell
Remove-Item Env:NEXT_PUBLIC_SUPABASE_URL, Env:NEXT_PUBLIC_SUPABASE_ANON_KEY, Env:STAGE_CONFIRM_PROJECT, Env:STAGE_B_EMAIL, Env:STAGE_B_PASSWORD, Env:DATABASE_URL -ErrorAction SilentlyContinue
```

## Recovery after an interrupted run (`--cleanup`)

Use this when a Stage B run was killed, crashed, or ended with a failed cleanup line, so the throwaway account may still hold test data. `--cleanup` only empties that account. It writes nothing else.

1. Use the same PowerShell window, with the same variables set as for Stage B (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `STAGE_CONFIRM_PROJECT`, `STAGE_B_EMAIL`, `STAGE_B_PASSWORD`).
2. Run the pre-flight. It must print `PRE-FLIGHT PASSED`:

   ```powershell
   npx vite-node -c scripts/vite.scripts.config.ts scripts/sync-preflight.ts app
   ```

3. Run the cleanup:

   ```powershell
   npx vite-node -c scripts/vite.scripts.config.ts scripts/stage-b/replace-cloud-check.ts --cleanup
   ```

4. Read the result:
   - **Success:** `CLEANUP ONLY: the account holds N class(es): ...`, then `PASS  cleanup-only: the test account is empty  (N class(es) removed, revision R)` and `STAGE B: ALL CHECKS PASSED` (exit 0). An account that is already empty also passes and sends nothing.
   - **Refused (exit 2):** `Refused: N class(es) are not ones this script creates (...)`, or `Refused: the account now holds class(es) this script does not create (...)`. The account holds a class with an id Stage B never creates, so it does not look like the throwaway account. **Nothing was sent or changed.** Stop, check that `STAGE_B_EMAIL` is the throwaway account, and do not clean it up by hand without looking at what is in it.
   - **Failure (exit 1):** the line `FAIL  cleanup-only: ...` carries the reason (for example a stale answer because something else pushed, or a network or server error). Nothing is partly deleted: the delete is one all-or-nothing push. Run it again.
5. Run the full Stage B again from the start.

What `--cleanup` does, in order: the production guard (URL must be the test project, a matching public key, no service-role key, `STAGE_CONFIRM_PROJECT` typed by you), sign-in as the throwaway account, one read of the account, a first identity check (every class id must be one of `A`, `B`, `Load`, `u1`, `u2`, `R1`, `R2`, the ids Stage B creates), then the delete, which takes its OWN fresh read and repeats the identity check on that snapshot before building any operation (an unexpected class that appeared in between is refused and nothing is sent), then a single `push_changes` that deletes each class with its exact session count as `expectedSessions`, at the revision of that same read (a stale answer deletes nothing), then a read-back that must show the account empty.

## Reading the results

- A Stage A or B failure of the same-id check means Replace cloud must not be used as built; report the exact message (the fix would be a different plan, not a retry).
- A size or time failure in B8 means the one-push size guard (currently 5,000 operations or about 3 MB) is too high for the real limits; lower it before any real-device test.
- B7 failing means the per-user lock is not behaving as the migration assumes.

Stage C (two real devices) follows only after A and B pass, and is described in the S9 notes of `docs/PROJECT_STATUS.md`.
