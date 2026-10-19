/**
 * Social accounts and publishing over HTTP, with in-memory platform adapters (no real platform is
 * contacted). Covers OAuth state handling, encrypted token storage, RLS on tokens, publish rules,
 * duplicate protection, scheduling, cancel and retry.
 */
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSocialRegistry, withServiceTx, withUserTx, type ServerContext } from '@clipforge/server-core';
import { createTestContext, FakeSocialAdapter, resetDatabase, TEST_SOCIAL_KEY, type RecordingQueue } from '@clipforge/server-core/testing';
import { QUEUE_NAMES } from '@clipforge/shared';
import type { Express } from 'express';
import { createApp } from '../src/app.js';

const WEB = 'http://localhost:5173';
const youtube = new FakeSocialAdapter('youtube');
const tiktok = new FakeSocialAdapter('tiktok');
let ctx: ServerContext & { queue: RecordingQueue };
let app: Express;
let tokenA: string;
let tokenB: string;
let userA: string;
let projectId: string;

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

async function connect(token: string, platform: 'youtube' | 'tiktok') {
  const start = await request(app).post(`/api/social/${platform}/connect`).set(auth(token));
  expect(start.status).toBe(200);
  const state = new URL(start.body.authorizeUrl as string).searchParams.get('state')!;
  return { state, callback: () => request(app).get(`/api/social/oauth/${platform}/callback`).query({ code: 'good-code', state }) };
}

async function completedRender(opts: { profile?: 'full' | 'preview'; status?: string; durationMs?: number } = {}) {
  const row = await withServiceTx(ctx.pool, (db) =>
    db.query<{ id: string }>(
      `insert into public.render_jobs (project_id, user_id, status, profile, input_snapshot, output_path, output_duration_ms, completed_at)
       values ($1, $2, $3, $4, '{}'::jsonb, $5, $6, now()) returning id`,
      [projectId, userA, opts.status ?? 'completed', opts.profile ?? 'full', `${userA}/renders/x.mp4`, opts.durationMs ?? 20_000],
    ),
  );
  return row.rows[0]!.id;
}

beforeAll(async () => {
  resetDatabase();
  const base = createTestContext({ SOCIAL_TOKEN_ENCRYPTION_KEY: TEST_SOCIAL_KEY, WEB_ORIGIN: WEB });
  // Only YouTube and TikTok are "configured"; Instagram uses the real adapter with no credentials.
  ctx = { ...base, social: createSocialRegistry(base.env, { youtube, tiktok }) };
  app = createApp(ctx, { disableRateLimits: true }).app;
  const a = await request(app).post('/api/auth/register').send({ email: 'sam@example.com', password: 'correct-horse-1' });
  tokenA = a.body.accessToken;
  userA = a.body.user.id;
  tokenB = (await request(app).post('/api/auth/register').send({ email: 'eve@example.com', password: 'correct-horse-2' })).body.accessToken;
  projectId = (await request(app).post('/api/projects').set(auth(tokenA)).send({ name: 'Space facts' })).body.id;
});

afterAll(async () => {
  await ctx?.pool.end();
});

describe('connecting accounts', () => {
  it('lists platforms and explains unconfigured ones', async () => {
    const list = await request(app).get('/api/social/accounts').set(auth(tokenA));
    expect(list.body.platforms).toEqual([
      { platform: 'youtube', label: 'YouTube', configured: true },
      { platform: 'tiktok', label: 'TikTok', configured: true },
      { platform: 'instagram', label: 'Instagram', configured: false },
    ]);
    const ig = await request(app).post('/api/social/instagram/connect').set(auth(tokenA));
    expect(ig.status).toBe(503);
    expect(ig.body.error.message).toMatch(/INSTAGRAM_APP_ID/u);
    expect((await request(app).post('/api/social/myspace/connect').set(auth(tokenA))).status).toBe(400);
  });

  it('connects through OAuth and stores tokens encrypted, never returning them', async () => {
    const { callback } = await connect(tokenA, 'youtube');
    const res = await callback();
    expect(res.status).toBe(303);
    expect(res.headers.location).toBe(`${WEB}/app/settings?social=connected&platform=youtube&account=Test+Channel#accounts`);

    const list = await request(app).get('/api/social/accounts').set(auth(tokenA));
    expect(list.body.accounts).toHaveLength(1);
    expect(JSON.stringify(list.body)).not.toContain('access-1');
    const stored = await ctx.pool.query<{ access_token_enc: string; refresh_token_enc: string }>('select access_token_enc, refresh_token_enc from public.social_accounts');
    expect(stored.rows[0]!.access_token_enc).toMatch(/^v1\./u);
    expect(stored.rows[0]!.access_token_enc).not.toContain('access-1');
    expect(ctx.social.cipher!.decrypt(stored.rows[0]!.access_token_enc)).toBe('access-1');
  });

  it('rejects reused, unknown or cancelled callbacks', async () => {
    const { callback } = await connect(tokenA, 'tiktok');
    expect((await callback()).headers.location).toContain('social=connected');
    const reused = await callback();
    expect(reused.headers.location).toContain('social=error');
    expect(new URL(reused.headers.location!).searchParams.get('message')).toMatch(/expired or was already used/u);
    const denied = await request(app).get('/api/social/oauth/tiktok/callback').query({ error: 'access_denied', state: 'x'.repeat(20) });
    expect(denied.headers.location).toContain('Connection+cancelled');
    const wrongPlatform = await connect(tokenA, 'youtube');
    const cross = await request(app).get('/api/social/oauth/tiktok/callback').query({ code: 'good-code', state: wrongPlatform.state });
    expect(cross.headers.location).toContain('social=error');
  });

  it('keeps tokens out of reach of the user role, and accounts private', async () => {
    const denied = await withUserTx(ctx.pool, userA, (db) => db.query('select access_token_enc from public.social_accounts')).catch((e: { code?: string }) => e);
    expect((denied as { code?: string }).code).toBe('42501');
    const asB = await request(app).get('/api/social/accounts').set(auth(tokenB));
    expect(asB.body.accounts).toEqual([]);
    const [account] = (await request(app).get('/api/social/accounts').set(auth(tokenA))).body.accounts as { id: string }[];
    expect((await request(app).delete(`/api/social/accounts/${account!.id}`).set(auth(tokenB))).status).toBe(404);
  });
});

describe('publishing', () => {
  let ytId: string;
  let ttId: string;

  beforeAll(async () => {
    const accounts = (await request(app).get('/api/social/accounts').set(auth(tokenA))).body.accounts as { id: string; platform: string }[];
    ytId = accounts.find((a) => a.platform === 'youtube')!.id;
    ttId = accounts.find((a) => a.platform === 'tiktok')!.id;
  });

  it('queues one job per account and never posts the same export twice', async () => {
    const renderId = await completedRender();
    ctx.queue.take(QUEUE_NAMES.publishVideo);
    const body = { accountIds: [ytId, ttId], title: 'Mars', caption: '#space', privacy: 'public' };
    const first = await request(app).post(`/api/renders/${renderId}/publish`).set(auth(tokenA)).send(body);
    expect(first.status).toBe(202);
    expect(first.body.created).toHaveLength(2);
    expect(first.body.created.every((p: { status: string }) => p.status === 'queued')).toBe(true);
    expect(ctx.queue.take(QUEUE_NAMES.publishVideo)).toHaveLength(2);

    const again = await request(app).post(`/api/renders/${renderId}/publish`).set(auth(tokenA)).send(body);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ created: [], existing: [{}, {}] });
    expect(ctx.queue.take(QUEUE_NAMES.publishVideo)).toHaveLength(0);

    const list = await request(app).get(`/api/projects/${projectId}/publications`).set(auth(tokenA));
    expect(list.body).toHaveLength(2);
    expect((await request(app).get(`/api/projects/${projectId}/publications`).set(auth(tokenB))).body).toEqual([]);
  });

  it('enforces platform rules and export quality', async () => {
    const draft = await completedRender({ profile: 'preview' });
    const r1 = await request(app).post(`/api/renders/${draft}/publish`).set(auth(tokenA)).send({ accountIds: [ytId] });
    expect(r1.status).toBe(422);
    expect(r1.body.error.message).toMatch(/Full HD/u);

    const long = await completedRender({ durationMs: 200_000 });
    const r2 = await request(app).post(`/api/renders/${long}/publish`).set(auth(tokenA)).send({ accountIds: [ytId] });
    expect(r2.status).toBe(422);
    expect(r2.body.error.message).toMatch(/at most 180 seconds/u);

    const ok = await completedRender();
    const r3 = await request(app).post(`/api/renders/${ok}/publish`).set(auth(tokenA)).send({ accountIds: [ttId], privacy: 'unlisted' });
    expect(r3.status).toBe(422);
    expect((await request(app).post(`/api/renders/${ok}/publish`).set(auth(tokenA)).send({ accountIds: [] })).status).toBe(400);
  });

  it("does not let users post other people's exports or to other people's accounts", async () => {
    const renderId = await completedRender();
    expect((await request(app).post(`/api/renders/${renderId}/publish`).set(auth(tokenB)).send({ accountIds: [ytId] })).status).toBe(404);
    const bobProject = (await request(app).post('/api/projects').set(auth(tokenB)).send({ name: 'bob' })).body.id as string;
    const bobUser = (await request(app).get('/api/me').set(auth(tokenB))).body.id as string;
    const bobRender = (
      await withServiceTx(ctx.pool, (db) =>
        db.query<{ id: string }>(
          `insert into public.render_jobs (project_id, user_id, status, profile, input_snapshot, output_path, output_duration_ms) values ($1, $2, 'completed', 'full', '{}', 'x', 10000) returning id`,
          [bobProject, bobUser],
        ),
      )
    ).rows[0]!.id;
    expect((await request(app).post(`/api/renders/${bobRender}/publish`).set(auth(tokenB)).send({ accountIds: [ytId] })).status).toBe(404);
  });

  it('schedules for later, cancels queued posts and retries failed ones', async () => {
    const renderId = await completedRender();
    ctx.queue.take(QUEUE_NAMES.publishVideo);
    const at = new Date(Date.now() + 3 * 3600_000).toISOString();
    const res = await request(app).post(`/api/renders/${renderId}/publish`).set(auth(tokenA)).send({ accountIds: [ytId], scheduledAt: at });
    expect(res.status).toBe(202);
    const [job] = ctx.queue.sent.filter((j) => j.name === QUEUE_NAMES.publishVideo);
    expect(job!.opts?.startAfter?.toISOString()).toBe(at);
    ctx.queue.take(QUEUE_NAMES.publishVideo);

    const tooFar = await request(app)
      .post(`/api/renders/${await completedRender()}/publish`)
      .set(auth(tokenA))
      .send({ accountIds: [ytId], scheduledAt: new Date(Date.now() + 40 * 86400_000).toISOString() });
    expect(tooFar.status).toBe(422);

    const id = res.body.created[0].id as string;
    expect((await request(app).post(`/api/publications/${id}/retry`).set(auth(tokenA))).status).toBe(409);
    expect((await request(app).post(`/api/publications/${id}/cancel`).set(auth(tokenB))).status).toBe(404);
    const cancelled = await request(app).post(`/api/publications/${id}/cancel`).set(auth(tokenA));
    expect(cancelled.body.status).toBe('cancelled');
    expect((await request(app).post(`/api/publications/${id}/cancel`).set(auth(tokenA))).status).toBe(409);

    await withServiceTx(ctx.pool, (db) => db.query(`update public.publish_jobs set status = 'failed', error_message = 'boom' where id = $1`, [id]));
    const retried = await request(app).post(`/api/publications/${id}/retry`).set(auth(tokenA));
    expect(retried.status).toBe(200);
    expect(retried.body.status).toBe('queued');
    expect(ctx.queue.take(QUEUE_NAMES.publishVideo)).toEqual([{ publishJobId: id }]);
  });

  it('cannot insert a post that is already marked published (RLS)', async () => {
    const renderId = await completedRender();
    const err = await withUserTx(ctx.pool, userA, (db) =>
      db.query(
        `insert into public.publish_jobs (user_id, project_id, render_job_id, social_account_id, platform, trigger, status) values ($1, $2, $3, $4, 'youtube', 'manual', 'published')`,
        [userA, projectId, renderId, ytId],
      ),
    ).catch((e: { code?: string }) => e);
    expect((err as { code?: string }).code).toBe('42501');
  });

  it('disconnects, revoking tokens', async () => {
    expect((await request(app).delete(`/api/social/accounts/${ttId}`).set(auth(tokenA))).status).toBe(204);
    expect(tiktok.revoked.at(-1)?.accessToken).toBe('access-1');
    const list = await request(app).get('/api/social/accounts').set(auth(tokenA));
    expect(list.body.accounts.map((a: { platform: string }) => a.platform)).toEqual(['youtube']);
  });
});
