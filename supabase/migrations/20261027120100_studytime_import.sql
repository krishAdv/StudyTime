-- StudyTime M2: atomic, idempotent first-login import of an M1 export file.
--
-- The future app sends the JSON from src/lib/data-export.ts (the whole file:
-- format, formatVersion, exportedAt, data) plus an import id it generated once
-- for this device's import (e.g. crypto.randomUUID(), kept in the device's state
-- until the import is confirmed).
--
-- Design decisions:
--  * SECURITY INVOKER (the default), not SECURITY DEFINER. Nothing here needs to
--    bypass Row Level Security: the caller already may insert their own rows. So RLS,
--    the column grants and the user_id checks all stay in force for every statement
--    in the function, and a bug here cannot reach another user's data.
--  * The owner is always auth.uid(). The payload is never trusted for ownership; any
--    user_id-like fields inside it are ignored.
--  * One function call is one transaction: any invalid value or constraint
--    failure aborts everything, so nothing is ever half-imported.
--  * Server-side validation: shape and types are checked here, values and
--    relationships by the table constraints (names, ids, modes, durations, subgroup
--    belongs to the session's class). Client validation is not relied on.

create table public.local_imports (
  user_id          uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  import_id        text        not null,
  -- sha256 of the payload's canonical jsonb text; tells an exact retry from a different payload.
  payload_hash     text        not null,
  classes_imported  integer    not null,
  groups_imported   integer    not null,
  sessions_imported integer    not null,
  created_at       timestamptz not null default now(),
  primary key (user_id, import_id),
  constraint local_imports_id_check check (pg_catalog.btrim(import_id) <> '' and pg_catalog.char_length(import_id) <= 100)
);

comment on table public.local_imports is 'One row per successfully completed first import. Written in the same transaction as the imported data, so a row exists only if the whole import committed.';

revoke all on public.local_imports from anon, authenticated;
-- Clients may read their records. They may also insert their own: a forged row
-- only affects the forger's own account (it can only make that user's later retry
-- report "already imported"), so it needs no definer privileges.
grant select, insert on public.local_imports to authenticated;

alter table public.local_imports enable row level security;
create policy local_imports_select on public.local_imports for select to authenticated
  using (user_id = (select auth.uid()));
create policy local_imports_insert on public.local_imports for insert to authenticated
  with check (user_id = (select auth.uid()));

---------------------------------------------------------------------------
-- import_local_data
---------------------------------------------------------------------------
-- Returns jsonb {status: 'imported' | 'already_imported', import_id, classes, groups, sessions}.
--
-- Errors (SQLSTATE) the app should handle:
--   28000  not signed in
--   22023  invalid payload or import id (message starts with 'invalid_payload:')
--   ST001  this import id was already completed with a DIFFERENT payload
--   ST002  the account already has study data (and this is not a retry of a completed import)
--
-- How the app distinguishes the outcomes:
--   * 'imported'          -> this call committed everything. Show success.
--   * 'already_imported'  -> a previous call with the same import id AND an identical
--                            payload committed. Safe retry (e.g. the response was lost).
--                            Treat as success; the data may since have been edited.
--   * ST001               -> same id, different payload: a bug or tampering; do not retry.
--   * ST002               -> cloud data exists and no matching completed import: do NOT
--                            import; follow the "prefer cloud" rule.
--   * 22023 / other error -> nothing was written (the transaction rolled back); the
--                            local data is untouched. Incomplete imports cannot exist.
--   * network failure with no response -> unknown; call again with the SAME import id.
--                            The outcome is then 'already_imported' (it had committed),
--                            or 'imported' (it had not), never a duplicate.

create function public.import_local_data(p_import_id text, p_payload jsonb)
returns jsonb
language plpgsql
set search_path = ''
as $$
declare
  c_max_classes  constant integer := 1000;
  c_max_groups   constant integer := 1000;   -- per class
  c_max_sessions constant integer := 100000;

  v_user     uuid := auth.uid();
  v_hash     text;
  v_existing public.local_imports%rowtype;
  v_data     jsonb;
  v_classes  jsonb;
  v_sessions jsonb;
  v_groups   jsonb;
  v_now      timestamptz := pg_catalog.now();
  v_class    jsonb;
  v_group    jsonb;
  v_session  jsonb;
  v_n_classes  integer;
  v_n_groups   integer;
  v_n_sessions integer;
  v_total_groups integer := 0;
  v_ci integer;
  v_gi integer;
  v_si integer;
  v_where text := 'payload';
  v_num   numeric;
  v_ms    bigint;
  v_group_id text;
  v_seconds integer;
  v_bad_version boolean;
begin
  if v_user is null then
    raise exception 'Not signed in.' using errcode = '28000';
  end if;
  if p_import_id is null or pg_catalog.btrim(p_import_id) = '' or pg_catalog.char_length(p_import_id) > 100 then
    raise exception 'invalid_payload: the import id must be 1 to 100 characters.' using errcode = '22023';
  end if;
  if p_payload is null or pg_catalog.jsonb_typeof(p_payload) is distinct from 'object' then
    raise exception 'invalid_payload: the payload must be a JSON object.' using errcode = '22023';
  end if;

  v_hash := pg_catalog.encode(pg_catalog.sha256(pg_catalog.convert_to(p_payload::text, 'UTF8')), 'hex');

  -- One import per user at a time; also serializes two racing retries.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_user::text, 0));

  select * into v_existing
    from public.local_imports
   where user_id = v_user and import_id = p_import_id;
  if found then
    if v_existing.payload_hash = v_hash then
      return pg_catalog.jsonb_build_object(
        'status', 'already_imported', 'import_id', p_import_id,
        'classes', v_existing.classes_imported,
        'groups', v_existing.groups_imported,
        'sessions', v_existing.sessions_imported);
    end if;
    raise exception 'This import id was already used with different data.' using errcode = 'ST001';
  end if;

  if exists (select 1 from public.classes where user_id = v_user)
     or exists (select 1 from public.sessions where user_id = v_user) then
    raise exception 'This account already contains study data; nothing was imported.' using errcode = 'ST002';
  end if;

  -- Envelope (the M1 export file).
  if p_payload -> 'format' is distinct from pg_catalog.to_jsonb('studytime-export'::text) then
    raise exception 'invalid_payload: not a StudyTime export file.' using errcode = '22023';
  end if;
  -- CASE, not OR: SQL does not guarantee OR short-circuits, and the cast fails on non-numbers.
  -- Assigned to a variable first: inside an IF condition, the THEN of the CASE would end
  -- the condition early (PL/pgSQL reads an IF condition up to the first THEN).
  v_bad_version := case when pg_catalog.jsonb_typeof(p_payload -> 'formatVersion') = 'number'
                        then (p_payload ->> 'formatVersion')::numeric <> 1
                        else true end;
  if v_bad_version then
    raise exception 'invalid_payload: unsupported export version.' using errcode = '22023';
  end if;
  if pg_catalog.jsonb_typeof(p_payload -> 'exportedAt') is distinct from 'string' then
    raise exception 'invalid_payload: missing export date.' using errcode = '22023';
  end if;
  v_data := p_payload -> 'data';
  if pg_catalog.jsonb_typeof(v_data) is distinct from 'object' then
    raise exception 'invalid_payload: missing data.' using errcode = '22023';
  end if;
  v_classes  := v_data -> 'classes';
  v_sessions := v_data -> 'sessions';
  if pg_catalog.jsonb_typeof(v_classes) is distinct from 'array' then
    raise exception 'invalid_payload: classes must be a list.' using errcode = '22023';
  end if;
  if pg_catalog.jsonb_typeof(v_sessions) is distinct from 'array' then
    raise exception 'invalid_payload: sessions must be a list.' using errcode = '22023';
  end if;
  v_n_classes  := pg_catalog.jsonb_array_length(v_classes);
  v_n_sessions := pg_catalog.jsonb_array_length(v_sessions);
  if v_n_classes > c_max_classes or v_n_sessions > c_max_sessions then
    raise exception 'invalid_payload: too much data for one import.' using errcode = '22023';
  end if;

  begin
    for v_ci in 0 .. v_n_classes - 1 loop
      v_where := 'class ' || (v_ci + 1);
      v_class := v_classes -> v_ci;
      if pg_catalog.jsonb_typeof(v_class) is distinct from 'object'
         or pg_catalog.jsonb_typeof(v_class -> 'id') is distinct from 'string'
         or pg_catalog.jsonb_typeof(v_class -> 'name') is distinct from 'string'
         or pg_catalog.jsonb_typeof(v_class -> 'color') is distinct from 'string'
         or pg_catalog.jsonb_typeof(v_class -> 'groups') is distinct from 'array' then
        raise exception 'invalid_payload: % is malformed.', v_where using errcode = '22023';
      end if;

      -- created_at keeps the list order (all values <= now()).
      insert into public.classes (user_id, id, name, color, created_at)
      values (v_user, v_class ->> 'id', public.normalize_name(v_class ->> 'name'), v_class ->> 'color',
              v_now - (v_n_classes - v_ci) * interval '1 millisecond');

      v_groups := v_class -> 'groups';
      v_n_groups := pg_catalog.jsonb_array_length(v_groups);
      if v_n_groups > c_max_groups then
        raise exception 'invalid_payload: % has too many subgroups.', v_where using errcode = '22023';
      end if;
      for v_gi in 0 .. v_n_groups - 1 loop
        v_where := 'class ' || (v_ci + 1) || ', subgroup ' || (v_gi + 1);
        v_group := v_groups -> v_gi;
        if pg_catalog.jsonb_typeof(v_group) is distinct from 'object'
           or pg_catalog.jsonb_typeof(v_group -> 'id') is distinct from 'string'
           or pg_catalog.jsonb_typeof(v_group -> 'name') is distinct from 'string' then
          raise exception 'invalid_payload: % is malformed.', v_where using errcode = '22023';
        end if;
        insert into public.groups (user_id, id, class_id, name, created_at)
        values (v_user, v_group ->> 'id', v_class ->> 'id', public.normalize_name(v_group ->> 'name'),
                v_now - (v_n_groups - v_gi) * interval '1 millisecond');
        v_total_groups := v_total_groups + 1;
      end loop;
    end loop;

    for v_si in 0 .. v_n_sessions - 1 loop
      v_where := 'session ' || (v_si + 1);
      v_session := v_sessions -> v_si;
      if pg_catalog.jsonb_typeof(v_session) is distinct from 'object'
         or pg_catalog.jsonb_typeof(v_session -> 'id') is distinct from 'string'
         or pg_catalog.jsonb_typeof(v_session -> 'classId') is distinct from 'string'
         or pg_catalog.jsonb_typeof(v_session -> 'startedAt') is distinct from 'number'
         or pg_catalog.jsonb_typeof(v_session -> 'seconds') is distinct from 'number'
         or pg_catalog.jsonb_typeof(v_session -> 'mode') is distinct from 'string'
         or pg_catalog.jsonb_typeof(v_session -> 'groupId') is null
         or pg_catalog.jsonb_typeof(v_session -> 'groupId') not in ('string', 'null') then
        raise exception 'invalid_payload: % is malformed.', v_where using errcode = '22023';
      end if;

      v_num := (v_session ->> 'seconds')::numeric;
      if v_num <> pg_catalog.trunc(v_num) then
        raise exception 'invalid_payload: % has a non-whole duration.', v_where using errcode = '22023';
      end if;
      -- Range is enforced by sessions_seconds_check; keep the cast from overflowing first.
      if v_num < 1 or v_num > 31622400 then
        raise exception 'invalid_payload: % has an invalid duration.', v_where using errcode = '22023';
      end if;
      -- From the numeric, not the text: jsonb keeps "1200.0" as written and text '1200.0' is not an integer.
      v_seconds := v_num::integer;

      v_num := (v_session ->> 'startedAt')::numeric;
      if v_num <> pg_catalog.trunc(v_num) or v_num < 0 or v_num > 253402300799999 then  -- up to year 9999
        raise exception 'invalid_payload: % has an invalid start time.', v_where using errcode = '22023';
      end if;
      v_ms := v_num::bigint;

      v_group_id := case when pg_catalog.jsonb_typeof(v_session -> 'groupId') = 'null'
                         then null else v_session ->> 'groupId' end;

      -- Exact epoch-milliseconds -> timestamptz (whole seconds plus whole milliseconds,
      -- each far below 2^53, so no floating-point rounding).
      insert into public.sessions (user_id, id, class_id, group_id, started_at, seconds, mode)
      values (v_user, v_session ->> 'id', v_session ->> 'classId', v_group_id,
              'epoch'::timestamptz
                + (v_ms / 1000) * interval '1 second'
                + (v_ms % 1000) * interval '1 millisecond',
              v_seconds, v_session ->> 'mode');
    end loop;
  exception
    when unique_violation or foreign_key_violation or check_violation or not_null_violation
         or string_data_right_truncation or invalid_text_representation or numeric_value_out_of_range
         or datetime_field_overflow then
      -- Re-raise as a payload error naming the offending item; the whole call still rolls back.
      raise exception 'invalid_payload: % (at %)', sqlerrm, v_where using errcode = '22023';
  end;

  insert into public.local_imports (user_id, import_id, payload_hash, classes_imported, groups_imported, sessions_imported)
  values (v_user, p_import_id, v_hash, v_n_classes, v_total_groups, v_n_sessions);

  return pg_catalog.jsonb_build_object(
    'status', 'imported', 'import_id', p_import_id,
    'classes', v_n_classes, 'groups', v_total_groups, 'sessions', v_n_sessions);
end;
$$;

-- Only signed-in users may call it (not PUBLIC, not anon).
revoke all on function public.import_local_data(text, jsonb) from public, anon;
grant execute on function public.import_local_data(text, jsonb) to authenticated;
