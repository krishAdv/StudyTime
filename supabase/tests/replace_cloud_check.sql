-- StudyTime M4.3 S9 "Stage A": does the REAL push_changes support what Replace cloud does?
-- Passed on the TEST project (owner-reported). Never run on production.
--
-- Question: can ONE push delete a class and recreate it with the same id (together with its subgroups and
-- sessions), is a failed push all-or-nothing, and do ST003 / ST004 / stale leave everything untouched?
--
-- RUN IT ONLY ON THE TEST PROJECT (ref tjvpwextkocihvoevffo). NEVER on production (qnqsqxytmtonklhjwyrx).
-- Prerequisite: the three migrations are applied there (schema, import, sync), in that order.
--
-- It uses fake users inside ONE transaction and ends with ROLLBACK, so it leaves nothing behind (same technique and
-- same assumptions as sync_verify.sql: inserting into auth.users is accepted, and you run as `postgres`). Any failed
-- check raises an exception and stops the script. SQL cannot tell which project it runs on, so the safety is in how
-- it is started: see docs/REPLACE-CLOUD-TEST-PLAN.md (run the pre-flight first, and use a DATABASE_URL that the
-- pre-flight accepted, or the SQL editor of the TEST project only).
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/replace_cloud_check.sql
--
-- A run that prints the row ALL CHECKS PASSED and no error is a pass. psql also prints a NOTICE per check; the
-- dashboard SQL editor may not show notices.
--
-- What it does NOT show: class DISPLAY ORDER. pull_snapshot orders classes by created_at, and push_changes stamps
-- created_at with now() (the transaction's start) plus a per-push microsecond counter. Inside this single transaction
-- every push shares the same now(), so the order seen here is an artifact. Order after a replace is checked in
-- Stage B, where each push is its own transaction.

begin;

---------------------------------------------------------------------------
-- Scaffolding (inside the transaction, rolled back at the end)
---------------------------------------------------------------------------
create schema rc_test;
grant usage on schema rc_test to anon, authenticated;

create function rc_test.expect_eq(label text, actual anyelement, expected anyelement)
returns void language plpgsql as $$
begin
  if actual is distinct from expected then
    raise exception 'FAIL [%]: expected %, got %', label, expected, actual;
  end if;
  raise notice 'PASS [%]', label;
end $$;

create function rc_test.expect_fail(label text, stmt text, expected_state text)
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

create function rc_test.login(u uuid) returns void language sql as $$
  select set_config('request.jwt.claims', json_build_object('sub', u, 'role', 'authenticated')::text, true),
         set_config('request.jwt.claim.sub', u::text, true);
$$;

create function rc_test.rev() returns bigint language sql as $$
  select coalesce((select revision from public.sync_state), 0);
$$;

-- Ids of one list of the snapshot, sorted by id (order-independent).
create function rc_test.ids(key text) returns text language sql as $$
  select coalesce(string_agg(e.v ->> 'id', ',' order by e.v ->> 'id'), '')
    from jsonb_array_elements(public.pull_snapshot() -> key) as e(v);
$$;

create function rc_test.sess(sid text) returns text language sql as $$
  select (e.v ->> 'classId') || '/' || coalesce(e.v ->> 'groupId', '-') || '/' || (e.v ->> 'seconds')
    from jsonb_array_elements(public.pull_snapshot() -> 'sessions') as e(v)
   where e.v ->> 'id' = sid;
$$;

create function rc_test.group_class(gid text) returns text language sql as $$
  select e.v ->> 'classId'
    from jsonb_array_elements(public.pull_snapshot() -> 'groups') as e(v)
   where e.v ->> 'id' = gid;
$$;

create function rc_test.class_color(cid text) returns text language sql as $$
  select e.v ->> 'color'
    from jsonb_array_elements(public.pull_snapshot() -> 'classes') as e(v)
   where e.v ->> 'id' = cid;
$$;

-- A push that must be rejected with expected_state AND leave the whole snapshot (revision included) unchanged.
create function rc_test.fail_push(label text, base bigint, changes text, expected_state text)
returns void language plpgsql as $$
declare
  before_sig text := md5(public.pull_snapshot()::text);
begin
  perform rc_test.expect_fail(label,
    format('select public.push_changes(%s, %L::jsonb)', base, changes), expected_state);
  if md5(public.pull_snapshot()::text) is distinct from before_sig then
    raise exception 'FAIL [%]: the snapshot changed after a rejected push', label;
  end if;
  raise notice 'PASS [% (nothing written)]', label;
end $$;

grant execute on all functions in schema rc_test to anon, authenticated;

insert into auth.users (id, aud, role, email) values
  ('00000000-0000-0000-0000-0000000000c1', 'authenticated', 'authenticated', 'replace-a@example.test'),
  ('00000000-0000-0000-0000-0000000000c2', 'authenticated', 'authenticated', 'replace-b@example.test');

select rc_test.login('00000000-0000-0000-0000-0000000000c1');
set local role authenticated;

---------------------------------------------------------------------------
-- Seed: class A (subgroups g1 g2; sessions s1 s2 s4) and class B (session s3)
---------------------------------------------------------------------------
select rc_test.expect_eq('seed: one push builds the starting data and moves the revision to 1',
  (select (public.push_changes(0, $j$[
    {"op":"add_class","id":"A","name":"Math","color":"#3b82f6"},
    {"op":"add_group","id":"g1","classId":"A","name":"Unit 1"},
    {"op":"add_group","id":"g2","classId":"A","name":"Unit 2"},
    {"op":"add_class","id":"B","name":"Art","color":"#8b5cf6"},
    {"op":"add_session","id":"s1","classId":"A","groupId":"g1","startedAt":1700000000000,"seconds":60,"mode":"stopwatch"},
    {"op":"add_session","id":"s2","classId":"A","groupId":null,"startedAt":1700000100000,"seconds":120,"mode":"stopwatch"},
    {"op":"add_session","id":"s4","classId":"A","groupId":"g2","startedAt":1700000200000,"seconds":240,"mode":"countdown"},
    {"op":"add_session","id":"s3","classId":"B","groupId":null,"startedAt":1700000300000,"seconds":180,"mode":"stopwatch"}
  ]$j$::jsonb) ->> 'revision')::bigint), 1::bigint);

---------------------------------------------------------------------------
-- 1. THE QUESTION: delete a class and recreate it with the SAME id in one push
---------------------------------------------------------------------------
-- Class A holds 3 sessions. Recreate A (new color), subgroup g1 (same id, same name), session s1 (same id, new length)
-- and a new session s5; subgroup g2 and sessions s2 and s4 are gone for good.
select rc_test.expect_eq('1. delete A and re-add the same class, subgroup and session ids in one push: applied',
  (select public.push_changes(1, $j$[
    {"op":"delete_class","id":"A","expectedSessions":3},
    {"op":"add_class","id":"A","name":"Math","color":"#ef4444"},
    {"op":"add_group","id":"g1","classId":"A","name":"Unit 1"},
    {"op":"add_session","id":"s1","classId":"A","groupId":"g1","startedAt":1700000000000,"seconds":90,"mode":"stopwatch"},
    {"op":"add_session","id":"s5","classId":"A","groupId":null,"startedAt":1700000400000,"seconds":30,"mode":"stopwatch"}
  ]$j$::jsonb) ->> 'status'), 'applied');
select rc_test.expect_eq('1. ... and the revision moved by exactly one', rc_test.rev(), 2::bigint);
select rc_test.expect_eq('1. ... both classes exist', rc_test.ids('classes'), 'A,B');
select rc_test.expect_eq('1. ... only the recreated subgroup exists', rc_test.ids('groups'), 'g1');
select rc_test.expect_eq('1. ... sessions: s1 and s5 recreated, s3 (class B) untouched, s2 and s4 gone', rc_test.ids('sessions'), 's1,s3,s5');
select rc_test.expect_eq('1. ... the recreated session has its NEW length and its subgroup', rc_test.sess('s1'), 'A/g1/90');
select rc_test.expect_eq('1. ... the recreated class has its NEW color', rc_test.class_color('A'), '#ef4444');
select rc_test.expect_eq('1. ... class B kept its session', rc_test.sess('s3'), 'B/-/180');

-- The delete path through the cascade and the composite foreign key, with the subgroup still referenced by a session
-- at delete time (the plan deletes sessions explicitly first; this checks the real SET NULL (group_id) FK too).
select rc_test.expect_eq('1b. deleting a subgroup is applied (revision 3)',
  (select (public.push_changes(2, '[{"op":"delete_group","id":"g1"}]'::jsonb) ->> 'revision')::bigint), 3::bigint);
select rc_test.expect_eq('1b. ... its session s1 stayed in class A with no subgroup (column-list SET NULL on the real database)', rc_test.sess('s1'), 'A/-/90');

---------------------------------------------------------------------------
-- 2. Reusing a NAME with a different id, and reusing a subgroup id under a different class
---------------------------------------------------------------------------
select rc_test.expect_eq('2. delete class A and create another class with the same name in one push',
  (select public.push_changes(3, $j$[
    {"op":"delete_class","id":"A","expectedSessions":2},
    {"op":"add_class","id":"A2","name":"Math","color":"#3b82f6"}
  ]$j$::jsonb) ->> 'revision')::bigint, 4::bigint);
select rc_test.expect_eq('2. ... classes are A2 and B, and the old sessions are gone', rc_test.ids('classes') || '|' || rc_test.ids('sessions'), 'A2,B|s3');

select rc_test.expect_eq('2b. a subgroup id deleted earlier can be used again under the new class',
  (select public.push_changes(4, $j$[
    {"op":"add_group","id":"g1","classId":"A2","name":"Unit 1"},
    {"op":"add_session","id":"s1","classId":"A2","groupId":"g1","startedAt":1700000000000,"seconds":60,"mode":"stopwatch"},
    {"op":"add_session","id":"s5","classId":"A2","groupId":null,"startedAt":1700000400000,"seconds":30,"mode":"stopwatch"}
  ]$j$::jsonb) ->> 'revision')::bigint, 5::bigint);

select rc_test.expect_eq('2c. a subgroup id freed by deleting its class can be reused under ANOTHER class in the same push',
  (select public.push_changes(5, $j$[
    {"op":"delete_class","id":"A2","expectedSessions":2},
    {"op":"add_group","id":"g1","classId":"B","name":"Unit 1"}
  ]$j$::jsonb) ->> 'revision')::bigint, 6::bigint);
select rc_test.expect_eq('2c. ... g1 now belongs to class B', rc_test.group_class('g1'), 'B');

---------------------------------------------------------------------------
-- 3. All or nothing: every kind of failure leaves the snapshot, revision included, unchanged (account at revision 6)
---------------------------------------------------------------------------
select rc_test.fail_push('3a. a valid delete and re-add followed by a bad operation (session in a class that does not exist)', 6, $j$[
    {"op":"delete_class","id":"B","expectedSessions":1},
    {"op":"add_class","id":"B","name":"Art","color":"#8b5cf6"},
    {"op":"add_session","id":"zz","classId":"missing","groupId":null,"startedAt":1700000500000,"seconds":10,"mode":"stopwatch"}
  ]$j$, '22023');

select rc_test.fail_push('3b. a wrong expectedSessions after earlier valid operations in the same push is refused (ST004) and undoes them', 6, $j$[
    {"op":"add_class","id":"Z","name":"Zed","color":"#000000"},
    {"op":"delete_class","id":"B","expectedSessions":99}
  ]$j$, 'ST004');

select rc_test.fail_push('3c. adding a class whose id still exists (no delete first) is refused (ST003)', 6,
  '[{"op":"add_class","id":"B","name":"Other","color":"#000000"}]', 'ST003');

select rc_test.fail_push('3d. the same session id twice in one push is refused (ST003)', 6, $j$[
    {"op":"add_session","id":"q","classId":"B","groupId":null,"startedAt":1700000600000,"seconds":10,"mode":"stopwatch"},
    {"op":"add_session","id":"q","classId":"B","groupId":null,"startedAt":1700000600000,"seconds":10,"mode":"stopwatch"}
  ]$j$, 'ST003');

select rc_test.fail_push('3e. a class name that differs only by case from a surviving class is refused (ST003)', 6,
  '[{"op":"add_class","id":"C","name":"ART","color":"#000000"}]', 'ST003');

select rc_test.fail_push('3f. deleting and re-adding the class but forgetting its subgroup makes the session point at a missing subgroup (22023)', 6, $j$[
    {"op":"delete_class","id":"B","expectedSessions":1},
    {"op":"add_class","id":"B","name":"Art","color":"#8b5cf6"},
    {"op":"add_session","id":"s3","classId":"B","groupId":"g1","startedAt":1700000300000,"seconds":180,"mode":"stopwatch"}
  ]$j$, '22023');

---------------------------------------------------------------------------
-- 4. Stale and empty pushes
---------------------------------------------------------------------------
do $$
declare
  before_sig text := md5(public.pull_snapshot()::text);
  r jsonb;
begin
  r := public.push_changes(5, '[{"op":"delete_class","id":"B","expectedSessions":1}]'::jsonb);
  if r ->> 'status' <> 'stale' or (r ->> 'revision')::bigint <> 6 then
    raise exception 'FAIL [4a. an old base revision is stale and reports the current revision]: got %', r;
  end if;
  if md5(public.pull_snapshot()::text) is distinct from before_sig then
    raise exception 'FAIL [4a. a stale push wrote something]';
  end if;
  raise notice 'PASS [4a. a stale push returns stale and writes nothing]';
end $$;

select rc_test.expect_eq('4b. an empty push applies nothing',
  (select (public.push_changes(6, '[]'::jsonb) ->> 'changed')::bigint), 0::bigint);
select rc_test.expect_eq('4b. ... and keeps the revision', rc_test.rev(), 6::bigint);

---------------------------------------------------------------------------
-- 5. The full replace pattern: delete everything that differs and recreate it, even with identical content
---------------------------------------------------------------------------
select rc_test.expect_eq('5a. delete B and recreate it with exactly the same content in one push',
  (select (public.push_changes(6, $j$[
    {"op":"delete_class","id":"B","expectedSessions":1},
    {"op":"add_class","id":"B","name":"Art","color":"#8b5cf6"},
    {"op":"add_group","id":"g1","classId":"B","name":"Unit 1"},
    {"op":"add_session","id":"s3","classId":"B","groupId":null,"startedAt":1700000300000,"seconds":180,"mode":"stopwatch"}
  ]$j$::jsonb) ->> 'revision')::bigint), 7::bigint);
select rc_test.expect_eq('5a. ... the data is the same and the revision moved by exactly one',
  rc_test.ids('classes') || '|' || rc_test.ids('groups') || '|' || rc_test.sess('s3'), 'B|g1|B/-/180');

select rc_test.expect_eq('5b. replacing with an EMPTY account (delete everything) works',
  (select (public.push_changes(7, '[{"op":"delete_class","id":"B","expectedSessions":1}]'::jsonb) ->> 'revision')::bigint), 8::bigint);
select rc_test.expect_eq('5b. ... the account is empty', rc_test.ids('classes') || rc_test.ids('groups') || rc_test.ids('sessions'), '');
select rc_test.expect_eq('5c. ... and can be filled again from empty',
  (select (public.push_changes(8, $j$[
    {"op":"add_class","id":"A","name":"Math","color":"#3b82f6"},
    {"op":"add_session","id":"s1","classId":"A","groupId":null,"startedAt":1700000000000,"seconds":60,"mode":"stopwatch"}
  ]$j$::jsonb) ->> 'revision')::bigint), 9::bigint);

---------------------------------------------------------------------------
-- 6. Another account is untouched by all of it, and may use the same ids
---------------------------------------------------------------------------
select rc_test.login('00000000-0000-0000-0000-0000000000c2');
set local role authenticated;
select rc_test.expect_eq('6a. the other account sees nothing', rc_test.ids('classes') || '|' || rc_test.rev()::text, '|0');
select rc_test.expect_eq('6b. ... and can create the same ids',
  (select (public.push_changes(0, '[{"op":"add_class","id":"A","name":"Math","color":"#000000"}]'::jsonb) ->> 'revision')::bigint), 1::bigint);
select rc_test.login('00000000-0000-0000-0000-0000000000c1');
set local role authenticated;
select rc_test.expect_eq('6c. the first account is unchanged by the other one', rc_test.ids('classes') || '|' || rc_test.rev()::text, 'A|9');

---------------------------------------------------------------------------
-- 7. INFORMATION ONLY (no pass or fail): how the real database folds case for names the app might meet.
--    The sync planner refuses a pair that collides under either JavaScript lowercasing or a simple per-character rule;
--    this shows what Postgres does, so any difference is visible.
--
--    For each pair, ONE push adds both names. Only SQLSTATE ST003 (push_changes' name/id conflict) is reported as "the
--    database treats them as the same name"; that is the expected, informational outcome and never fails the script.
--    Anything else (a rejected value, a stale answer, a permission problem, any other error) is not caught, so it stops
--    the script. The cleanup of classes that WERE accepted runs outside the block that catches ST003, so a cleanup
--    failure can never be mistaken for a name collision: it stops the script too.
---------------------------------------------------------------------------
do $$
declare
  pair text[];
  pairs text[][] := array[array['Straße','STRASSE'], array['İstanbul','istanbul'], array['Éclair','éclair'], array['ǅ','ǆ']];
  base bigint;
  r jsonb;
  accepted boolean;
begin
  foreach pair slice 1 in array pairs loop
    base := coalesce((select s.revision from public.sync_state s), 0);
    accepted := false;

    begin
      r := public.push_changes(base, jsonb_build_array(
        jsonb_build_object('op','add_class','id','u1','name',pair[1],'color','#000000'),
        jsonb_build_object('op','add_class','id','u2','name',pair[2],'color','#000000')));
      if r ->> 'status' is distinct from 'applied' then
        raise exception 'FAIL [7. % and %]: the push was answered % instead of applied', pair[1], pair[2], r;
      end if;
      accepted := true;
    exception
      when sqlstate 'ST003' then
        raise notice 'INFO [% and %]: refused with ST003 (the database treats them as the same name): %', pair[1], pair[2], sqlerrm;
    end;

    if accepted then
      raise notice 'INFO [% and %]: both accepted (the database treats them as different names)', pair[1], pair[2];
      -- cleanup, outside the block above: any failure here propagates and stops the script
      r := public.push_changes(base + 1, jsonb_build_array(
        jsonb_build_object('op','delete_class','id','u1','expectedSessions',0),
        jsonb_build_object('op','delete_class','id','u2','expectedSessions',0)));
      if r ->> 'status' is distinct from 'applied' then
        raise exception 'FAIL [7. cleanup after % and %]: the cleanup push was answered % instead of applied', pair[1], pair[2], r;
      end if;
    end if;
  end loop;
end $$;

reset role;
select 'ALL CHECKS PASSED' as result;

rollback;
