/**
 * Publish worker with in-memory platform adapters (no real platform is contacted): success,
 * transient retry with resume, auth failure, token refresh and opt-in auto-publish after an export.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createSocialRegistry, SocialAuthError, SocialPlatformError, withServiceTx } from '@clipforge/server-core';
import { createTestContext, FakeSocialAdapter, resetDatabase, TEST_SOCIAL_KEY, type RecordingQueue } from '@clipforge/server-core/testing';
import { QUEUE_NAMES } from '@clipforge/shared';
import { createWorkerContext, type WorkerContext } from '../src/context.js';
import { handlePublishVideo, queueAutoPublish } from '../src/jobs/publish-video.js';

let ctx: WorkerContext & { queue: RecordingQueue };
let youtube: FakeSocialAdapter;
let user: string;
let projectId: string;
let accountId: string;
const VIDEO_BYTES = 4096;

async function render(durationMs = 20_000): Promise<string> {
  const key = `${user}/renders/${Date.now()}-${Math.random()}.mp4`;
  const local = path.join(ctx.tempRoot, 'fake-output.mp4');
  writeFileSync(local, Buffer.alloc(VIDEO_BYTES, 1));
  await ctx.storage.putFile(key, local, 'video/mp4');
  const r = await ctx.pool.query<{ id: string }>(
    `insert into public.render_jobs (project_id, user_id, status, profile, input_snapshot, output_path, output_duration_ms, completed_at)
     values ($1, $2, 'completed', 'full', '{}', $3, $4, now()) returning id`,
    [projectId, user, key, durationMs],
  );
  return r.rows[0]!.id;
}

async function post(renderId: string): Promise<string> {
  const r = await ctx.pool.query<{ id: string }>(
    `insert into public.publish_jobs (user_id, project_id, render_job_id, social_account_id, platform, trigger, title, caption, privacy)
     values ($1, $2, $3, $4, 'youtube', 'manual', 'Title', '#tag', 'public') returning id`,
    [user, projectId, renderId, accountId],
  );
  return r.rows[0]!.id;
}

const job = async (id: string) => (await ctx.pool.query('select * from public.publish_jobs where id = $1', [id])).rows[0];

beforeAll(async () => {
  resetDatabase();
  const base = createTestContext({ SOCIAL_TOKEN_ENCRYPTION_KEY: TEST_SOCIAL_KEY });
  youtube = new FakeSocialAdapter('youtube');
  const withSocial = { ...base, social: createSocialRegistry(base.env, { youtube }) };
  ctx = { ...(await createWorkerContext(withSocial)), queue: base.queue };
  user = (await ctx.pool.query<{ id: string }>(`insert into auth.users (email) values ('pub@example.com') returning id`)).rows[0]!.id;
  projectId = (await ctx.pool.query<{ id: string }>(`insert into public.projects (user_id, name) values ($1, 'Pub') returning id`, [user])).rows[0]!.id;
  const cipher = ctx.social.cipher!;
  accountId = (
    await withServiceTx(ctx.pool, (db) =>
      db.query<{ id: string }>(
        `insert into public.social_accounts (user_id, platform, external_account_id, display_name, scopes, access_token_enc, refresh_token_enc, token_expires_at)
         values ($1, 'youtube', 'chan-1', 'My Channel', '{}', $2, $3, now() + interval '1 hour') returning id`,
        [user, cipher.encrypt('access-1'), cipher.encrypt('refresh-1')],
      ),
    )
  ).rows[0]!.id;
});

beforeEach(async () => {
  youtube.published.length = 0;
  youtube.onPublish = async () => ({ externalPostId: 'vid-1', url: 'https://youtube.com/shorts/vid-1' });
  await ctx.pool.query(`update public.social_accounts set status = 'active', last_error = null`);
});

afterAll(async () => {
  await ctx?.assetServer.stop();
  await ctx?.pool.end();
});

describe('publish worker', () => {
  it('uploads the export and records the platform post', async () => {
    const id = await post(await render());
    await handlePublishVideo(ctx, id);
    expect(await job(id)).toMatchObject({ status: 'published', attempt: 1, external_post_id: 'vid-1', external_url: 'https://youtube.com/shorts/vid-1' });
    const input = youtube.published[0]!;
    expect(input).toMatchObject({ accessToken: 'access-1', externalAccountId: 'chan-1', fileSize: VIDEO_BYTES, durationMs: 20_000, title: 'Title', caption: '#tag', resumeRef: null });
    expect(await input.publicVideoUrl()).toMatch(/^http:\/\/localhost:8787\/files\//u);
    // Running the same job again does nothing: it is no longer queued.
    await handlePublishVideo(ctx, id);
    expect(youtube.published).toHaveLength(1);
  });

  it('retries transient failures and resumes from the saved platform reference', async () => {
    const id = await post(await render());
    youtube.onPublish = async (input) => {
      await input.onPlatformRef('upload-session-1');
      throw new SocialPlatformError('503 from platform', true, 'YouTube is busy. Trying again.');
    };
    await expect(handlePublishVideo(ctx, id)).rejects.toThrow('503');
    expect(await job(id)).toMatchObject({ status: 'queued', platform_ref: 'upload-session-1', error_category: 'platform' });

    youtube.onPublish = async () => ({ externalPostId: 'vid-2', url: null });
    await handlePublishVideo(ctx, id);
    expect(youtube.published.at(-1)).toMatchObject({ resumeRef: 'upload-session-1', fileSize: 0 });
    expect(await job(id)).toMatchObject({ status: 'published', attempt: 2, external_post_id: 'vid-2' });
  });

  it('fails without retrying on permanent errors and stops after max attempts', async () => {
    const id = await post(await render());
    youtube.onPublish = async () => {
      throw new SocialPlatformError('400 bad video', false, 'YouTube rejected this video.');
    };
    await handlePublishVideo(ctx, id);
    expect(await job(id)).toMatchObject({ status: 'failed', error_message: 'YouTube rejected this video.' });

    const capped = await post(await render());
    await ctx.pool.query('update public.publish_jobs set attempt = max_attempts where id = $1', [capped]);
    await handlePublishVideo(ctx, capped);
    expect((await job(capped)).status).toBe('failed');
    expect(youtube.published).toHaveLength(1);
  });

  it('marks the account for reconnection when the platform rejects the token', async () => {
    const id = await post(await render());
    youtube.onPublish = async () => {
      throw new SocialAuthError('401');
    };
    await handlePublishVideo(ctx, id);
    expect(await job(id)).toMatchObject({ status: 'failed', error_category: 'auth' });
    const account = (await ctx.pool.query('select status from public.social_accounts where id = $1', [accountId])).rows[0];
    expect(account.status).toBe('needs_reconnect');

    // Later posts to that account fail fast instead of calling the platform.
    const next = await post(await render());
    const before = youtube.published.length;
    await handlePublishVideo(ctx, next);
    expect((await job(next)).status).toBe('failed');
    expect(youtube.published).toHaveLength(before);
  });

  it('refreshes tokens that are about to expire and stores them encrypted', async () => {
    await ctx.pool.query(`update public.social_accounts set token_expires_at = now() + interval '1 minute' where id = $1`, [accountId]);
    const id = await post(await render());
    await handlePublishVideo(ctx, id);
    expect(youtube.published.at(-1)!.accessToken).toMatch(/^refreshed-/u);
    const row = (await ctx.pool.query<{ access_token_enc: string }>('select access_token_enc from public.social_accounts where id = $1', [accountId])).rows[0]!;
    expect(ctx.social.cipher!.decrypt(row.access_token_enc)).toMatch(/^refreshed-/u);
    expect(row.access_token_enc).not.toContain('refreshed');
  });
});

describe('auto-publish', () => {
  it('does nothing unless the project opted in', async () => {
    expect(await queueAutoPublish(ctx, await render())).toBe(0);
  });

  it('queues posts for opted-in projects and records posts that break platform rules', async () => {
    await ctx.pool.query(`update public.projects set settings = jsonb_set(settings, '{autoPublish}', $2::jsonb) where id = $1`, [
      projectId,
      JSON.stringify({ enabled: true, accountIds: [accountId], title: 'Auto', caption: '#auto', privacy: 'public' }),
    ]);
    ctx.queue.take(QUEUE_NAMES.publishVideo);
    const renderId = await render();
    expect(await queueAutoPublish(ctx, renderId)).toBe(1);
    const [payload] = ctx.queue.take(QUEUE_NAMES.publishVideo);
    expect(await job(payload!.publishJobId)).toMatchObject({ trigger: 'auto', title: 'Auto', status: 'queued' });
    // Calling again (e.g. a duplicate completion) does not create a second post.
    expect(await queueAutoPublish(ctx, renderId)).toBe(0);

    const tooLong = await render(200_000);
    expect(await queueAutoPublish(ctx, tooLong)).toBe(0);
    const skipped = (await ctx.pool.query('select * from public.publish_jobs where render_job_id = $1', [tooLong])).rows[0];
    expect(skipped).toMatchObject({ status: 'failed', error_category: 'validation' });
    expect(skipped.error_message).toMatch(/YouTube.*at most 180 seconds/u);
  });

  it('ignores disconnected or reconnect-needed accounts', async () => {
    await ctx.pool.query(`update public.social_accounts set status = 'needs_reconnect' where id = $1`, [accountId]);
    expect(await queueAutoPublish(ctx, await render())).toBe(0);
  });
});
