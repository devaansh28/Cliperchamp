/**
 * Row Level Security tests run directly against PostgreSQL as the `authenticated` role with
 * Supabase-style JWT claims, independent of the API's own checks.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { withServiceTx, withUserTx } from '@clipforge/server-core';
import { createTestContext, resetDatabase } from '@clipforge/server-core/testing';

const ctx = createTestContext();
let alice: string;
let bob: string;
let aliceProject: string;
let aliceAsset: string;

beforeAll(async () => {
  resetDatabase();
  const users = await ctx.pool.query<{ id: string }>(`insert into auth.users (email) values ('a@rls.test'), ('b@rls.test') returning id`);
  alice = users.rows[0]!.id;
  bob = users.rows[1]!.id;
  aliceProject = (await withUserTx(ctx.pool, alice, (db) => db.query<{ id: string }>(`insert into public.projects (user_id, name) values ($1, 'secret') returning id`, [alice]))).rows[0]!.id;
  aliceAsset = (
    await withServiceTx(ctx.pool, (db) =>
      db.query<{ id: string }>(
        `insert into public.media_assets (user_id, project_id, kind, source, status, storage_path, mime_type, size_bytes)
         values ($1, $2, 'video', 'upload', 'ready', $3, 'video/mp4', 10) returning id`,
        [alice, aliceProject, `${alice}/uploads/x.mp4`],
      ),
    )
  ).rows[0]!.id;
});

afterAll(async () => {
  await ctx.pool.end();
});

describe('row level security', () => {
  it('hides other users rows', async () => {
    const asBob = await withUserTx(ctx.pool, bob, async (db) => ({
      projects: (await db.query('select id from public.projects')).rowCount,
      media: (await db.query('select id from public.media_assets')).rowCount,
      profiles: (await db.query('select id from public.profiles')).rows,
    }));
    expect(asBob.projects).toBe(0);
    expect(asBob.media).toBe(0);
    expect(asBob.profiles).toEqual([{ id: bob }]);
    const asAlice = await withUserTx(ctx.pool, alice, (db) => db.query('select id from public.projects'));
    expect(asAlice.rowCount).toBe(1);
  });

  it('blocks writes to other users rows', async () => {
    const updated = await withUserTx(ctx.pool, bob, (db) => db.query(`update public.projects set name = 'pwned' where id = $1`, [aliceProject]));
    expect(updated.rowCount).toBe(0);
    const deleted = await withUserTx(ctx.pool, bob, (db) => db.query('delete from public.projects where id = $1', [aliceProject]));
    expect(deleted.rowCount).toBe(0);
    await expect(
      withUserTx(ctx.pool, bob, (db) => db.query(`insert into public.projects (user_id, name) values ($1, 'impersonation')`, [alice])),
    ).rejects.toMatchObject({ code: '42501' });
  });

  it('prevents attaching rows to someone else’s project or media', async () => {
    const bobProject = (await withUserTx(ctx.pool, bob, (db) => db.query<{ id: string }>(`insert into public.projects (user_id, name) values ($1, 'bob') returning id`, [bob]))).rows[0]!.id;
    // Bob's clip pointing at Alice's asset violates the (asset_id, user_id) foreign key.
    await expect(
      withUserTx(ctx.pool, bob, (db) =>
        db.query(`insert into public.timeline_clips (id, project_id, user_id, asset_id, track, sort_order, duration_ms) values (gen_random_uuid(), $1, $2, $3, 'video', 0, 1000)`, [bobProject, bob, aliceAsset]),
      ),
    ).rejects.toMatchObject({ code: '23503' });
    // Bob cannot queue a render for Alice's project.
    await expect(
      withUserTx(ctx.pool, bob, (db) => db.query(`insert into public.render_jobs (project_id, user_id, input_snapshot) values ($1, $2, '{}'::jsonb)`, [aliceProject, bob])),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('does not let users change render job state', async () => {
    const job = (
      await withServiceTx(ctx.pool, (db) =>
        db.query<{ id: string }>(`insert into public.render_jobs (project_id, user_id, input_snapshot) values ($1, $2, '{}'::jsonb) returning id`, [aliceProject, alice]),
      )
    ).rows[0]!.id;
    await expect(
      withUserTx(ctx.pool, alice, (db) => db.query(`update public.render_jobs set status = 'completed', output_path = 'x' where id = $1`, [job])),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(withUserTx(ctx.pool, alice, (db) => db.query('delete from public.usage_events'))).rejects.toMatchObject({ code: '42501' });
  });
});
