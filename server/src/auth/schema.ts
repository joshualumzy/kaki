import type { Pool } from 'pg';

/** Create the auth tables if they are missing; safe to run on every startup. */
export async function ensureAuthSchema(pool: Pool): Promise<void> {
  await pool.query(`
    create table if not exists users (
      id text primary key,
      email text not null unique,
      password_hash text not null,
      created_at timestamptz not null default now()
    )
  `);
  // Google is the product sign-in; password accounts are still created by the host CLI.
  await pool.query('alter table users add column if not exists google_sub text');
  await pool.query('alter table users add column if not exists name text');
  await pool.query('alter table users add column if not exists picture text');
  await pool.query('alter table users alter column password_hash drop not null');
  await pool.query('create unique index if not exists users_google_sub_key on users (google_sub)');

  await pool.query(`
    create table if not exists sessions (
      token_hash text primary key,
      kind text not null check (kind in ('host', 'participant')),
      role text,
      meeting_code text,
      meeting_id text,
      expires_at timestamptz not null,
      created_at timestamptz not null default now()
    )
  `);
  // Older deployments added before a meeting generation was part of a seat.
  await pool.query('alter table sessions add column if not exists meeting_id text');
  await pool.query('alter table sessions add column if not exists display_name text');
  await pool.query('alter table sessions add column if not exists user_id text');
  // A participant session without a generation cannot be authorized against the current meeting,
  // so retire it rather than letting a NULL slip through every generation check.
  await pool.query("delete from sessions where kind = 'participant' and meeting_id is null");
  // Replace the kind check safely: older tables named it sessions_kind_check, but a deployment
  // could also carry a differently named check, so find every check that mentions `kind`.
  await pool.query(`
    do $$
    declare
      found record;
    begin
      for found in
        select conname, pg_get_constraintdef(oid) as definition
          from pg_constraint
         where conrelid = 'sessions'::regclass
           and contype = 'c'
           and pg_get_constraintdef(oid) like '%kind%'
      loop
        if found.definition not like '%user%' or found.definition not like '%guest%' then
          execute format('alter table sessions drop constraint %I', found.conname);
        end if;
      end loop;
      if not exists (
        select 1
          from pg_constraint
         where conrelid = 'sessions'::regclass
           and conname = 'sessions_kind_check'
      ) then
        alter table sessions add constraint sessions_kind_check
          check (kind in ('host', 'participant', 'user', 'guest'));
      end if;
    end $$;
  `);

  await pool.query(`
    create table if not exists seat_claims (
      meeting_id text not null,
      role text not null,
      holder text not null,
      expires_at timestamptz not null,
      primary key (meeting_id, role)
    )
  `);

  await pool.query(`
    create table if not exists workspaces (
      id text primary key,
      name text not null,
      kind text not null check (kind in ('personal', 'team')),
      created_by text references users(id),
      created_at timestamptz not null default now()
    )
  `);

  await pool.query(`
    create table if not exists workspace_members (
      workspace_id text not null references workspaces(id),
      user_id text not null references users(id),
      role text not null check (role in ('admin', 'member')),
      primary key (workspace_id, user_id)
    )
  `);

  await ensureWorkspaceToolsSchema(pool);

  await ensureMeetingsSchema(pool);
}

/** Create the per-workspace tool table if it is missing; safe to run on every startup. */
export async function ensureWorkspaceToolsSchema(pool: Pool): Promise<void> {
  await pool.query(`
    create table if not exists workspace_tools (
      workspace_id text not null,
      kind text not null check (kind in ('mattermost', 'gitea', 'wiki', 'email', 'calendar')),
      settings jsonb not null,
      secret bytea not null,
      iv bytea not null,
      tag bytea not null,
      key_id text not null,
      connected_by text not null,
      connected_at timestamptz not null default now(),
      last_ok_at timestamptz,
      primary key (workspace_id, kind)
    )
  `);
}

/**
 * Create the meetings table if it is missing, then add the real-product columns an older step-2
 * table does not have. The workspace and owner ids stay plain text: the sample workspace is built
 * into code, not a row, and an existing meeting may predate accounts.
 */
export async function ensureMeetingsSchema(pool: Pool): Promise<void> {
  await pool.query(`
    create table if not exists meetings (
      id text primary key,
      workspace_id text not null,
      owner_user_id text,
      title text not null,
      kind text not null default 'real',
      scheduled_for timestamptz,
      agenda jsonb,
      created_at timestamptz not null default now(),
      ended_at timestamptz
    )
  `);
  await pool.query('alter table meetings add column if not exists status text');
  // Kaki's own copy of an ended meeting's minutes, kept apart from any connected tool.
  await pool.query('alter table meetings add column if not exists minutes_text text');
  await pool.query('alter table meetings add column if not exists minutes_todos jsonb');
  await pool.query('alter table meetings add column if not exists minutes_archived_at timestamptz');
  await pool.query('alter table meetings add column if not exists agenda jsonb');
  // Step-2 rows had no status; an open meeting is the truthful default for them.
  await pool.query("update meetings set status = 'open' where status is null");
  await pool.query("alter table meetings alter column status set default 'open'");
  await pool.query('alter table meetings alter column status set not null');
  await pool.query(`
    do $$
    begin
      if not exists (
        select 1 from pg_constraint
         where conrelid = 'meetings'::regclass
           and conname = 'meetings_kind_check'
           and pg_get_constraintdef(oid) like '%practice%'
      ) then
        alter table meetings drop constraint if exists meetings_kind_check;
        alter table meetings add constraint meetings_kind_check
          check (kind in ('real', 'practice'));
      end if;
      if not exists (
        select 1 from pg_constraint
         where conrelid = 'meetings'::regclass and conname = 'meetings_status_check'
      ) then
        alter table meetings add constraint meetings_status_check
          check (status in ('scheduled', 'open', 'ended'));
      end if;
    end $$;
  `);
  // A practice meeting saved before its row carried a kind is still the account's own words:
  // mark it as practice so deleting the account removes it instead of handing it to the sample
  // workspace. The state table is created later in some paths, so skip until it has the column.
  await pool.query(`
    do $$
    begin
      if exists (
        select 1 from information_schema.columns
         where table_schema = current_schema()
           and table_name = 'meeting_state'
           and column_name = 'kind'
      ) then
        update meetings m
           set kind = 'practice'
         where m.kind = 'real'
           and exists (
             select 1 from meeting_state s where s.id = m.id and s.kind = 'practice'
           );
      end if;
    end $$;
  `);
}
