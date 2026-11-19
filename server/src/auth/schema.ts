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

  await pool.query(`
    create table if not exists seat_claims (
      meeting_id text not null,
      role text not null,
      holder text not null,
      expires_at timestamptz not null,
      primary key (meeting_id, role)
    )
  `);
}
