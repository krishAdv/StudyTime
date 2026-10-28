-- StudyTime M2: tables, constraints, indexes and Row Level Security.
--
-- Mirrors the app model in src/lib/types.ts and the rules in src/lib/class-rules.ts:
--   * class -> subgroups is exactly one level (a groups row references a class, never another group)
--   * class names are unique per user, subgroup names unique within a class,
--     compared after trimming, collapsing whitespace runs and ignoring case
--   * ids are the app's existing text ids (e.g. 'class-mvx1-3-ab12'), unique per user
--   * a session belongs to a class and optionally to a subgroup OF THAT SAME CLASS
--   * deleting a class deletes its subgroups and sessions; deleting a subgroup keeps
--     its sessions and nulls their subgroup
--
-- Requires PostgreSQL 15+ (ON DELETE SET NULL (column_list), added in 15; 15.13+
-- recommended, which fixes a bug in that feature). Supabase's default is 17.
-- Nothing here is applied automatically; see supabase/README.md.

---------------------------------------------------------------------------
-- Helpers
---------------------------------------------------------------------------

-- Same normalization as normalizeName() in class-rules.ts: trim, collapse
-- whitespace runs to one space. Case-insensitive comparison uses lower() of this.
-- Known gap: JavaScript's \s also matches a few exotic Unicode spaces and
-- toLocaleLowerCase() can differ from lower() for rare characters; the app
-- normalizes before sending, so the database only ever sees normalized names.
create function public.normalize_name(n text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $$
  select pg_catalog.regexp_replace(
    pg_catalog.regexp_replace(n, '^\s+|\s+$', '', 'g'),
    '\s+', ' ', 'g'
  );
$$;

create function public.touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := pg_catalog.now();
  return new;
end;
$$;

---------------------------------------------------------------------------
-- classes
---------------------------------------------------------------------------

create table public.classes (
  user_id    uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  id         text        not null,
  name       text        not null,
  color      text        not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id),
  constraint classes_id_check    check (pg_catalog.btrim(id) <> '' and pg_catalog.char_length(id) <= 100),
  -- The app always stores normalized names; refusing anything else keeps the
  -- unique index below equivalent to the app's rule.
  constraint classes_name_check  check (name = public.normalize_name(name) and pg_catalog.char_length(name) between 1 and 60),
  constraint classes_color_check check (color ~ '^#[0-9a-fA-F]{6}$')
);

create unique index classes_user_name_key on public.classes (user_id, lower(public.normalize_name(name)));

comment on table public.classes is 'A user''s classes. created_at gives the display order (the app colors classes by position).';

---------------------------------------------------------------------------
-- groups (the app's "subgroups")
---------------------------------------------------------------------------

create table public.groups (
  user_id    uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  id         text        not null,
  class_id   text        not null,
  name       text        not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- Group ids are unique per user across ALL classes: sessions refer to a group by id.
  primary key (user_id, id),
  -- Target for sessions' composite foreign key, so a session's group must be in the session's class.
  constraint groups_user_class_id_key unique (user_id, class_id, id),
  constraint groups_class_fk foreign key (user_id, class_id) references public.classes (user_id, id) on delete cascade,
  constraint groups_id_check   check (pg_catalog.btrim(id) <> '' and pg_catalog.char_length(id) <= 100),
  constraint groups_name_check check (name = public.normalize_name(name) and pg_catalog.char_length(name) between 1 and 60)
);

create unique index groups_class_name_key on public.groups (user_id, class_id, lower(public.normalize_name(name)));

comment on table public.groups is 'Subgroups: exactly one level, each belongs directly to a class. No parent column by design.';

---------------------------------------------------------------------------
-- sessions
---------------------------------------------------------------------------

create table public.sessions (
  user_id    uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  id         text        not null,
  class_id   text        not null,
  group_id   text,
  -- The app stores epoch milliseconds (whole numbers). timestamptz has microsecond
  -- precision, so every millisecond value is represented exactly. To read it back
  -- as the app's number: (extract(epoch from started_at) * 1000)::bigint
  started_at timestamptz not null,
  -- The app saves whole seconds >= 1; the upper bound (366 days) is a sanity limit, not an app rule.
  seconds    integer     not null,
  mode       text        not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id),
  constraint sessions_id_check      check (pg_catalog.btrim(id) <> '' and pg_catalog.char_length(id) <= 100),
  constraint sessions_seconds_check check (seconds between 1 and 31622400),
  constraint sessions_mode_check    check (mode in ('stopwatch', 'countdown')),
  -- Deleting a class deletes its sessions.
  constraint sessions_class_fk foreign key (user_id, class_id)
    references public.classes (user_id, id) on delete cascade,
  -- The group must belong to the same user AND the same class. With group_id null
  -- this constraint is not checked (default MATCH SIMPLE). Deleting the group nulls
  -- ONLY group_id: without the column list, class_id (NOT NULL) would be nulled too
  -- and the delete would fail. The column list needs PostgreSQL 15+.
  constraint sessions_group_fk foreign key (user_id, class_id, group_id)
    references public.groups (user_id, class_id, id) on delete set null (group_id)
);

-- Newest-first history, and the lookups the two foreign keys need for cascades.
create index sessions_user_started_idx on public.sessions (user_id, started_at desc);
create index sessions_user_class_group_idx on public.sessions (user_id, class_id, group_id);

---------------------------------------------------------------------------
-- updated_at maintenance
---------------------------------------------------------------------------

create trigger classes_touch  before update on public.classes  for each row execute function public.touch_updated_at();
create trigger groups_touch   before update on public.groups   for each row execute function public.touch_updated_at();
create trigger sessions_touch before update on public.sessions for each row execute function public.touch_updated_at();

---------------------------------------------------------------------------
-- Privileges (least privilege)
---------------------------------------------------------------------------
-- Supabase grants new public tables to anon/authenticated by default; remove that
-- and grant back only what the app does. Updates are limited to the columns the
-- app edits (rename a class or subgroup, recolor a class, reassign a session), so
-- ids, owners, durations and times are immutable from the client.

revoke all on public.classes, public.groups, public.sessions from anon, authenticated;

grant select, insert, delete on public.classes  to authenticated;
grant select, insert, delete on public.groups   to authenticated;
grant select, insert, delete on public.sessions to authenticated;

grant update (name, color)       on public.classes  to authenticated;
grant update (name)              on public.groups   to authenticated;
grant update (class_id, group_id) on public.sessions to authenticated;

---------------------------------------------------------------------------
-- Row Level Security
---------------------------------------------------------------------------
-- (select auth.uid()) is evaluated once per statement, not per row.
-- There is no policy for anon, so anonymous users get nothing.

alter table public.classes  enable row level security;
alter table public.groups   enable row level security;
alter table public.sessions enable row level security;

create policy classes_select on public.classes for select to authenticated
  using (user_id = (select auth.uid()));
create policy classes_insert on public.classes for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy classes_update on public.classes for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy classes_delete on public.classes for delete to authenticated
  using (user_id = (select auth.uid()));

create policy groups_select on public.groups for select to authenticated
  using (user_id = (select auth.uid()));
create policy groups_insert on public.groups for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy groups_update on public.groups for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy groups_delete on public.groups for delete to authenticated
  using (user_id = (select auth.uid()));

create policy sessions_select on public.sessions for select to authenticated
  using (user_id = (select auth.uid()));
create policy sessions_insert on public.sessions for insert to authenticated
  with check (user_id = (select auth.uid()));
create policy sessions_update on public.sessions for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy sessions_delete on public.sessions for delete to authenticated
  using (user_id = (select auth.uid()));
