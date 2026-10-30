-- StudyTime M2: manual verification script. NOT YET RUN against any database.
--
-- Run it ONLY on a disposable Supabase project (or a local `supabase start`), after
-- applying the first two files in supabase/migrations/ and BEFORE the M4.2 sync
-- migration (20261029120000): that migration revokes the direct writes and the direct
-- import call this script exercises, so it cannot pass after it. Use
-- tests/sync_verify.sql for the state after M4.2. It creates fake users and data inside
-- ONE transaction and ends with ROLLBACK, so it leaves nothing behind. Any failed
-- check raises an exception and stops the script.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/verify.sql
--
-- (psql prints a NOTICE "PASS [...]" per check. The dashboard SQL editor may not
-- show notices: a run that ends with the row ALL CHECKS PASSED and no error is a pass.)
--
-- Assumptions to confirm on first run:
--   * inserting (id, aud, role, email) into auth.users is accepted by your project's
--     auth schema. If not, create three or more users in the dashboard and replace the
--     UUIDs below.
--   * you run as a role that may SET ROLE authenticated / anon (the `postgres` role).

begin;

---------------------------------------------------------------------------
-- Test scaffolding (inside the transaction, rolled back at the end)
---------------------------------------------------------------------------
create schema st_test;
grant usage on schema st_test to anon, authenticated;

create function st_test.expect_eq(label text, actual anyelement, expected anyelement)
returns void language plpgsql as $$
begin
  if actual is distinct from expected then
    raise exception 'FAIL [%]: expected %, got %', label, expected, actual;
  end if;
  raise notice 'PASS [%]', label;
end $$;

-- Runs stmt and requires it to fail with exactly this SQLSTATE.
create function st_test.expect_fail(label text, stmt text, expected_state text)
returns void language plpgsql as $$
begin
  begin
    execute stmt;
  exception when others then
    if sqlstate <> expected_state then
      raise exception 'FAIL [%]: expected SQLSTATE % but got % (%)', label, expected_state, sqlstate, sqlerrm;
    end if;
    raise notice 'PASS [%]', label;
    return;
  end;
  raise exception 'FAIL [%]: statement succeeded but should have failed', label;
end $$;

-- Pretends the following statements are made by user u (what a signed-in JWT does).
create function st_test.login(u uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true),
         set_config('request.jwt.claim.sub', u::text, true);
$$;

grant execute on all functions in schema st_test to anon, authenticated;

create table st_test.payloads (name text primary key, body jsonb not null);
grant select on st_test.payloads to anon, authenticated;

-- Users: A and B for isolation/constraint tests; C, D, E for imports.
insert into auth.users (id, aud, role, email) values
  ('00000000-0000-0000-0000-00000000000a', 'authenticated', 'authenticated', 'st-a@example.test'),
  ('00000000-0000-0000-0000-00000000000b', 'authenticated', 'authenticated', 'st-b@example.test'),
  ('00000000-0000-0000-0000-00000000000c', 'authenticated', 'authenticated', 'st-c@example.test'),
  ('00000000-0000-0000-0000-00000000000d', 'authenticated', 'authenticated', 'st-d@example.test'),
  ('00000000-0000-0000-0000-00000000000e', 'authenticated', 'authenticated', 'st-e@example.test');

-- Import payloads (M1 export files). ic*/is* ids belong to C, ec* to E.
insert into st_test.payloads (name, body) values
('valid', $j${"format":"studytime-export","formatVersion":1,"exportedAt":"2026-10-27T12:00:00.000Z","data":{
  "classes":[
    {"id":"ic1","name":"Biology","color":"#10b981","groups":[{"id":"ig1","name":"Cells"},{"id":"ig2","name":"Genetics"}]},
    {"id":"ic2","name":"History","color":"#f59e0b","groups":[]}],
  "sessions":[
    {"id":"is1","classId":"ic1","groupId":"ig1","startedAt":1700000000123,"seconds":1200,"mode":"countdown"},
    {"id":"is2","classId":"ic2","groupId":null,"startedAt":1700000500000,"seconds":90,"mode":"stopwatch"}]}}$j$::jsonb),
('valid-changed', $j${"format":"studytime-export","formatVersion":1,"exportedAt":"2026-10-27T12:00:00.000Z","data":{
  "classes":[{"id":"ic1","name":"Biology","color":"#10b981","groups":[]}],
  "sessions":[]}}$j$::jsonb),
-- Tries to claim ownership by A through user_id fields at every level; must be ignored.
('claims-owner', $j${"format":"studytime-export","formatVersion":1,"exportedAt":"2026-10-27T12:00:00.000Z",
  "user_id":"00000000-0000-0000-0000-00000000000a","data":{
  "classes":[{"id":"ec1","name":"Chemistry","color":"#3b82f6","user_id":"00000000-0000-0000-0000-00000000000a","groups":[]}],
  "sessions":[{"id":"es1","classId":"ec1","groupId":null,"user_id":"00000000-0000-0000-0000-00000000000a",
               "startedAt":1700000000000,"seconds":60.0,"mode":"stopwatch"}]}}$j$::jsonb),
-- ("seconds":60.0 above: a whole number written with a decimal point must import.)
-- Valid first part, then a session pointing at a missing class: nothing may commit.
('rollback', $j${"format":"studytime-export","formatVersion":1,"exportedAt":"2026-10-27T12:00:00.000Z","data":{
  "classes":[{"id":"d1","name":"One","color":"#3b82f6","groups":[{"id":"dg1","name":"G"}]},
             {"id":"d2","name":"Two","color":"#3b82f6","groups":[]}],
  "sessions":[{"id":"ds1","classId":"d1","groupId":"dg1","startedAt":1700000000000,"seconds":60,"mode":"stopwatch"},
              {"id":"ds2","classId":"nope","groupId":null,"startedAt":1700000000000,"seconds":60,"mode":"stopwatch"}]}}$j$::jsonb);

---------------------------------------------------------------------------
-- 1. User A creates data (user_id comes from the auth.uid() default)
---------------------------------------------------------------------------
select st_test.login('00000000-0000-0000-0000-00000000000a');
set local role authenticated;

insert into public.classes (id, name, color) values ('c1', 'Math', '#3b82f6'), ('c2', 'Art', '#8b5cf6');
insert into public.groups (id, class_id, name) values ('g1', 'c1', 'Unit 1'), ('g2', 'c2', 'Sketching');
insert into public.sessions (id, class_id, group_id, started_at, seconds, mode) values
  ('s1', 'c1', 'g1', '2026-10-27 12:00+00', 1500, 'stopwatch'),
  ('s2', 'c2', 'g2', '2026-10-27 13:00+00', 600, 'countdown'),
  ('s3', 'c1', null, '2026-10-27 14:00+00', 60, 'stopwatch');

select st_test.expect_eq('A owns rows via the user_id default',
  (select count(*) from public.classes where user_id = '00000000-0000-0000-0000-00000000000a'), 2::bigint);

---------------------------------------------------------------------------
-- 2. Two users cannot read or modify each other's rows
---------------------------------------------------------------------------
select st_test.login('00000000-0000-0000-0000-00000000000b');

select st_test.expect_eq('B sees none of A''s classes',  (select count(*) from public.classes),  0::bigint);
select st_test.expect_eq('B sees none of A''s groups',   (select count(*) from public.groups),   0::bigint);
select st_test.expect_eq('B sees none of A''s sessions', (select count(*) from public.sessions), 0::bigint);

select st_test.expect_fail('B cannot insert a row owned by A',
  $q$insert into public.classes (user_id, id, name, color) values ('00000000-0000-0000-0000-00000000000a', 'evil', 'Evil', '#000000')$q$,
  '42501');
select st_test.expect_fail('B cannot attach a session to A''s class',
  $q$insert into public.sessions (id, class_id, started_at, seconds, mode) values ('x1', 'c1', now(), 10, 'stopwatch')$q$,
  '23503');

do $$
declare n integer;
begin
  update public.classes set name = 'Hacked' where user_id = '00000000-0000-0000-0000-00000000000a';
  get diagnostics n = row_count;
  perform st_test.expect_eq('B cannot update A''s classes (0 rows)', n, 0);
  update public.sessions set group_id = null where user_id = '00000000-0000-0000-0000-00000000000a';
  get diagnostics n = row_count;
  perform st_test.expect_eq('B cannot update A''s sessions (0 rows)', n, 0);
  delete from public.classes where user_id = '00000000-0000-0000-0000-00000000000a';
  get diagnostics n = row_count;
  perform st_test.expect_eq('B cannot delete A''s classes (0 rows)', n, 0);
end $$;

-- Ids are per user, so B may reuse A's ids for B's own rows.
insert into public.classes (id, name, color) values ('c1', 'Math', '#3b82f6');
select st_test.expect_eq('B can reuse the id c1 and the name Math for B''s own class',
  (select count(*) from public.classes), 1::bigint);

set local role anon;
select st_test.expect_fail('anonymous users cannot read classes',  $q$select count(*) from public.classes$q$,  '42501');
select st_test.expect_fail('anonymous users cannot read sessions', $q$select count(*) from public.sessions$q$, '42501');
select st_test.expect_fail('anonymous users cannot insert',
  $q$insert into public.classes (id, name, color) values ('anon1', 'Anon', '#000000')$q$, '42501');

reset role;
select st_test.expect_eq('A''s rows were not changed by B or anon',
  (select count(*) from public.classes where user_id = '00000000-0000-0000-0000-00000000000a' and name in ('Math', 'Art')), 2::bigint);
select st_test.expect_eq('A''s sessions still keep their subgroups',
  (select count(*) from public.sessions where user_id = '00000000-0000-0000-0000-00000000000a' and group_id is not null), 2::bigint);

---------------------------------------------------------------------------
-- 3. Constraints (as A)
---------------------------------------------------------------------------
select st_test.login('00000000-0000-0000-0000-00000000000a');
set local role authenticated;

select st_test.expect_fail('class name unique ignoring case',
  $q$insert into public.classes (id, name, color) values ('c9', 'MATH', '#000000')$q$, '23505');
select st_test.expect_fail('class name must already be normalized (leading space)',
  $q$insert into public.classes (id, name, color) values ('c9', ' Physics', '#000000')$q$, '23514');
select st_test.expect_fail('class name must already be normalized (double space)',
  $q$insert into public.classes (id, name, color) values ('c9', 'Intro  Art', '#000000')$q$, '23514');
select st_test.expect_fail('class name cannot be empty',
  $q$insert into public.classes (id, name, color) values ('c9', '', '#000000')$q$, '23514');
select st_test.expect_fail('class name at most 60 characters',
  $q$insert into public.classes (id, name, color) values ('c9', repeat('x', 61), '#000000')$q$, '23514');
select st_test.expect_fail('class color must be #rrggbb',
  $q$insert into public.classes (id, name, color) values ('c9', 'Color', 'blue')$q$, '23514');
select st_test.expect_fail('renaming to another class''s name (any case) is rejected',
  $q$update public.classes set name = 'ART' where id = 'c1'$q$, '23505');

select st_test.expect_fail('subgroup name unique within its class, ignoring case',
  $q$insert into public.groups (id, class_id, name) values ('g9', 'c1', 'UNIT 1')$q$, '23505');
insert into public.groups (id, class_id, name) values ('g8', 'c2', 'Unit 1');
select st_test.expect_eq('the same subgroup name is allowed in another class',
  (select count(*) from public.groups where lower(name) = 'unit 1'), 2::bigint);
select st_test.expect_fail('a subgroup must belong to an existing class',
  $q$insert into public.groups (id, class_id, name) values ('g7', 'no-such-class', 'X')$q$, '23503');
select st_test.expect_fail('subgroup ids are unique across classes',
  $q$insert into public.groups (id, class_id, name) values ('g1', 'c2', 'Dup id')$q$, '23505');

select st_test.expect_fail('a session cannot use a subgroup of another class',
  $q$insert into public.sessions (id, class_id, group_id, started_at, seconds, mode) values ('s9', 'c2', 'g1', now(), 10, 'stopwatch')$q$, '23503');
select st_test.expect_fail('a session needs an existing class',
  $q$insert into public.sessions (id, class_id, started_at, seconds, mode) values ('s9', 'nope', now(), 10, 'stopwatch')$q$, '23503');
select st_test.expect_fail('session mode must be stopwatch or countdown',
  $q$insert into public.sessions (id, class_id, started_at, seconds, mode) values ('s9', 'c1', now(), 10, 'pomodoro')$q$, '23514');
select st_test.expect_fail('session duration must be at least 1 second',
  $q$insert into public.sessions (id, class_id, started_at, seconds, mode) values ('s9', 'c1', now(), 0, 'stopwatch')$q$, '23514');
select st_test.expect_fail('duplicate session id is rejected',
  $q$insert into public.sessions (id, class_id, started_at, seconds, mode) values ('s1', 'c1', now(), 10, 'stopwatch')$q$, '23505');

-- Clients may only change what the app edits.
select st_test.expect_fail('a session''s duration cannot be edited',
  $q$update public.sessions set seconds = 5 where id = 's1'$q$, '42501');
select st_test.expect_fail('a session''s start time cannot be edited',
  $q$update public.sessions set started_at = now() where id = 's1'$q$, '42501');
select st_test.expect_fail('a class id cannot be edited',
  $q$update public.classes set id = 'zzz' where id = 'c1'$q$, '42501');
select st_test.expect_fail('an owner cannot be edited',
  $q$update public.classes set user_id = '00000000-0000-0000-0000-00000000000b' where id = 'c1'$q$, '42501');

-- Reassignment (the app's "edit session" feature).
select st_test.expect_fail('moving a session to another class while keeping its old subgroup is rejected',
  $q$update public.sessions set class_id = 'c2' where id = 's1'$q$, '23503');
update public.sessions set class_id = 'c2', group_id = null where id = 's1';
select st_test.expect_eq('a session can move to another class with no subgroup',
  (select class_id || '/' || coalesce(group_id, '-') from public.sessions where id = 's1'), 'c2/-');
update public.sessions set class_id = 'c1', group_id = 'g1' where id = 's1';
select st_test.expect_eq('and back, with its subgroup',
  (select class_id || '/' || coalesce(group_id, '-') from public.sessions where id = 's1'), 'c1/g1');

-- Timestamps keep millisecond precision.
insert into public.sessions (id, class_id, started_at, seconds, mode)
  values ('s-ms', 'c1', 'epoch'::timestamptz + (1700000000123 / 1000) * interval '1 second' + (1700000000123 % 1000) * interval '1 millisecond', 5, 'stopwatch');
select st_test.expect_eq('epoch milliseconds round-trip exactly',
  (select (extract(epoch from started_at) * 1000)::bigint from public.sessions where id = 's-ms'), 1700000000123::bigint);
delete from public.sessions where id = 's-ms';

---------------------------------------------------------------------------
-- 4. Deletion behavior (as A)
---------------------------------------------------------------------------
delete from public.groups where id = 'g2';
select st_test.expect_eq('deleting a subgroup keeps its session',
  (select count(*) from public.sessions where id = 's2'), 1::bigint);
select st_test.expect_eq('... nulls only the subgroup and keeps the class',
  (select class_id || '/' || coalesce(group_id, '-') from public.sessions where id = 's2'), 'c2/-');

insert into public.classes (id, name, color) values ('c3', 'Doomed', '#14b8a6');
insert into public.groups (id, class_id, name) values ('g3', 'c3', 'Part');
insert into public.sessions (id, class_id, group_id, started_at, seconds, mode) values
  ('s4', 'c3', 'g3', now(), 10, 'stopwatch'), ('s5', 'c3', null, now(), 20, 'countdown');
delete from public.classes where id = 'c3';
select st_test.expect_eq('deleting a class deletes its subgroups',
  (select count(*) from public.groups where class_id = 'c3'), 0::bigint);
select st_test.expect_eq('deleting a class deletes its sessions',
  (select count(*) from public.sessions where class_id = 'c3'), 0::bigint);
select st_test.expect_eq('other classes'' sessions are untouched',
  (select count(*) from public.sessions), 3::bigint);

---------------------------------------------------------------------------
-- 5. Import (users C, D, E have no data)
---------------------------------------------------------------------------
select st_test.login('00000000-0000-0000-0000-00000000000c');

select st_test.expect_eq('first import reports imported',
  (select public.import_local_data('imp-1', (select body from st_test.payloads where name = 'valid')) ->> 'status'), 'imported');
select st_test.expect_eq('import row counts: classes',  (select count(*) from public.classes),  2::bigint);
select st_test.expect_eq('import row counts: groups',   (select count(*) from public.groups),   2::bigint);
select st_test.expect_eq('import row counts: sessions', (select count(*) from public.sessions), 2::bigint);
select st_test.expect_eq('imported rows belong to the caller',
  (select count(*) from public.classes where user_id = '00000000-0000-0000-0000-00000000000c'), 2::bigint);
select st_test.expect_eq('imported start time keeps milliseconds',
  (select (extract(epoch from started_at) * 1000)::bigint from public.sessions where id = 'is1'), 1700000000123::bigint);
select st_test.expect_eq('imported class order is preserved by created_at',
  (select string_agg(name, ',' order by created_at) from public.classes), 'Biology,History');
select st_test.expect_eq('imported session keeps its subgroup',
  (select group_id from public.sessions where id = 'is1'), 'ig1');

select st_test.expect_eq('retrying the same import id and payload reports already_imported',
  (select public.import_local_data('imp-1', (select body from st_test.payloads where name = 'valid')) ->> 'status'), 'already_imported');
select st_test.expect_eq('... without duplicating classes',  (select count(*) from public.classes),  2::bigint);
select st_test.expect_eq('... without duplicating sessions', (select count(*) from public.sessions), 2::bigint);
select st_test.expect_eq('... and records only one import', (select count(*) from public.local_imports), 1::bigint);

select st_test.expect_fail('the same import id with a different payload is refused',
  $q$select public.import_local_data('imp-1', (select body from st_test.payloads where name = 'valid-changed'))$q$, 'ST001');
select st_test.expect_fail('a new import id into an account that already has data is refused',
  $q$select public.import_local_data('imp-2', (select body from st_test.payloads where name = 'valid'))$q$, 'ST002');

select st_test.login('00000000-0000-0000-0000-00000000000b');
select st_test.expect_eq('another user cannot read C''s import record', (select count(*) from public.local_imports), 0::bigint);
select st_test.expect_fail('a user cannot forge an import record for someone else',
  $q$insert into public.local_imports (user_id, import_id, payload_hash, classes_imported, groups_imported, sessions_imported)
     values ('00000000-0000-0000-0000-00000000000c', 'forged', 'x', 0, 0, 0)$q$, '42501');
select st_test.expect_fail('clients cannot update import records',
  $q$update public.local_imports set payload_hash = 'x'$q$, '42501');

-- All-or-nothing (user D)
select st_test.login('00000000-0000-0000-0000-00000000000d');
select st_test.expect_fail('an import with one bad session fails as a whole',
  $q$select public.import_local_data('imp-d', (select body from st_test.payloads where name = 'rollback'))$q$, '22023');
select st_test.expect_eq('... and leaves no classes',        (select count(*) from public.classes),        0::bigint);
select st_test.expect_eq('... and leaves no subgroups',      (select count(*) from public.groups),         0::bigint);
select st_test.expect_eq('... and leaves no sessions',       (select count(*) from public.sessions),       0::bigint);
select st_test.expect_eq('... and leaves no import record',  (select count(*) from public.local_imports),  0::bigint);

-- Malformed payloads (still user D; each must fail with 22023 and write nothing)
select st_test.expect_fail('payload that is not an object',
  $q$select public.import_local_data('m', '"just a string"'::jsonb)$q$, '22023');
select st_test.expect_fail('wrong format name',
  $q$select public.import_local_data('m', '{"format":"other","formatVersion":1,"exportedAt":"x","data":{"classes":[],"sessions":[]}}'::jsonb)$q$, '22023');
select st_test.expect_fail('unsupported version',
  $q$select public.import_local_data('m', '{"format":"studytime-export","formatVersion":2,"exportedAt":"x","data":{"classes":[],"sessions":[]}}'::jsonb)$q$, '22023');
select st_test.expect_fail('version that is not a number',
  $q$select public.import_local_data('m', '{"format":"studytime-export","formatVersion":"1","exportedAt":"x","data":{"classes":[],"sessions":[]}}'::jsonb)$q$, '22023');
select st_test.expect_fail('classes that are not a list',
  $q$select public.import_local_data('m', '{"format":"studytime-export","formatVersion":1,"exportedAt":"x","data":{"classes":{},"sessions":[]}}'::jsonb)$q$, '22023');
select st_test.expect_fail('a class name that is not a string',
  $q$select public.import_local_data('m', '{"format":"studytime-export","formatVersion":1,"exportedAt":"x","data":{"classes":[{"id":"a","name":5,"color":"#000000","groups":[]}],"sessions":[]}}'::jsonb)$q$, '22023');
select st_test.expect_fail('an empty class name',
  $q$select public.import_local_data('m', '{"format":"studytime-export","formatVersion":1,"exportedAt":"x","data":{"classes":[{"id":"a","name":"   ","color":"#000000","groups":[]}],"sessions":[]}}'::jsonb)$q$, '22023');
select st_test.expect_fail('duplicate class names after normalization',
  $q$select public.import_local_data('m', '{"format":"studytime-export","formatVersion":1,"exportedAt":"x","data":{"classes":[{"id":"a","name":"Math  101","color":"#000000","groups":[]},{"id":"b","name":"math 101","color":"#000000","groups":[]}],"sessions":[]}}'::jsonb)$q$, '22023');
select st_test.expect_fail('duplicate class ids',
  $q$select public.import_local_data('m', '{"format":"studytime-export","formatVersion":1,"exportedAt":"x","data":{"classes":[{"id":"a","name":"One","color":"#000000","groups":[]},{"id":"a","name":"Two","color":"#000000","groups":[]}],"sessions":[]}}'::jsonb)$q$, '22023');
select st_test.expect_fail('duplicate subgroup names in one class',
  $q$select public.import_local_data('m', '{"format":"studytime-export","formatVersion":1,"exportedAt":"x","data":{"classes":[{"id":"a","name":"One","color":"#000000","groups":[{"id":"g1","name":"Unit"},{"id":"g2","name":"UNIT"}]}],"sessions":[]}}'::jsonb)$q$, '22023');
select st_test.expect_fail('duplicate subgroup ids across classes',
  $q$select public.import_local_data('m', '{"format":"studytime-export","formatVersion":1,"exportedAt":"x","data":{"classes":[{"id":"a","name":"One","color":"#000000","groups":[{"id":"g1","name":"X"}]},{"id":"b","name":"Two","color":"#000000","groups":[{"id":"g1","name":"Y"}]}],"sessions":[]}}'::jsonb)$q$, '22023');
select st_test.expect_fail('a session using another class''s subgroup',
  $q$select public.import_local_data('m', '{"format":"studytime-export","formatVersion":1,"exportedAt":"x","data":{"classes":[{"id":"a","name":"One","color":"#000000","groups":[{"id":"g1","name":"X"}]},{"id":"b","name":"Two","color":"#000000","groups":[]}],"sessions":[{"id":"s","classId":"b","groupId":"g1","startedAt":1,"seconds":5,"mode":"stopwatch"}]}}'::jsonb)$q$, '22023');
select st_test.expect_fail('a session with a fractional duration',
  $q$select public.import_local_data('m', '{"format":"studytime-export","formatVersion":1,"exportedAt":"x","data":{"classes":[{"id":"a","name":"One","color":"#000000","groups":[]}],"sessions":[{"id":"s","classId":"a","groupId":null,"startedAt":1,"seconds":1.5,"mode":"stopwatch"}]}}'::jsonb)$q$, '22023');
select st_test.expect_fail('a session with zero duration',
  $q$select public.import_local_data('m', '{"format":"studytime-export","formatVersion":1,"exportedAt":"x","data":{"classes":[{"id":"a","name":"One","color":"#000000","groups":[]}],"sessions":[{"id":"s","classId":"a","groupId":null,"startedAt":1,"seconds":0,"mode":"stopwatch"}]}}'::jsonb)$q$, '22023');
select st_test.expect_fail('a session with an unsupported mode',
  $q$select public.import_local_data('m', '{"format":"studytime-export","formatVersion":1,"exportedAt":"x","data":{"classes":[{"id":"a","name":"One","color":"#000000","groups":[]}],"sessions":[{"id":"s","classId":"a","groupId":null,"startedAt":1,"seconds":5,"mode":"pomodoro"}]}}'::jsonb)$q$, '22023');
select st_test.expect_fail('a session with a negative start time',
  $q$select public.import_local_data('m', '{"format":"studytime-export","formatVersion":1,"exportedAt":"x","data":{"classes":[{"id":"a","name":"One","color":"#000000","groups":[]}],"sessions":[{"id":"s","classId":"a","groupId":null,"startedAt":-5,"seconds":5,"mode":"stopwatch"}]}}'::jsonb)$q$, '22023');
select st_test.expect_fail('a session with no groupId key',
  $q$select public.import_local_data('m', '{"format":"studytime-export","formatVersion":1,"exportedAt":"x","data":{"classes":[{"id":"a","name":"One","color":"#000000","groups":[]}],"sessions":[{"id":"s","classId":"a","startedAt":1,"seconds":5,"mode":"stopwatch"}]}}'::jsonb)$q$, '22023');
select st_test.expect_fail('an empty import id',
  $q$select public.import_local_data('  ', '{"format":"studytime-export","formatVersion":1,"exportedAt":"x","data":{"classes":[],"sessions":[]}}'::jsonb)$q$, '22023');
select st_test.expect_eq('no malformed import wrote anything', (select count(*) from public.classes) + (select count(*) from public.sessions) + (select count(*) from public.local_imports), 0::bigint);

-- Ownership comes from auth.uid(), never from the payload (user E; the payload names A).
select st_test.login('00000000-0000-0000-0000-00000000000e');
select st_test.expect_eq('import ignores user_id fields in the payload',
  (select public.import_local_data('imp-e', (select body from st_test.payloads where name = 'claims-owner')) ->> 'status'), 'imported');
reset role;
select st_test.expect_eq('the rows belong to E, not to the user named in the payload',
  (select count(*) from public.classes where id = 'ec1' and user_id = '00000000-0000-0000-0000-00000000000e'), 1::bigint);
select st_test.expect_eq('A gained nothing from E''s payload',
  (select count(*) from public.classes where user_id = '00000000-0000-0000-0000-00000000000a' and id = 'ec1'), 0::bigint);
select st_test.expect_eq('A''s own data is unchanged by every import',
  (select count(*) from public.sessions where user_id = '00000000-0000-0000-0000-00000000000a'), 3::bigint);

-- Not signed in
set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated"}', true), set_config('request.jwt.claim.sub', '', true);
select st_test.expect_fail('a call without a user id is refused',
  $q$select public.import_local_data('imp-x', (select body from st_test.payloads where name = 'valid'))$q$, '28000');
set local role anon;
select st_test.expect_fail('anonymous users cannot call the import function',
  $q$select public.import_local_data('imp-x', '{}'::jsonb)$q$, '42501');

reset role;
select 'ALL CHECKS PASSED' as result;
rollback;
