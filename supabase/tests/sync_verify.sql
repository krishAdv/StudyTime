-- StudyTime M4.2: manual verification script for the sync migration.
-- NOT YET RUN against any database.
--
-- Run it ONLY on a disposable Supabase project or a local `supabase start`, NEVER on
-- the production project, after applying, in this order:
--   1. migrations/20261027120000_studytime_schema.sql
--   2. migrations/20261027120100_studytime_import.sql
--   (optionally tests/verify.sql here: it tests the M2 direct-write grants, which the
--    next migration removes, so it must run BEFORE step 3 and cannot be re-run after it)
--   3. migrations/20261029120000_studytime_sync.sql
--
-- It creates fake users and data inside ONE transaction and ends with ROLLBACK, so it
-- leaves nothing behind. Any failed check raises an exception and stops the script.
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/sync_verify.sql
--
-- (psql prints a NOTICE "PASS [...]" per check. The dashboard SQL editor may not show
-- notices: a run that ends with the row ALL CHECKS PASSED and no error is a pass.)
--
-- Not covered here, because one script is one transaction on one connection: real
-- concurrency between two pushes. See "Two-session concurrency check" in
-- supabase/README.md.
--
-- Assumptions to confirm on first run (same as verify.sql): inserting
-- (id, aud, role, email) into auth.users is accepted by your project, and you run as a
-- role that may SET ROLE authenticated / anon (the `postgres` role).

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

-- The caller's committed revision, read the way a client can (RLS-limited select).
create function st_test.rev() returns bigint language sql as $$
  select coalesce((select revision from public.sync_state), 0);
$$;

-- Class names / session ids in snapshot order, for readable assertions.
create function st_test.snap_ids(key text) returns text language sql as $$
  select coalesce(string_agg(e.v ->> 'id', ',' order by e.n), '')
    from jsonb_array_elements(public.pull_snapshot() -> key) with ordinality as e(v, n);
$$;
create function st_test.snap_class_names() returns text language sql as $$
  select coalesce(string_agg(e.v ->> 'name', ',' order by e.n), '')
    from jsonb_array_elements(public.pull_snapshot() -> 'classes') with ordinality as e(v, n);
$$;

-- A session's "class/subgroup" as the snapshot reports it ('-' for no subgroup).
create function st_test.sess(sid text) returns text language sql as $$
  select (e.v ->> 'classId') || '/' || coalesce(e.v ->> 'groupId', '-')
    from jsonb_array_elements(public.pull_snapshot() -> 'sessions') as e(v)
   where e.v ->> 'id' = sid;
$$;

-- A push that must be rejected with expected_state AND leave the caller's whole snapshot
-- (revision included) byte-for-byte unchanged.
create function st_test.fail_push(label text, base bigint, changes text, expected_state text)
returns void language plpgsql as $$
declare
  before_sig text := md5(public.pull_snapshot()::text);
begin
  perform st_test.expect_fail(label,
    format('select public.push_changes(%s, %L::jsonb)', base, changes), expected_state);
  if md5(public.pull_snapshot()::text) is distinct from before_sig then
    raise exception 'FAIL [%]: the snapshot changed after a rejected push', label;
  end if;
  raise notice 'PASS [% (nothing written)]', label;
end $$;

grant execute on all functions in schema st_test to anon, authenticated;

create table st_test.payloads (name text primary key, body jsonb not null);
grant select on st_test.payloads to anon, authenticated;

-- Users. a/b: pushes and isolation. c: import then edits. d: cloud data exists before an
-- import. e: failing imports. f: payload that names another user. g: data fully deleted,
-- then imported. h: large snapshot.
insert into auth.users (id, aud, role, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'authenticated', 'authenticated', 'sync-a@example.test'),
  ('00000000-0000-0000-0000-0000000000b1', 'authenticated', 'authenticated', 'sync-b@example.test'),
  ('00000000-0000-0000-0000-0000000000c1', 'authenticated', 'authenticated', 'sync-c@example.test'),
  ('00000000-0000-0000-0000-0000000000d1', 'authenticated', 'authenticated', 'sync-d@example.test'),
  ('00000000-0000-0000-0000-0000000000e1', 'authenticated', 'authenticated', 'sync-e@example.test'),
  ('00000000-0000-0000-0000-0000000000f1', 'authenticated', 'authenticated', 'sync-f@example.test'),
  ('00000000-0000-0000-0000-0000000000aa', 'authenticated', 'authenticated', 'sync-g@example.test'),
  ('00000000-0000-0000-0000-0000000000bb', 'authenticated', 'authenticated', 'sync-h@example.test');

-- Import payloads (M1 export files).
insert into st_test.payloads (name, body) values
('valid', $j${"format":"studytime-export","formatVersion":1,"exportedAt":"2026-10-29T12:00:00.000Z","data":{
  "classes":[
    {"id":"ic1","name":"Biology","color":"#10b981","groups":[{"id":"ig1","name":"Cells"},{"id":"ig2","name":"Genetics"}]},
    {"id":"ic2","name":"History","color":"#f59e0b","groups":[]}],
  "sessions":[
    {"id":"is1","classId":"ic1","groupId":"ig1","startedAt":1700000000123,"seconds":1200,"mode":"countdown"},
    {"id":"is2","classId":"ic2","groupId":null,"startedAt":1700000500000,"seconds":90,"mode":"stopwatch"}]}}$j$::jsonb),
('valid-changed', $j${"format":"studytime-export","formatVersion":1,"exportedAt":"2026-10-29T12:00:00.000Z","data":{
  "classes":[{"id":"ic1","name":"Biology","color":"#10b981","groups":[]}],
  "sessions":[]}}$j$::jsonb),
-- Names user A at every level; must be ignored.
('claims-owner', $j${"format":"studytime-export","formatVersion":1,"exportedAt":"2026-10-29T12:00:00.000Z",
  "user_id":"00000000-0000-0000-0000-0000000000a1","data":{
  "classes":[{"id":"ec1","name":"Chemistry","color":"#3b82f6","user_id":"00000000-0000-0000-0000-0000000000a1","groups":[]}],
  "sessions":[{"id":"es1","classId":"ec1","groupId":null,"user_id":"00000000-0000-0000-0000-0000000000a1",
               "startedAt":1700000000000,"seconds":60,"mode":"stopwatch"}]}}$j$::jsonb),
-- Valid first part, then a session pointing at a missing class: nothing may commit.
('rollback', $j${"format":"studytime-export","formatVersion":1,"exportedAt":"2026-10-29T12:00:00.000Z","data":{
  "classes":[{"id":"d1","name":"One","color":"#3b82f6","groups":[{"id":"dg1","name":"G"}]}],
  "sessions":[{"id":"ds1","classId":"d1","groupId":"dg1","startedAt":1700000000000,"seconds":60,"mode":"stopwatch"},
              {"id":"ds2","classId":"nope","groupId":null,"startedAt":1700000000000,"seconds":60,"mode":"stopwatch"}]}}$j$::jsonb);

---------------------------------------------------------------------------
-- 1. Snapshot, ownership and revision (users A and B)
---------------------------------------------------------------------------
select st_test.login('00000000-0000-0000-0000-0000000000a1');
set local role authenticated;

select st_test.expect_eq('empty account: snapshot revision is 0',
  (select (public.pull_snapshot() ->> 'revision')::bigint), 0::bigint);
select st_test.expect_eq('empty account: snapshot has no classes',
  (select jsonb_array_length(public.pull_snapshot() -> 'classes')), 0);

select st_test.expect_eq('A: first push at base revision 0 is applied',
  (select public.push_changes(0, $j$[
    {"op":"add_class","id":"c1","name":"Math","color":"#3b82f6"},
    {"op":"add_class","id":"c2","name":"Art","color":"#8b5cf6"},
    {"op":"add_group","id":"g1","classId":"c1","name":"Unit 1"},
    {"op":"add_session","id":"s1","classId":"c1","groupId":"g1","startedAt":1700000000123,"seconds":1500,"mode":"stopwatch"},
    {"op":"add_session","id":"s2","classId":"c2","groupId":null,"startedAt":1700000500000,"seconds":90,"mode":"countdown"}
  ]$j$::jsonb) ->> 'status'), 'applied');
select st_test.expect_eq('A: the revision is 1 after one push', st_test.rev(), 1::bigint);
select st_test.expect_eq('A: snapshot revision matches', (select (public.pull_snapshot() ->> 'revision')::bigint), 1::bigint);
select st_test.expect_eq('A: classes come back in creation order', st_test.snap_class_names(), 'Math,Art');
select st_test.expect_eq('A: sessions come back oldest first', st_test.snap_ids('sessions'), 's1,s2');
select st_test.expect_eq('A: subgroup is reported', st_test.snap_ids('groups'), 'g1');
select st_test.expect_eq('A: epoch milliseconds round-trip exactly',
  (select (e.v ->> 'startedAt')::bigint from jsonb_array_elements(public.pull_snapshot() -> 'sessions') as e(v) where e.v ->> 'id' = 's1'),
  1700000000123::bigint);
select st_test.expect_eq('A: a session without a subgroup reports JSON null',
  (select jsonb_typeof(e.v -> 'groupId') from jsonb_array_elements(public.pull_snapshot() -> 'sessions') as e(v) where e.v ->> 'id' = 's2'),
  'null');

reset role;
select st_test.expect_eq('A: rows are owned by A',
  (select count(*) from public.classes where user_id = '00000000-0000-0000-0000-0000000000a1'), 2::bigint);

-- B: separate account, same ids allowed, forged owners ignored.
select st_test.login('00000000-0000-0000-0000-0000000000b1');
set local role authenticated;

select st_test.expect_eq('B sees none of A''s classes in a snapshot', st_test.snap_ids('classes'), '');
select st_test.expect_eq('B sees none of A''s sessions in a snapshot', st_test.snap_ids('sessions'), '');
select st_test.expect_eq('B''s revision starts at 0', st_test.rev(), 0::bigint);
select st_test.expect_eq('B sees none of A''s sessions directly', (select count(*) from public.sessions), 0::bigint);

select st_test.expect_eq('B: a push naming A as owner is applied for B',
  (select public.push_changes(0, $j$[
    {"op":"add_class","id":"c1","name":"Math","color":"#3b82f6","user_id":"00000000-0000-0000-0000-0000000000a1","userId":"00000000-0000-0000-0000-0000000000a1"},
    {"op":"add_session","id":"bs1","classId":"c1","groupId":null,"startedAt":1700000000000,"seconds":60,"mode":"stopwatch","user_id":"00000000-0000-0000-0000-0000000000a1"}
  ]$j$::jsonb) ->> 'status'), 'applied');
select st_test.expect_eq('B: revision is 1', st_test.rev(), 1::bigint);

-- B cannot reach A's rows even by guessing their ids.
select st_test.fail_push('B cannot move A''s session s1', 1,
  '[{"op":"move_session","id":"s1","classId":"c1","groupId":null}]', '22023');
select st_test.fail_push('B cannot rename A''s class c2', 1,
  '[{"op":"update_class","id":"c2","name":"Hacked"}]', '22023');
select st_test.fail_push('B cannot delete A''s class c2', 1,
  '[{"op":"delete_class","id":"c2","expectedSessions":1}]', '22023');
select st_test.fail_push('B cannot attach a session to A''s class c2', 1,
  '[{"op":"add_session","id":"bs2","classId":"c2","groupId":null,"startedAt":1,"seconds":5,"mode":"stopwatch"}]', '22023');
select st_test.expect_eq('B sees only its own sync_state row', (select count(*) from public.sync_state), 1::bigint);

reset role;
select st_test.expect_eq('forged user ids: the rows belong to B',
  (select count(*) from public.classes where id = 'c1' and user_id = '00000000-0000-0000-0000-0000000000b1'), 1::bigint);
select st_test.expect_eq('forged user ids: A gained nothing',
  (select count(*) from public.sessions where id = 'bs1' and user_id = '00000000-0000-0000-0000-0000000000a1'), 0::bigint);
select st_test.expect_eq('A''s data and revision are untouched by B',
  (select count(*) from public.classes where user_id = '00000000-0000-0000-0000-0000000000a1' and name in ('Math', 'Art')) * 100
  + (select revision from public.sync_state where user_id = '00000000-0000-0000-0000-0000000000a1'), 201::bigint);

-- anon and signed-out callers
set local role anon;
select st_test.expect_fail('anon cannot pull',   $q$select public.pull_snapshot()$q$, '42501');
select st_test.expect_fail('anon cannot push',   $q$select public.push_changes(0, '[]'::jsonb)$q$, '42501');
select st_test.expect_fail('anon cannot import', $q$select public.import_and_init_sync('x', '{}'::jsonb)$q$, '42501');
select st_test.expect_fail('anon cannot read sync_state', $q$select count(*) from public.sync_state$q$, '42501');

set local role authenticated;
select set_config('request.jwt.claims', '{"role":"authenticated"}', true), set_config('request.jwt.claim.sub', '', true);
select st_test.expect_fail('no user id: pull is refused',   $q$select public.pull_snapshot()$q$, '28000');
select st_test.expect_fail('no user id: push is refused',   $q$select public.push_changes(0, '[]'::jsonb)$q$, '28000');
select st_test.expect_fail('no user id: import is refused', $q$select public.import_and_init_sync('x', '{}'::jsonb)$q$, '28000');

---------------------------------------------------------------------------
-- 2. The revision gate (A is at revision 1)
---------------------------------------------------------------------------
select st_test.login('00000000-0000-0000-0000-0000000000a1');

select st_test.expect_eq('an old base revision is stale',
  (select public.push_changes(0, '[{"op":"add_class","id":"late","name":"Late","color":"#000000"}]'::jsonb) ->> 'status'), 'stale');
select st_test.expect_eq('a stale result reports the current revision',
  (select (public.push_changes(0, '[]'::jsonb) ->> 'revision')::bigint), 1::bigint);
select st_test.expect_eq('a stale push wrote nothing', st_test.snap_class_names(), 'Math,Art');
select st_test.expect_eq('a stale push leaves the revision alone', st_test.rev(), 1::bigint);
select st_test.expect_eq('a base revision from the future is stale too',
  (select public.push_changes(7, '[{"op":"add_class","id":"late","name":"Late","color":"#000000"}]'::jsonb) ->> 'status'), 'stale');
select st_test.expect_fail('a null base revision is rejected', $q$select public.push_changes(null, '[]'::jsonb)$q$, '22023');
select st_test.expect_fail('a negative base revision is rejected', $q$select public.push_changes(-1, '[]'::jsonb)$q$, '22023');

select st_test.expect_eq('an empty push is applied without a change',
  (select (public.push_changes(1, '[]'::jsonb) ->> 'changed')::integer), 0);
select st_test.expect_eq('... and does not raise the revision', st_test.rev(), 1::bigint);
select st_test.expect_eq('an update that sets the same values changes nothing',
  (select (public.push_changes(1, '[{"op":"update_class","id":"c2","name":"Art","color":"#8b5cf6"}]'::jsonb) ->> 'changed')::integer), 0);
select st_test.expect_eq('... and does not raise the revision either', st_test.rev(), 1::bigint);

select st_test.expect_eq('a real change raises the revision by exactly 1',
  (select (public.push_changes(1, '[{"op":"update_class","id":"c2","name":"Painting"}]'::jsonb) ->> 'revision')::bigint), 2::bigint);
select st_test.expect_eq('the change is visible', st_test.snap_class_names(), 'Math,Painting');
select st_test.expect_eq('repeating that push (same base) is stale, not applied twice',
  (select public.push_changes(1, '[{"op":"update_class","id":"c2","name":"Painting"}]'::jsonb) ->> 'status'), 'stale');
select st_test.expect_eq('... and the revision stays 2', st_test.rev(), 2::bigint);

select st_test.expect_eq('a case-only rename of the same class is allowed',
  (select (public.push_changes(2, '[{"op":"update_class","id":"c2","name":"painting"}]'::jsonb) ->> 'revision')::bigint), 3::bigint);
select st_test.expect_eq('... and back',
  (select (public.push_changes(3, '[{"op":"update_class","id":"c2","name":"  Painting "}]'::jsonb) ->> 'revision')::bigint), 4::bigint);
select st_test.expect_eq('names are stored normalized', st_test.snap_class_names(), 'Math,Painting');

---------------------------------------------------------------------------
-- 3. Invalid pushes: each must fail with the right SQLSTATE and change nothing
---------------------------------------------------------------------------
-- (fail_push compares the whole snapshot, revision included, before and after.)
select st_test.fail_push('changes that are not a list', 4, '{"op":"add_class"}', '22023');
select st_test.fail_push('a change that is not an object', 4, '["add_class"]', '22023');
select st_test.fail_push('a change with no op', 4, '[{"id":"x"}]', '22023');
select st_test.fail_push('an unknown op', 4, '[{"op":"drop_everything"}]', '22023');
select st_test.fail_push('an op that is not text', 4, '[{"op":5}]', '22023');
select st_test.fail_push('add_class without an id', 4, '[{"op":"add_class","name":"X","color":"#000000"}]', '22023');
select st_test.fail_push('an id that is not text', 4, '[{"op":"add_class","id":5,"name":"X","color":"#000000"}]', '22023');
select st_test.fail_push('an empty id', 4, '[{"op":"add_class","id":"","name":"X","color":"#000000"}]', '22023');
select st_test.fail_push('an id over 100 characters', 4,
  (select jsonb_build_array(jsonb_build_object('op','add_class','id',repeat('x',101),'name','X','color','#000000'))::text), '22023');
select st_test.fail_push('a name that is empty after normalization', 4, '[{"op":"add_class","id":"x","name":"   ","color":"#000000"}]', '22023');
select st_test.fail_push('a name over 60 characters', 4,
  (select jsonb_build_array(jsonb_build_object('op','add_class','id','x','name',repeat('n',61),'color','#000000'))::text), '22023');
select st_test.fail_push('a color that is not #rrggbb', 4, '[{"op":"add_class","id":"x","name":"X","color":"blue"}]', '22023');

select st_test.fail_push('a duplicate class name (other case)', 4, '[{"op":"add_class","id":"x","name":"MATH","color":"#000000"}]', 'ST003');
select st_test.fail_push('a duplicate class name after normalization', 4, '[{"op":"add_class","id":"x","name":"  math  ","color":"#000000"}]', 'ST003');
select st_test.fail_push('a duplicate class id', 4, '[{"op":"add_class","id":"c1","name":"Brand new","color":"#000000"}]', 'ST003');
select st_test.fail_push('renaming a class to another class''s name', 4, '[{"op":"update_class","id":"c2","name":"MATH"}]', 'ST003');
select st_test.fail_push('a duplicate subgroup name in the class', 4, '[{"op":"add_group","id":"g9","classId":"c1","name":"UNIT 1"}]', 'ST003');
select st_test.fail_push('a subgroup id that exists in another class', 4, '[{"op":"add_group","id":"g1","classId":"c2","name":"Other"}]', 'ST003');
select st_test.fail_push('a subgroup of a missing class', 4, '[{"op":"add_group","id":"g9","classId":"nope","name":"X"}]', '22023');
select st_test.fail_push('a session in a missing class', 4,
  '[{"op":"add_session","id":"sx","classId":"nope","groupId":null,"startedAt":1,"seconds":5,"mode":"stopwatch"}]', '22023');
select st_test.fail_push('a session using another class''s subgroup', 4,
  '[{"op":"add_session","id":"sx","classId":"c2","groupId":"g1","startedAt":1,"seconds":5,"mode":"stopwatch"}]', '22023');
select st_test.fail_push('a session with an unsupported mode', 4,
  '[{"op":"add_session","id":"sx","classId":"c1","groupId":null,"startedAt":1,"seconds":5,"mode":"pomodoro"}]', '22023');
select st_test.fail_push('a session with zero seconds', 4,
  '[{"op":"add_session","id":"sx","classId":"c1","groupId":null,"startedAt":1,"seconds":0,"mode":"stopwatch"}]', '22023');
select st_test.fail_push('a session with fractional seconds', 4,
  '[{"op":"add_session","id":"sx","classId":"c1","groupId":null,"startedAt":1,"seconds":1.5,"mode":"stopwatch"}]', '22023');
select st_test.fail_push('seconds sent as text', 4,
  '[{"op":"add_session","id":"sx","classId":"c1","groupId":null,"startedAt":1,"seconds":"60","mode":"stopwatch"}]', '22023');
select st_test.fail_push('a negative start time', 4,
  '[{"op":"add_session","id":"sx","classId":"c1","groupId":null,"startedAt":-5,"seconds":5,"mode":"stopwatch"}]', '22023');
select st_test.fail_push('a session with no groupId key', 4,
  '[{"op":"add_session","id":"sx","classId":"c1","startedAt":1,"seconds":5,"mode":"stopwatch"}]', '22023');
select st_test.fail_push('a duplicate session id', 4,
  '[{"op":"add_session","id":"s1","classId":"c1","groupId":null,"startedAt":1,"seconds":5,"mode":"stopwatch"}]', 'ST003');
select st_test.fail_push('update_class with nothing to update', 4, '[{"op":"update_class","id":"c1"}]', '22023');
select st_test.fail_push('update_class on a missing class', 4, '[{"op":"update_class","id":"nope","name":"X"}]', '22023');
select st_test.fail_push('rename_group on a missing subgroup', 4, '[{"op":"rename_group","id":"nope","name":"X"}]', '22023');

-- Atomic: an early valid change is rolled back when a later one fails.
select st_test.fail_push('a valid change followed by an invalid one', 4,
  '[{"op":"add_class","id":"tmp","name":"Temp","color":"#123456"},
    {"op":"add_session","id":"sx","classId":"nope","groupId":null,"startedAt":1,"seconds":5,"mode":"stopwatch"}]', '22023');
select st_test.fail_push('a valid change followed by a name conflict', 4,
  '[{"op":"add_class","id":"tmp","name":"Temp","color":"#123456"},
    {"op":"add_class","id":"tmp2","name":"MATH","color":"#123456"}]', 'ST003');
select st_test.fail_push('more than 5,000 changes', 4,
  (select jsonb_agg(jsonb_build_object('op','delete_group','id','x' || n))::text from generate_series(1, 5001) as n), '22023');

select st_test.expect_eq('no invalid push changed anything: classes', st_test.snap_class_names(), 'Math,Painting');
select st_test.expect_eq('no invalid push changed anything: revision', st_test.rev(), 4::bigint);

---------------------------------------------------------------------------
-- 4. Deleting and reassigning (A is at revision 4)
---------------------------------------------------------------------------
-- State: classes c1 Math, c2 Painting; subgroup g1 (in c1); sessions s1 (c1/g1), s2 (c2).
select st_test.expect_eq('move a session to another class (no subgroup)',
  (select (public.push_changes(4, '[{"op":"move_session","id":"s1","classId":"c2","groupId":null}]'::jsonb) ->> 'revision')::bigint), 5::bigint);
select st_test.expect_eq('... it changed class and subgroup only', st_test.sess('s1'), 'c2/-');
select st_test.expect_eq('move it back into its subgroup',
  (select (public.push_changes(5, '[{"op":"move_session","id":"s1","classId":"c1","groupId":"g1"}]'::jsonb) ->> 'revision')::bigint), 6::bigint);
select st_test.expect_eq('... restored', st_test.sess('s1'), 'c1/g1');
select st_test.expect_eq('moving a session onto its current class and subgroup changes nothing',
  (select (public.push_changes(6, '[{"op":"move_session","id":"s1","classId":"c1","groupId":"g1"}]'::jsonb) ->> 'changed')::integer), 0);
select st_test.expect_eq('... and keeps the revision', st_test.rev(), 6::bigint);

select st_test.fail_push('moving to another class but keeping the old subgroup', 6,
  '[{"op":"move_session","id":"s1","classId":"c2","groupId":"g1"}]', '22023');
select st_test.fail_push('moving to a missing class', 6, '[{"op":"move_session","id":"s1","classId":"nope","groupId":null}]', '22023');
select st_test.fail_push('moving a missing session', 6, '[{"op":"move_session","id":"nope","classId":"c1","groupId":null}]', '22023');
select st_test.fail_push('a move with no groupId key', 6, '[{"op":"move_session","id":"s1","classId":"c1"}]', '22023');

-- Deleting a subgroup keeps its sessions.
select st_test.expect_eq('delete a subgroup',
  (select (public.push_changes(6, '[{"op":"delete_group","id":"g1"}]'::jsonb) ->> 'revision')::bigint), 7::bigint);
select st_test.expect_eq('... the subgroup is gone', (select jsonb_array_length(public.pull_snapshot() -> 'groups')), 0);
select st_test.expect_eq('... its session is kept with the class and no subgroup', st_test.sess('s1'), 'c1/-');
select st_test.expect_eq('... and no session was lost', st_test.snap_ids('sessions'), 's1,s2');
select st_test.fail_push('deleting a missing subgroup', 7, '[{"op":"delete_group","id":"g1"}]', '22023');

-- Deleting a class: guarded by the expected session count.
select st_test.expect_eq('add a class with a subgroup and two sessions',
  (select (public.push_changes(7, $j$[
    {"op":"add_class","id":"c3","name":"Doomed","color":"#14b8a6"},
    {"op":"add_group","id":"g3","classId":"c3","name":"Part"},
    {"op":"add_session","id":"s4","classId":"c3","groupId":"g3","startedAt":1700001000000,"seconds":10,"mode":"stopwatch"},
    {"op":"add_session","id":"s5","classId":"c3","groupId":null,"startedAt":1700002000000,"seconds":20,"mode":"countdown"}
  ]$j$::jsonb) ->> 'revision')::bigint), 8::bigint);
select st_test.fail_push('deleting a class that holds more sessions than expected', 8,
  '[{"op":"delete_class","id":"c3","expectedSessions":1}]', 'ST004');
select st_test.fail_push('deleting a class that holds fewer sessions than expected', 8,
  '[{"op":"delete_class","id":"c3","expectedSessions":3}]', 'ST004');
select st_test.fail_push('deleting a class without expectedSessions', 8, '[{"op":"delete_class","id":"c3"}]', '22023');
select st_test.fail_push('a negative expectedSessions', 8, '[{"op":"delete_class","id":"c3","expectedSessions":-1}]', '22023');
select st_test.fail_push('an expectedSessions that is not a number', 8, '[{"op":"delete_class","id":"c3","expectedSessions":"2"}]', '22023');
select st_test.expect_eq('the refused deletes kept the class and both sessions',
  st_test.snap_ids('sessions'), 's1,s2,s4,s5');
select st_test.expect_eq('delete the class with the right count',
  (select (public.push_changes(8, '[{"op":"delete_class","id":"c3","expectedSessions":2}]'::jsonb) ->> 'revision')::bigint), 9::bigint);
select st_test.expect_eq('... the class is gone', st_test.snap_class_names(), 'Math,Painting');
select st_test.expect_eq('... its subgroup is gone', (select jsonb_array_length(public.pull_snapshot() -> 'groups')), 0);
select st_test.expect_eq('... its sessions are gone', st_test.snap_ids('sessions'), 's1,s2');

-- Order inside one push: move the session out first, then the class can go with 0 sessions.
select st_test.expect_eq('move a session out of a class and delete the class in one push',
  (select (public.push_changes(9, $j$[
    {"op":"move_session","id":"s2","classId":"c1","groupId":null},
    {"op":"delete_class","id":"c2","expectedSessions":0}
  ]$j$::jsonb) ->> 'revision')::bigint), 10::bigint);
select st_test.expect_eq('... the class is gone', st_test.snap_class_names(), 'Math');
select st_test.expect_eq('... the moved session survived under its new class', st_test.sess('s2'), 'c1/-');
select st_test.fail_push('deleting a class that does not exist', 10, '[{"op":"delete_class","id":"c2","expectedSessions":0}]', '22023');

---------------------------------------------------------------------------
-- 5. The revision gate cannot be bypassed with direct table writes (A is at revision 10)
---------------------------------------------------------------------------
select st_test.login('00000000-0000-0000-0000-0000000000a1');
set local role authenticated;

select st_test.expect_fail('direct insert into classes',
  $q$insert into public.classes (id, name, color) values ('d1', 'Direct', '#000000')$q$, '42501');
select st_test.expect_fail('direct insert into classes naming the owner',
  $q$insert into public.classes (user_id, id, name, color) values ('00000000-0000-0000-0000-0000000000a1', 'd1', 'Direct', '#000000')$q$, '42501');
select st_test.expect_fail('direct update of a class name (an M2 column grant)',
  $q$update public.classes set name = 'Hacked' where id = 'c1'$q$, '42501');
select st_test.expect_fail('direct delete of a class', $q$delete from public.classes where id = 'c1'$q$, '42501');
select st_test.expect_fail('direct insert into groups',
  $q$insert into public.groups (id, class_id, name) values ('dg', 'c1', 'Direct')$q$, '42501');
select st_test.expect_fail('direct update of a group name',
  $q$update public.groups set name = 'Hacked'$q$, '42501');
select st_test.expect_fail('direct delete from groups', $q$delete from public.groups$q$, '42501');
select st_test.expect_fail('direct insert into sessions',
  $q$insert into public.sessions (id, class_id, started_at, seconds, mode) values ('ds', 'c1', now(), 10, 'stopwatch')$q$, '42501');
select st_test.expect_fail('direct reassignment of a session (an M2 column grant)',
  $q$update public.sessions set group_id = null where id = 's1'$q$, '42501');
select st_test.expect_fail('direct delete of a session', $q$delete from public.sessions where id = 's1'$q$, '42501');
select st_test.expect_fail('direct insert of an import record',
  $q$insert into public.local_imports (import_id, payload_hash, classes_imported, groups_imported, sessions_imported) values ('forged', 'x', 0, 0, 0)$q$, '42501');
select st_test.expect_fail('direct insert into sync_state',
  $q$insert into public.sync_state (user_id, revision) values ('00000000-0000-0000-0000-0000000000a1', 99)$q$, '42501');
select st_test.expect_fail('direct update of the revision', $q$update public.sync_state set revision = 0$q$, '42501');
select st_test.expect_fail('direct delete of the revision row', $q$delete from public.sync_state$q$, '42501');
select st_test.expect_fail('the M2 import function is no longer callable directly',
  $q$select public.import_local_data('x', '{}'::jsonb)$q$, '42501');
select st_test.expect_fail('internal helpers are not callable',
  $q$select public.sync_text('{"a":"b"}'::jsonb, 'a', 'w')$q$, '42501');

select st_test.expect_eq('none of the direct writes changed anything: revision', st_test.rev(), 10::bigint);
select st_test.expect_eq('none of the direct writes changed anything: sessions', st_test.snap_ids('sessions'), 's1,s2');
select st_test.expect_eq('reading one''s own rows directly still works', (select count(*) from public.classes), 1::bigint);

---------------------------------------------------------------------------
-- 6. import_and_init_sync
---------------------------------------------------------------------------
-- User C: import, lost-response retry, edits, retry again.
select st_test.login('00000000-0000-0000-0000-0000000000c1');

select st_test.expect_eq('C: first import reports imported',
  (select public.import_and_init_sync('imp-1', (select body from st_test.payloads where name = 'valid')) ->> 'status'), 'imported');
select st_test.expect_eq('C: the revision is initialized to 1', st_test.rev(), 1::bigint);
select st_test.expect_eq('C: imported classes in order', st_test.snap_class_names(), 'Biology,History');
select st_test.expect_eq('C: imported subgroups', (select jsonb_array_length(public.pull_snapshot() -> 'groups')), 2);
select st_test.expect_eq('C: imported sessions', st_test.snap_ids('sessions'), 'is1,is2');
select st_test.expect_eq('C: the snapshot reports the same revision', (select (public.pull_snapshot() ->> 'revision')::bigint), 1::bigint);

select st_test.expect_eq('C: retrying after a lost response reports already_imported',
  (select public.import_and_init_sync('imp-1', (select body from st_test.payloads where name = 'valid')) ->> 'status'), 'already_imported');
select st_test.expect_eq('C: ... with the same revision',
  (select (public.import_and_init_sync('imp-1', (select body from st_test.payloads where name = 'valid')) ->> 'revision')::bigint), 1::bigint);
select st_test.expect_eq('C: ... and no duplicates', st_test.snap_ids('sessions'), 'is1,is2');
select st_test.expect_eq('C: ... and one import record', (select count(*) from public.local_imports), 1::bigint);

select st_test.expect_eq('C: edit after the import',
  (select (public.push_changes(1, '[{"op":"update_class","id":"ic1","name":"Biology 101"}]'::jsonb) ->> 'revision')::bigint), 2::bigint);
select st_test.expect_eq('C: a late retry still reports already_imported',
  (select public.import_and_init_sync('imp-1', (select body from st_test.payloads where name = 'valid')) ->> 'status'), 'already_imported');
select st_test.expect_eq('C: ... reports the current revision, not 1',
  (select (public.import_and_init_sync('imp-1', (select body from st_test.payloads where name = 'valid')) ->> 'revision')::bigint), 2::bigint);
select st_test.expect_eq('C: ... and does not overwrite the later edit', st_test.snap_class_names(), 'Biology 101,History');

select st_test.expect_fail('C: the same import id with a different payload is refused',
  $q$select public.import_and_init_sync('imp-1', (select body from st_test.payloads where name = 'valid-changed'))$q$, 'ST001');
select st_test.expect_fail('C: a new import id into an account with data is refused',
  $q$select public.import_and_init_sync('imp-2', (select body from st_test.payloads where name = 'valid'))$q$, 'ST002');
select st_test.expect_eq('C: refused imports changed nothing', st_test.rev() * 100 + (select count(*) from public.local_imports), 201::bigint);

-- User D: cloud data exists (written by a push) before an import.
select st_test.login('00000000-0000-0000-0000-0000000000d1');
select st_test.expect_eq('D: cloud data written by a push',
  (select (public.push_changes(0, '[{"op":"add_class","id":"dc1","name":"Existing","color":"#000000"}]'::jsonb) ->> 'revision')::bigint), 1::bigint);
select st_test.expect_fail('D: import into an account with cloud data is refused',
  $q$select public.import_and_init_sync('imp-d', (select body from st_test.payloads where name = 'valid'))$q$, 'ST002');
select st_test.expect_eq('D: the cloud data is unchanged', st_test.snap_class_names(), 'Existing');
select st_test.expect_eq('D: the revision is unchanged', st_test.rev(), 1::bigint);
select st_test.expect_eq('D: no import record was written', (select count(*) from public.local_imports), 0::bigint);

-- User E: failing imports leave nothing, sync_state included.
select st_test.login('00000000-0000-0000-0000-0000000000e1');
select st_test.expect_fail('E: an import with one bad session fails as a whole',
  $q$select public.import_and_init_sync('imp-e', (select body from st_test.payloads where name = 'rollback'))$q$, '22023');
select st_test.expect_fail('E: a payload that is not an object',
  $q$select public.import_and_init_sync('imp-e', '"just a string"'::jsonb)$q$, '22023');
select st_test.expect_fail('E: a null payload', $q$select public.import_and_init_sync('imp-e', null)$q$, '22023');
select st_test.expect_fail('E: an empty import id',
  $q$select public.import_and_init_sync('  ', (select body from st_test.payloads where name = 'valid'))$q$, '22023');
select st_test.expect_eq('E: no classes, subgroups, sessions or import records',
  (select count(*) from public.classes) + (select count(*) from public.groups)
  + (select count(*) from public.sessions) + (select count(*) from public.local_imports), 0::bigint);
select st_test.expect_eq('E: no sync_state row was created', (select count(*) from public.sync_state), 0::bigint);
select st_test.expect_eq('E: the revision is still 0', st_test.rev(), 0::bigint);

-- User F: ownership comes from auth.uid(), never from the payload (which names A).
select st_test.login('00000000-0000-0000-0000-0000000000f1');
select st_test.expect_eq('F: an import whose payload names A is imported for F',
  (select public.import_and_init_sync('imp-f', (select body from st_test.payloads where name = 'claims-owner')) ->> 'status'), 'imported');
reset role;
select st_test.expect_eq('F: the rows belong to F',
  (select count(*) from public.classes where id = 'ec1' and user_id = '00000000-0000-0000-0000-0000000000f1'), 1::bigint);
select st_test.expect_eq('F: A gained nothing',
  (select count(*) from public.classes where id = 'ec1' and user_id = '00000000-0000-0000-0000-0000000000a1'), 0::bigint);
select st_test.expect_eq('F: A''s revision and class count are unchanged',
  (select revision from public.sync_state where user_id = '00000000-0000-0000-0000-0000000000a1') * 100
  + (select count(*) from public.classes where user_id = '00000000-0000-0000-0000-0000000000a1'), 1001::bigint);

-- User G: an account that once had data, now empty, may import again; the revision goes up.
select st_test.login('00000000-0000-0000-0000-0000000000aa');
set local role authenticated;
select st_test.expect_eq('G: add a class',
  (select (public.push_changes(0, '[{"op":"add_class","id":"gc1","name":"Temp","color":"#000000"}]'::jsonb) ->> 'revision')::bigint), 1::bigint);
select st_test.expect_eq('G: delete it, leaving the account empty',
  (select (public.push_changes(1, '[{"op":"delete_class","id":"gc1","expectedSessions":0}]'::jsonb) ->> 'revision')::bigint), 2::bigint);
select st_test.expect_eq('G: importing into the emptied account works and raises the revision',
  (select (public.import_and_init_sync('imp-g', (select body from st_test.payloads where name = 'valid')) ->> 'revision')::bigint), 3::bigint);
select st_test.expect_eq('G: a retry reports already_imported at revision 3',
  (select public.import_and_init_sync('imp-g', (select body from st_test.payloads where name = 'valid')) ->> 'status') || (st_test.rev())::text,
  'already_imported3');

---------------------------------------------------------------------------
-- 7. Snapshots larger than PostgREST's 1,000-row default, and per-class limits (user H)
---------------------------------------------------------------------------
select st_test.login('00000000-0000-0000-0000-0000000000bb');
select st_test.expect_eq('H: push one class and 1,500 sessions',
  (select public.push_changes(0,
     jsonb_build_array(jsonb_build_object('op','add_class','id','hc','name','Big','color','#000000'))
     || (select jsonb_agg(jsonb_build_object('op','add_session','id','hs' || n,'classId','hc','groupId',null,
                                              'startedAt',1700000000000 + n * 1000,'seconds',60,'mode','stopwatch'))
           from generate_series(1, 1500) as n)) ->> 'status'), 'applied');
select st_test.expect_eq('H: the snapshot returns all 1,500 sessions in one value',
  (select jsonb_array_length(public.pull_snapshot() -> 'sessions')), 1500);
select st_test.expect_eq('H: oldest first',  (select public.pull_snapshot() -> 'sessions' -> 0  ->> 'id'), 'hs1');
select st_test.expect_eq('H: newest last',   (select public.pull_snapshot() -> 'sessions' -> -1 ->> 'id'), 'hs1500');
select st_test.expect_eq('H: revision is 1', (select (public.pull_snapshot() ->> 'revision')::bigint), 1::bigint);
select st_test.fail_push('H: more than 1,000 subgroups in one class', 1,
  (select jsonb_agg(jsonb_build_object('op','add_group','id','hg' || n,'classId','hc','name','Group ' || n))::text
     from generate_series(1, 1001) as n), '22023');

reset role;
select 'ALL CHECKS PASSED' as result;
rollback;
