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
      expires_at timestamptz not null,
      created_at timestamptz not null default now()
    )
  `);
}
