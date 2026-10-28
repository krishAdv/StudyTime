# StudyTime database (Supabase)

Status: both migrations applied to the owner's Supabase project and `tests/verify.sql` passed. The app uses Supabase for sign-in only (M3); it does not read or write these tables yet.

## Files

| File | What it does |
| --- | --- |
| `migrations/20261027120000_studytime_schema.sql` | `classes`, `groups` (the app's subgroups), `sessions`; constraints, indexes, `updated_at` triggers, column-level grants, Row Level Security |
| `migrations/20261027120100_studytime_import.sql` | `local_imports` table and `import_local_data(import_id, payload)` for the future first-login import of an M1 export file |
| `tests/verify.sql` | Manual verification script (isolation, constraints, deletion, import). Rolls back when finished |

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

Everything in this directory is unexecuted. In particular still to confirm on a real PostgreSQL 15+ / Supabase instance: that both migrations apply cleanly; the column-list `SET NULL` foreign key and the class-delete cascade together; RLS and column grants behave as the script expects; `import_local_data` runs as `authenticated` under an empty `search_path`; and that the test script's `auth.users` inserts are accepted by your project.
