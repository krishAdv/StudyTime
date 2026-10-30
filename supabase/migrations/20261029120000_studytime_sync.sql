-- StudyTime M4.2: database primitives for multi-device sync. NOT YET EXECUTED
-- against any database; see supabase/README.md for how to test it safely.
--
-- Adds (nothing in the two earlier migrations is edited):
--   * sync_state                       per-user revision counter
--   * pull_snapshot()                  consistent snapshot of the caller's data + revision
--   * push_changes(base, changes)      revision-gated, atomic, validated delta apply
--   * import_and_init_sync(id, file)   import_local_data + sync_state init, one transaction
--
-- Design decisions
--  * Writes go through RPCs only. The M2 grants let `authenticated` insert, update and
--    delete the data tables directly, which would bypass the revision gate (a stale
--    device could overwrite newer data from the same user). This migration REVOKES
--    insert/update/delete on classes, groups, sessions and local_imports from
--    `authenticated`; SELECT stays (RLS still limits it to the caller's own rows).
--    The RLS write policies from M2 stay in place as a second layer.
--  * push_changes and import_and_init_sync are SECURITY DEFINER because the caller no
--    longer has write privileges. That is a deliberate reversal of the M2 choice
--    (SECURITY INVOKER) and is safe only because of these rules, which every definer
--    function below follows:
--      - owner is auth.uid(), read inside the function; no user id is ever accepted
--        from the client, and any user_id-like keys in a payload are ignored;
--      - every statement filters or inserts with that user id explicitly (the definer
--        bypasses RLS, so RLS is NOT what protects these statements);
--      - search_path is empty and every name is schema-qualified; no dynamic SQL;
--      - EXECUTE is granted to `authenticated` only (not PUBLIC, not anon).
--  * pull_snapshot is SECURITY INVOKER and read-only: RLS applies to it.
--  * One user, one writer at a time: push_changes and import_and_init_sync take the same
--    per-user advisory lock as import_local_data, then read the revision, so the check
--    and all writes are one serialized unit.
--  * import_local_data (M2) is called from import_and_init_sync, so inside it runs with
--    the definer's privileges. Direct client calls to it are revoked, because it would
--    otherwise write data without touching sync_state.
--
-- Error contract (SQLSTATE) shared by the new functions:
--   28000  not signed in
--   22023  invalid input ('invalid_payload: ...'): wrong shape or type, unknown change
--          type, value rejected by a table constraint, reference to a row that does not
--          exist, too many changes or too much data. Nothing was written.
--   ST003  'conflict: ...': a class id, subgroup id, session id or name already exists
--          (unique violation). Nothing was written.
--   ST004  'delete_refused: ...': delete_class found a different number of sessions than
--          the client expected. Nothing was written; the client must pull and merge.
--   ST001 / ST002  from import_local_data, unchanged (see that function).
-- A stale base revision is NOT an error: push_changes returns {"status":"stale",
-- "revision": <current>} and writes nothing. Callers must check the status.

---------------------------------------------------------------------------
-- sync_state
---------------------------------------------------------------------------
-- revision counts committed changes: 0 = nothing has ever been written through the
-- sync path. A row is created by the first successful push or import.

create table public.sync_state (
  user_id    uuid        primary key references auth.users (id) on delete cascade,
  revision   bigint      not null default 0,
  updated_at timestamptz not null default now(),
  constraint sync_state_revision_check check (revision >= 0)
);

comment on table public.sync_state is 'Per-user sync revision. Written only by push_changes and import_and_init_sync.';

-- Accounts that already have rows (none are expected: nothing has written data yet)
-- start at revision 1, so a client that has not pulled (base revision 0) is stale.
insert into public.sync_state (user_id, revision)
select u.user_id, 1
  from (select user_id from public.classes
        union select user_id from public.groups
        union select user_id from public.sessions) u
on conflict (user_id) do nothing;

---------------------------------------------------------------------------
-- Privileges: close the direct-write path
---------------------------------------------------------------------------

revoke all on public.sync_state from anon, authenticated;
grant select on public.sync_state to authenticated;

alter table public.sync_state enable row level security;
create policy sync_state_select on public.sync_state for select to authenticated
  using (user_id = (select auth.uid()));

-- Revoking the table-level privileges also removes the M2 column-level UPDATE grants.
revoke all on public.classes, public.groups, public.sessions, public.local_imports from authenticated;
grant select on public.classes, public.groups, public.sessions, public.local_imports to authenticated;

---------------------------------------------------------------------------
-- Internal payload helpers (not callable by clients)
---------------------------------------------------------------------------
-- They only inspect JSON. The definer functions below call them with the owner's
-- privileges, so no grant to clients is needed (or given).

create function public.sync_text(p_obj jsonb, p_key text, p_where text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
begin
  if pg_catalog.jsonb_typeof(p_obj -> p_key) is distinct from 'string'
     or pg_catalog.char_length(p_obj ->> p_key) > 1000 then
    raise exception 'invalid_payload: % needs a text field "%" of at most 1000 characters.', p_where, p_key
      using errcode = '22023';
  end if;
  return p_obj ->> p_key;
end;
$$;

-- The key must be present; a JSON null gives NULL.
create function public.sync_opt_text(p_obj jsonb, p_key text, p_where text)
returns text
language plpgsql
immutable
set search_path = ''
as $$
begin
  if p_obj -> p_key is null then
    raise exception 'invalid_payload: % needs the field "%" (text or null).', p_where, p_key
      using errcode = '22023';
  end if;
  if pg_catalog.jsonb_typeof(p_obj -> p_key) = 'null' then
    return null;
  end if;
  return public.sync_text(p_obj, p_key, p_where);
end;
$$;

-- A whole number within [p_min, p_max]. "60.0" counts as whole, like the import.
create function public.sync_whole(p_obj jsonb, p_key text, p_min numeric, p_max numeric, p_where text)
returns bigint
language plpgsql
immutable
set search_path = ''
as $$
declare
  v numeric;
begin
  if pg_catalog.jsonb_typeof(p_obj -> p_key) is distinct from 'number' then
    raise exception 'invalid_payload: % needs a numeric field "%".', p_where, p_key using errcode = '22023';
  end if;
  v := (p_obj ->> p_key)::numeric;
  if v <> pg_catalog.trunc(v) or v < p_min or v > p_max then
    raise exception 'invalid_payload: % has an invalid "%" (a whole number from % to % is required).',
      p_where, p_key, p_min, p_max using errcode = '22023';
  end if;
  return v::bigint;
end;
$$;

revoke all on function public.sync_text(jsonb, text, text) from public, anon, authenticated;
revoke all on function public.sync_opt_text(jsonb, text, text) from public, anon, authenticated;
revoke all on function public.sync_whole(jsonb, text, numeric, numeric, text) from public, anon, authenticated;

---------------------------------------------------------------------------
-- pull_snapshot
---------------------------------------------------------------------------
-- Returns ONE jsonb value:
--   {"revision": n,
--    "classes":  [{"id","name","color"}...]                         creation order
--    "groups":   [{"id","classId","name"}...]                       creation order
--    "sessions": [{"id","classId","groupId","startedAt","seconds","mode"}...]  oldest first
--   }
-- startedAt is epoch milliseconds, like the app. It is a single scalar, so PostgREST's
-- row limit (default 1,000) does not apply however many sessions there are; the size is
-- bounded by the per-user caps enforced on write (1,000 classes, 1,000 subgroups per
-- class, 100,000 sessions). Everything is read in ONE statement, so it sees one
-- consistent snapshot (revision and rows from the same point in time). A push commits
-- its rows and its revision bump together, so a snapshot never shows half of a push.

create function public.pull_snapshot()
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  v_user   uuid := auth.uid();
  v_result jsonb;
begin
  if v_user is null then
    raise exception 'Not signed in.' using errcode = '28000';
  end if;

  select pg_catalog.jsonb_build_object(
    'revision', coalesce((select s.revision from public.sync_state s where s.user_id = v_user), 0),
    'classes', coalesce((
      select pg_catalog.jsonb_agg(
               pg_catalog.jsonb_build_object('id', c.id, 'name', c.name, 'color', c.color)
               order by c.created_at, c.id)
        from public.classes c where c.user_id = v_user), '[]'::jsonb),
    'groups', coalesce((
      select pg_catalog.jsonb_agg(
               pg_catalog.jsonb_build_object('id', g.id, 'classId', g.class_id, 'name', g.name)
               order by g.created_at, g.id)
        from public.groups g where g.user_id = v_user), '[]'::jsonb),
    'sessions', coalesce((
      select pg_catalog.jsonb_agg(
               pg_catalog.jsonb_build_object(
                 'id', s.id, 'classId', s.class_id, 'groupId', s.group_id,
                 'startedAt', pg_catalog.round(extract(epoch from s.started_at) * 1000)::bigint,
                 'seconds', s.seconds, 'mode', s.mode)
               order by s.started_at, s.id)
        from public.sessions s where s.user_id = v_user), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

---------------------------------------------------------------------------
-- push_changes
---------------------------------------------------------------------------
-- p_changes is a JSON array of changes, applied in order. Field names match the import
-- file (camelCase). Unknown keys, including any user_id, are ignored.
--
--   {"op":"add_class",    "id","name","color"}
--   {"op":"update_class", "id", "name"?, "color"?}                 at least one of the two
--   {"op":"delete_class", "id", "expectedSessions": n}             see below
--   {"op":"add_group",    "id","classId","name"}
--   {"op":"rename_group", "id","name"}
--   {"op":"delete_group", "id"}
--   {"op":"add_session",  "id","classId","groupId" (text|null),"startedAt" (ms),"seconds","mode"}
--   {"op":"move_session", "id","classId","groupId" (text|null)}    only these two fields change
--
-- Results: {"status":"applied","revision":n,"changed":k}, or {"status":"stale","revision":n}.
--  * stale: p_base_revision is not the current revision (older OR newer). Nothing was
--    written. The caller pulls, merges and pushes again.
--  * applied: the revision goes up by exactly 1, once per push, and only if at least one
--    change altered a row (an empty list, or updates that set the same values, leave it
--    alone).
--  * A repeated push with the same base revision after a successful one is stale, so it
--    can never duplicate rows or overwrite newer data. A lost response is recovered by
--    pulling: the committed changes are in the snapshot.
--
-- Validation: shapes and types here, values and relationships by the table
-- constraints (names normalized and 1..60 characters, color #rrggbb, ids 1..100
-- characters, mode, seconds, subgroup belongs to the session's class, unique names and
-- ids). Any failure aborts the whole call. Order matters: a change can only refer to rows
-- that exist at that point (add a class before its subgroups, move a session out of a
-- class before deleting the class).
--
-- Deleting never silently loses sessions:
--   * delete_group keeps the group's sessions and clears their subgroup (the table's
--     ON DELETE SET NULL, the same as the app).
--   * delete_class deletes the class, its subgroups and its sessions (the app's rule), but
--     only when the number of sessions it holds right now equals expectedSessions. A
--     different number means someone added or moved sessions the client has not seen, and
--     the call fails with ST004 instead of destroying them. Sessions are deleted
--     explicitly before the class, so no SET NULL cascade is involved.
--
-- Limits: 5,000 changes and 4 MB per call; 1,000 classes, 1,000 subgroups per class and
-- 100,000 sessions per user (the same caps as the import).

create function public.push_changes(p_base_revision bigint, p_changes jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_max_changes  constant integer := 5000;
  c_max_bytes    constant integer := 4000000;
  c_max_classes  constant integer := 1000;
  c_max_groups   constant integer := 1000;   -- per class
  c_max_sessions constant integer := 100000;

  v_user     uuid := auth.uid();
  v_current  bigint;
  v_n        integer;
  v_i        integer;
  v_op       jsonb;
  v_type     text;
  v_where    text := 'changes';
  v_now      timestamptz := pg_catalog.now();
  v_seq      integer := 0;   -- microsecond offset: keeps creation order within one push
  v_changed  integer := 0;
  v_rows     integer;
  v_id       text;
  v_class_id text;
  v_group_id text;
  v_name     text;
  v_color    text;
  v_old_name  text;
  v_old_color text;
  v_expected bigint;
  v_actual   bigint;
  v_ms       bigint;
  v_added_classes  boolean := false;
  v_added_sessions boolean := false;
begin
  if v_user is null then
    raise exception 'Not signed in.' using errcode = '28000';
  end if;
  if p_base_revision is null or p_base_revision < 0 then
    raise exception 'invalid_payload: the base revision must be a number of 0 or more.' using errcode = '22023';
  end if;
  if p_changes is null or pg_catalog.jsonb_typeof(p_changes) is distinct from 'array' then
    raise exception 'invalid_payload: changes must be a list.' using errcode = '22023';
  end if;
  v_n := pg_catalog.jsonb_array_length(p_changes);
  if v_n > c_max_changes or pg_catalog.pg_column_size(p_changes) > c_max_bytes then
    raise exception 'invalid_payload: too many changes in one push.' using errcode = '22023';
  end if;

  -- One writer per user at a time. Everything after this line sees the effects of any
  -- push or import that held the lock before us (each statement gets a fresh snapshot).
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_user::text, 0));

  select s.revision into v_current from public.sync_state s where s.user_id = v_user;
  v_current := coalesce(v_current, 0);
  if p_base_revision <> v_current then
    return pg_catalog.jsonb_build_object('status', 'stale', 'revision', v_current);
  end if;

  begin
    for v_i in 0 .. v_n - 1 loop
      v_where := 'change ' || (v_i + 1);
      v_op := p_changes -> v_i;
      if pg_catalog.jsonb_typeof(v_op) is distinct from 'object' then
        raise exception 'invalid_payload: % is not an object.', v_where using errcode = '22023';
      end if;
      v_type := public.sync_text(v_op, 'op', v_where);
      v_where := v_where || ' (' || pg_catalog.left(v_type, 40) || ')';
      v_seq := v_seq + 1;

      if v_type = 'add_class' then
        v_id    := public.sync_text(v_op, 'id', v_where);
        v_name  := public.normalize_name(public.sync_text(v_op, 'name', v_where));
        v_color := public.sync_text(v_op, 'color', v_where);
        insert into public.classes (user_id, id, name, color, created_at)
        values (v_user, v_id, v_name, v_color, v_now + v_seq * interval '1 microsecond');
        v_added_classes := true;
        v_changed := v_changed + 1;

      elsif v_type = 'update_class' then
        v_id := public.sync_text(v_op, 'id', v_where);
        if v_op -> 'name' is null and v_op -> 'color' is null then
          raise exception 'invalid_payload: % needs a name or a color.', v_where using errcode = '22023';
        end if;
        select c.name, c.color into v_old_name, v_old_color
          from public.classes c where c.user_id = v_user and c.id = v_id for update;
        if not found then
          raise exception 'invalid_payload: % refers to a class that does not exist.', v_where using errcode = '22023';
        end if;
        v_name  := case when v_op -> 'name' is not null
                        then public.normalize_name(public.sync_text(v_op, 'name', v_where))
                        else v_old_name end;
        v_color := case when v_op -> 'color' is not null
                        then public.sync_text(v_op, 'color', v_where)
                        else v_old_color end;
        if v_name is distinct from v_old_name or v_color is distinct from v_old_color then
          update public.classes set name = v_name, color = v_color
           where user_id = v_user and id = v_id;
          v_changed := v_changed + 1;
        end if;

      elsif v_type = 'delete_class' then
        v_id := public.sync_text(v_op, 'id', v_where);
        v_expected := public.sync_whole(v_op, 'expectedSessions', 0, 100000, v_where);
        perform 1 from public.classes c where c.user_id = v_user and c.id = v_id for update;
        if not found then
          raise exception 'invalid_payload: % refers to a class that does not exist.', v_where using errcode = '22023';
        end if;
        select pg_catalog.count(*) into v_actual
          from public.sessions s where s.user_id = v_user and s.class_id = v_id;
        if v_actual <> v_expected then
          raise exception 'delete_refused: the class holds % sessions but % were expected; pull and merge first.',
            v_actual, v_expected using errcode = 'ST004';
        end if;
        delete from public.sessions where user_id = v_user and class_id = v_id;
        delete from public.classes  where user_id = v_user and id = v_id;   -- its subgroups cascade
        v_changed := v_changed + 1;

      elsif v_type = 'add_group' then
        v_id       := public.sync_text(v_op, 'id', v_where);
        v_class_id := public.sync_text(v_op, 'classId', v_where);
        v_name     := public.normalize_name(public.sync_text(v_op, 'name', v_where));
        insert into public.groups (user_id, id, class_id, name, created_at)
        values (v_user, v_id, v_class_id, v_name, v_now + v_seq * interval '1 microsecond');
        select pg_catalog.count(*) into v_actual
          from public.groups g where g.user_id = v_user and g.class_id = v_class_id;
        if v_actual > c_max_groups then
          raise exception 'invalid_payload: % exceeds the limit of % subgroups per class.', v_where, c_max_groups
            using errcode = '22023';
        end if;
        v_changed := v_changed + 1;

      elsif v_type = 'rename_group' then
        v_id   := public.sync_text(v_op, 'id', v_where);
        v_name := public.normalize_name(public.sync_text(v_op, 'name', v_where));
        select g.name into v_old_name
          from public.groups g where g.user_id = v_user and g.id = v_id for update;
        if not found then
          raise exception 'invalid_payload: % refers to a subgroup that does not exist.', v_where using errcode = '22023';
        end if;
        if v_name is distinct from v_old_name then
          update public.groups set name = v_name where user_id = v_user and id = v_id;
          v_changed := v_changed + 1;
        end if;

      elsif v_type = 'delete_group' then
        v_id := public.sync_text(v_op, 'id', v_where);
        -- sessions_group_fk (ON DELETE SET NULL (group_id)) keeps the sessions and clears only the subgroup.
        delete from public.groups where user_id = v_user and id = v_id;
        get diagnostics v_rows = row_count;
        if v_rows = 0 then
          raise exception 'invalid_payload: % refers to a subgroup that does not exist.', v_where using errcode = '22023';
        end if;
        v_changed := v_changed + 1;

      elsif v_type = 'add_session' then
        v_id       := public.sync_text(v_op, 'id', v_where);
        v_class_id := public.sync_text(v_op, 'classId', v_where);
        v_group_id := public.sync_opt_text(v_op, 'groupId', v_where);
        v_ms       := public.sync_whole(v_op, 'startedAt', 0, 253402300799999, v_where);  -- up to year 9999
        v_actual   := public.sync_whole(v_op, 'seconds', 1, 31622400, v_where);
        v_name     := public.sync_text(v_op, 'mode', v_where);
        -- Exact epoch-milliseconds -> timestamptz, as in the import.
        insert into public.sessions (user_id, id, class_id, group_id, started_at, seconds, mode)
        values (v_user, v_id, v_class_id, v_group_id,
                'epoch'::timestamptz
                  + (v_ms / 1000) * interval '1 second'
                  + (v_ms % 1000) * interval '1 millisecond',
                v_actual::integer, v_name);
        v_added_sessions := true;
        v_changed := v_changed + 1;

      elsif v_type = 'move_session' then
        v_id       := public.sync_text(v_op, 'id', v_where);
        v_class_id := public.sync_text(v_op, 'classId', v_where);
        v_group_id := public.sync_opt_text(v_op, 'groupId', v_where);
        -- Only class and subgroup change. The composite foreign key requires the subgroup
        -- to belong to the new class; a null subgroup only needs the class to exist.
        update public.sessions
           set class_id = v_class_id, group_id = v_group_id
         where user_id = v_user and id = v_id
           and (class_id, group_id) is distinct from (v_class_id, v_group_id);
        get diagnostics v_rows = row_count;
        if v_rows = 0 then
          if not exists (select 1 from public.sessions s where s.user_id = v_user and s.id = v_id) then
            raise exception 'invalid_payload: % refers to a session that does not exist.', v_where using errcode = '22023';
          end if;
        else
          v_changed := v_changed + 1;
        end if;

      else
        raise exception 'invalid_payload: % is an unknown change type.', v_where using errcode = '22023';
      end if;
    end loop;
  exception
    when unique_violation then
      raise exception 'conflict: % (at %)', sqlerrm, v_where using errcode = 'ST003';
    when foreign_key_violation or check_violation or not_null_violation
         or string_data_right_truncation or invalid_text_representation
         or numeric_value_out_of_range or datetime_field_overflow or program_limit_exceeded then
      raise exception 'invalid_payload: % (at %)', sqlerrm, v_where using errcode = '22023';
  end;

  if v_added_classes then
    select pg_catalog.count(*) into v_actual from public.classes c where c.user_id = v_user;
    if v_actual > c_max_classes then
      raise exception 'invalid_payload: more than % classes.', c_max_classes using errcode = '22023';
    end if;
  end if;
  if v_added_sessions then
    select pg_catalog.count(*) into v_actual from public.sessions s where s.user_id = v_user;
    if v_actual > c_max_sessions then
      raise exception 'invalid_payload: more than % sessions.', c_max_sessions using errcode = '22023';
    end if;
  end if;

  if v_changed = 0 then
    return pg_catalog.jsonb_build_object('status', 'applied', 'revision', v_current, 'changed', 0);
  end if;

  -- The lock is held and v_current is the committed revision, so this is exactly +1.
  insert into public.sync_state (user_id, revision, updated_at)
  values (v_user, v_current + 1, pg_catalog.now())
  on conflict (user_id) do update
    set revision = excluded.revision, updated_at = excluded.updated_at;

  return pg_catalog.jsonb_build_object('status', 'applied', 'revision', v_current + 1, 'changed', v_changed);
end;
$$;

---------------------------------------------------------------------------
-- import_and_init_sync
---------------------------------------------------------------------------
-- Wraps import_local_data (same arguments, same errors: 22023, ST001, ST002, 28000) and
-- sets up sync_state in the SAME transaction, so "data imported" and "revision bumped"
-- either both happen or neither does.
--   * 'imported'         -> revision created at 1, or raised by 1 if a row already existed
--                           (an account whose data was all deleted may import again).
--   * 'already_imported' -> same import id and identical payload committed before (for
--                           example the response was lost). Nothing is written except
--                           creating a missing sync_state row; the revision is reported
--                           as it is NOW, edits made since are never overwritten.
--   * any error          -> nothing was written, sync_state included.
-- Returns import_local_data's object plus "revision".

create function public.import_and_init_sync(p_import_id text, p_payload jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  c_max_bytes constant integer := 33554432;   -- 32 MB, about 3x a maxed-out account
  v_user     uuid := auth.uid();
  v_result   jsonb;
  v_revision bigint;
begin
  if v_user is null then
    raise exception 'Not signed in.' using errcode = '28000';
  end if;
  if p_payload is null or pg_catalog.jsonb_typeof(p_payload) is distinct from 'object'
     or pg_catalog.pg_column_size(p_payload) > c_max_bytes then
    raise exception 'invalid_payload: the payload must be a JSON object of at most 32 MB.' using errcode = '22023';
  end if;

  -- Same lock as push_changes and import_local_data (advisory locks are re-entrant).
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_user::text, 0));

  v_result := public.import_local_data(p_import_id, p_payload);

  if v_result ->> 'status' = 'imported' then
    insert into public.sync_state (user_id, revision, updated_at)
    values (v_user, 1, pg_catalog.now())
    on conflict (user_id) do update
      set revision = public.sync_state.revision + 1, updated_at = excluded.updated_at
    returning revision into v_revision;
  else
    insert into public.sync_state (user_id, revision, updated_at)
    values (v_user, 1, pg_catalog.now())
    on conflict (user_id) do nothing;
    select s.revision into v_revision from public.sync_state s where s.user_id = v_user;
  end if;

  return v_result || pg_catalog.jsonb_build_object('revision', v_revision);
end;
$$;

---------------------------------------------------------------------------
-- Function privileges
---------------------------------------------------------------------------

revoke all on function public.pull_snapshot() from public, anon;
revoke all on function public.push_changes(bigint, jsonb) from public, anon;
revoke all on function public.import_and_init_sync(text, jsonb) from public, anon;
grant execute on function public.pull_snapshot() to authenticated;
grant execute on function public.push_changes(bigint, jsonb) to authenticated;
grant execute on function public.import_and_init_sync(text, jsonb) to authenticated;

-- Clients must use import_and_init_sync; a direct import would skip sync_state.
revoke all on function public.import_local_data(text, jsonb) from public, anon, authenticated;
