#!/usr/bin/env node
// Creates and resets the disposable E2E database, wipes old E2E storage and builds fixtures.
// Runs before Playwright starts the servers (see `npm run test:e2e`).
import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import pg from 'pg';

const url = process.env.E2E_DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:5432/clipforge_e2e';
const dbName = new URL(url).pathname.slice(1);
if (!/^[a-z0-9_]+_e2e$/u.test(dbName)) {
  console.error('Refusing to reset a database whose name does not end in _e2e');
  process.exit(1);
}
const admin = new URL(url);
admin.pathname = '/postgres';
const client = new pg.Client({ connectionString: admin.toString() });
await client.connect();
const exists = await client.query('select 1 from pg_database where datname = $1', [dbName]);
if (exists.rowCount === 0) await client.query(`create database ${dbName}`);
await client.end();

execFileSync(process.execPath, ['scripts/migrate.mjs', '--reset'], { env: { ...process.env, SUPABASE_DB_URL: url, AUTH_PROVIDER: 'local', NODE_ENV: 'test' }, stdio: 'inherit' });
rmSync(path.join(os.tmpdir(), 'clipforge-e2e'), { recursive: true, force: true });
execFileSync(process.execPath, ['scripts/make-fixtures.mjs'], { stdio: 'inherit' });
console.log(`e2e database ${dbName} ready`);
