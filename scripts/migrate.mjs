#!/usr/bin/env node
// Applies supabase/migrations/*.sql in order and records them.
// Use this when the Supabase CLI is unavailable; with the CLI, prefer `supabase db push`.
//
//   node scripts/migrate.mjs            apply pending migrations to SUPABASE_DB_URL
//   node scripts/migrate.mjs --reset    DROP app schemas first (refuses in production)
//
// On plain PostgreSQL (no `auth` schema) it first applies supabase/dev/auth-shim.sql.
// With AUTH_PROVIDER=local it also applies supabase/dev/local-auth.sql.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import pg from 'pg';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export async function migrate({ databaseUrl, reset = false, localAuth = false, log = console.log } = {}) {
  if (!databaseUrl) throw new Error('SUPABASE_DB_URL is not set');
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    if (reset) {
      if (process.env.NODE_ENV === 'production') throw new Error('Refusing --reset in production');
      const supabaseAuth = await client.query(`select 1 from information_schema.tables where table_schema='auth' and table_name='schema_migrations'`);
      if (supabaseAuth.rowCount > 0) throw new Error('Refusing --reset on a Supabase database; use `supabase db reset` instead');
      await client.query(`
        drop schema if exists public cascade; create schema public;
        grant usage on schema public to public;
        drop schema if exists pgboss cascade;
        drop schema if exists local_auth cascade;`);
      await client.query('drop schema if exists auth cascade');
      log('reset: dropped app schemas');
    }
    const hasAuth = await client.query(`select 1 from information_schema.schemata where schema_name = 'auth'`);
    if (hasAuth.rowCount === 0) {
      log('auth schema missing: applying dev auth shim (plain PostgreSQL mode)');
      await client.query(await readFile(path.join(root, 'supabase/dev/auth-shim.sql'), 'utf8'));
    }
    if (localAuth) await client.query(await readFile(path.join(root, 'supabase/dev/local-auth.sql'), 'utf8'));

    await client.query(`create table if not exists public.clipforge_migrations (
      name text primary key, applied_at timestamptz not null default now())`);
    const dir = path.join(root, 'supabase/migrations');
    const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
    const done = new Set((await client.query('select name from public.clipforge_migrations')).rows.map((r) => r.name));
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = await readFile(path.join(dir, file), 'utf8');
      await client.query('begin');
      try {
        await client.query(sql);
        await client.query('insert into public.clipforge_migrations (name) values ($1)', [file]);
        await client.query('commit');
        log(`applied ${file}`);
      } catch (err) {
        await client.query('rollback');
        throw new Error(`Migration ${file} failed: ${err.message}`);
      }
    }
    log('migrations up to date');
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  migrate({
    databaseUrl: process.env.SUPABASE_DB_URL,
    reset: process.argv.includes('--reset'),
    localAuth: (process.env.AUTH_PROVIDER ?? 'supabase') === 'local',
  }).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
