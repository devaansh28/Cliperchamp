/**
 * HTTP-level tests: auth, project CRUD, ownership isolation, uploads, script generation through a
 * fake OpenAI-compatible server, captions, render job rules and signed file URLs.
 * Requires the disposable PostgreSQL in TEST_DATABASE_URL (it is reset).
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestContext, ensureFixtures, FIXTURES_DIR, resetDatabase, type RecordingQueue } from '@clipforge/server-core/testing';
import { CaptionStyleSchema, QUEUE_NAMES, type Timeline } from '@clipforge/shared';
import type { ServerContext } from '@clipforge/server-core';
import type { Express } from 'express';
import { createApp } from '../src/app.js';

let fakeLlm: http.Server;
let ctx: ServerContext & { queue: RecordingQueue };
let app: Express;
let tokenA: string;
let tokenB: string;
let userA: string;

/** Fake OpenAI-compatible chat endpoint: returns a valid script unless the topic asks for garbage. */
function startFakeLlm(): Promise<string> {
  fakeLlm = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c: Buffer) => (body += c.toString()));
    req.on('end', () => {
      const parsed = JSON.parse(body) as { messages: { content: string }[] };
      const prompt = parsed.messages.map((m) => m.content).join('\n');
      const content = prompt.includes('INVALID')
        ? JSON.stringify({ hook: '', segments: [] })
        : JSON.stringify({
            hook: 'Octopuses have three hearts.',
            segments: [
              { narration: 'Two pump blood to the gills, one to the body.', scene: 'octopus swimming' },
              { narration: 'And their blood is blue.', scene: 'blue water' },
            ],
            callToAction: 'Follow for more ocean facts.',
            estimatedDurationSec: 12,
          });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content } }] }));
    });
  });
  return new Promise((resolve) => fakeLlm.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(fakeLlm.address() as AddressInfo).port}/v1`)));
}

const auth = (t: string) => ({ authorization: `Bearer ${t}` });

function captionTimeline(text = 'Hello world'): Timeline {
  return {
    clips: [],
    captions: [{ id: randomUUID(), startMs: 0, endMs: 1500, text, timingSource: 'manual' }],
    captionStyle: CaptionStyleSchema.parse({}),
    output: { width: 1080, height: 1920, fps: 30, videoCodec: 'h264', audioCodec: 'aac', pixelFormat: 'yuv420p' },
    backgroundColor: '#000000',
  };
}

beforeAll(async () => {
  ensureFixtures();
  resetDatabase();
  const llmUrl = await startFakeLlm();
  ctx = createTestContext({ LLM_PROVIDER: 'openai-compatible', LLM_BASE_URL: llmUrl, LLM_MODEL: 'fake-model', LLM_API_KEY: 'fake-key', QUOTA_SCRIPT_GENERATIONS: '3' });
  app = createApp(ctx, { disableRateLimits: true }).app;

  const a = await request(app).post('/api/auth/register').send({ email: 'alice@example.com', password: 'correct-horse-1' });
  expect(a.status).toBe(201);
  tokenA = a.body.accessToken;
  userA = a.body.user.id;
  const b = await request(app).post('/api/auth/register').send({ email: 'bob@example.com', password: 'correct-horse-2' });
  tokenB = b.body.accessToken;
});

afterAll(async () => {
  fakeLlm?.close();
  await ctx?.pool.end();
});

describe('health and docs', () => {
  it('reports health and serves OpenAPI', async () => {
    expect((await request(app).get('/health')).body).toMatchObject({ status: 'ok' });
    const spec = await request(app).get('/api/openapi.json');
    expect(spec.status).toBe(200);
    expect(spec.body.openapi).toMatch(/^3\./u);
    expect(Object.keys(spec.body.paths)).toContain('/api/projects');
  });

  it('sets security headers', async () => {
    const res = await request(app).get('/health');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});

describe('local auth', () => {
  it('rejects duplicate email, wrong password and short passwords', async () => {
    expect((await request(app).post('/api/auth/register').send({ email: 'alice@example.com', password: 'whatever-123' })).status).toBe(409);
    expect((await request(app).post('/api/auth/login').send({ email: 'alice@example.com', password: 'wrong-password' })).status).toBe(401);
    const short = await request(app).post('/api/auth/register').send({ email: 'c@example.com', password: 'short' });
    expect(short.status).toBe(400);
    expect(short.body.error.code).toBe('validation_error');
  });

  it('rotates refresh tokens and rejects reuse', async () => {
    const login = await request(app).post('/api/auth/login').send({ email: 'alice@example.com', password: 'correct-horse-1' });
    expect(login.status).toBe(200);
    const r1 = await request(app).post('/api/auth/refresh').send({ refreshToken: login.body.refreshToken });
    expect(r1.status).toBe(200);
    expect(r1.body.refreshToken).not.toBe(login.body.refreshToken);
    expect((await request(app).post('/api/auth/refresh').send({ refreshToken: login.body.refreshToken })).status).toBe(401);
  });

  it('requires a valid bearer token for the API', async () => {
    expect((await request(app).get('/api/projects')).status).toBe(401);
    expect((await request(app).get('/api/projects').set(auth('not-a-jwt'))).status).toBe(401);
    expect((await request(app).get('/api/me').set(auth(tokenA))).body).toMatchObject({ id: userA, email: 'alice@example.com' });
  });
});

describe('projects', () => {
  let projectId: string;

  it('creates, lists, searches, sorts, renames, duplicates and deletes', async () => {
    const created = await request(app).post('/api/projects').set(auth(tokenA)).send({ name: 'Ocean facts', template: 'explainer' });
    expect(created.status).toBe(201);
    projectId = created.body.id;
    await request(app).post('/api/projects').set(auth(tokenA)).send({ name: 'Another one' });

    const detail = await request(app).get(`/api/projects/${projectId}`).set(auth(tokenA));
    expect(detail.body).toMatchObject({ name: 'Ocean facts', template: 'explainer', revision: 0, script: null });
    expect(detail.body.timeline.captionStyle.preset).toBe('forge');

    const search = await request(app).get('/api/projects?search=ocean').set(auth(tokenA));
    expect(search.body.map((p: { name: string }) => p.name)).toEqual(['Ocean facts']);
    const byName = await request(app).get('/api/projects?sort=name').set(auth(tokenA));
    expect(byName.body.map((p: { name: string }) => p.name)).toEqual(['Another one', 'Ocean facts']);

    const renamed = await request(app).patch(`/api/projects/${projectId}`).set(auth(tokenA)).send({ name: 'Ocean facts v2' });
    expect(renamed.status).toBe(200);

    const dup = await request(app).post(`/api/projects/${projectId}/duplicate`).set(auth(tokenA));
    expect(dup.status).toBe(201);
    expect(dup.body.name).toBe('Ocean facts v2 (copy)');
    expect((await request(app).delete(`/api/projects/${dup.body.id}`).set(auth(tokenA))).status).toBe(204);
    expect((await request(app).get(`/api/projects/${dup.body.id}`).set(auth(tokenA))).status).toBe(404);
  });

  it('validates input and ids', async () => {
    expect((await request(app).post('/api/projects').set(auth(tokenA)).send({ name: '' })).status).toBe(400);
    expect((await request(app).get('/api/projects/not-a-uuid').set(auth(tokenA))).status).toBe(404);
  });

  it('saves the timeline with optimistic concurrency', async () => {
    const t = captionTimeline();
    const first = await request(app).put(`/api/projects/${projectId}/timeline`).set(auth(tokenA)).send({ timeline: t, revision: 0 });
    expect(first.body).toEqual({ revision: 1, durationMs: 1500 });
    const stale = await request(app).put(`/api/projects/${projectId}/timeline`).set(auth(tokenA)).send({ timeline: t, revision: 0 });
    expect(stale.status).toBe(409);
    const reopened = await request(app).get(`/api/projects/${projectId}`).set(auth(tokenA));
    expect(reopened.body.timeline.captions).toHaveLength(1);
    expect(reopened.body.revision).toBe(1);
  });

  it("keeps users out of each other's projects", async () => {
    expect((await request(app).get(`/api/projects/${projectId}`).set(auth(tokenB))).status).toBe(404);
    expect((await request(app).patch(`/api/projects/${projectId}`).set(auth(tokenB)).send({ name: 'pwned' })).status).toBe(404);
    expect((await request(app).put(`/api/projects/${projectId}/timeline`).set(auth(tokenB)).send({ timeline: captionTimeline(), revision: 1 })).status).toBe(404);
    expect((await request(app).post(`/api/projects/${projectId}/duplicate`).set(auth(tokenB))).status).toBe(404);
    expect((await request(app).delete(`/api/projects/${projectId}`).set(auth(tokenB))).status).toBe(404);
    expect((await request(app).post(`/api/projects/${projectId}/renders`).set(auth(tokenB)).send({})).status).toBe(404);
    expect((await request(app).get('/api/projects').set(auth(tokenB))).body).toEqual([]);
    expect((await request(app).get(`/api/projects/${projectId}`).set(auth(tokenA))).body.name).toBe('Ocean facts v2');
  });
});

describe('media uploads', () => {
  let projectId: string;
  let assetId: string;

  beforeAll(async () => {
    projectId = (await request(app).post('/api/projects').set(auth(tokenA)).send({ name: 'Media' })).body.id;
  });

  it('rejects files whose content is not real media', async () => {
    const res = await request(app).post('/api/media').set(auth(tokenA)).field('projectId', projectId).attach('file', path.join(FIXTURES_DIR, 'fake.mp4'));
    expect(res.status).toBe(415);
  });

  it('accepts real media, stores it privately and queues processing', async () => {
    const res = await request(app).post('/api/media').set(auth(tokenA)).field('projectId', projectId).attach('file', path.join(FIXTURES_DIR, 'background.mp4'));
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ kind: 'video', status: 'pending', mimeType: 'video/mp4', originalName: 'background.mp4' });
    assetId = res.body.id;
    const jobs = ctx.queue.take(QUEUE_NAMES.processMedia);
    expect(jobs).toEqual([{ assetId, userId: userA }]);
    const row = await ctx.pool.query<{ storage_path: string }>('select storage_path from public.media_assets where id = $1', [assetId]);
    expect(row.rows[0]!.storage_path.startsWith(`${userA}/`)).toBe(true);
  });

  it("does not expose one user's media to another", async () => {
    expect((await request(app).get(`/api/media/${assetId}`).set(auth(tokenB))).status).toBe(404);
    expect((await request(app).delete(`/api/media/${assetId}`).set(auth(tokenB))).status).toBe(404);
    expect((await request(app).get('/api/media').set(auth(tokenB))).body).toEqual([]);
    // Bob cannot attach his upload to Alice's project, nor reference Alice's asset in his timeline.
    const bobProject = (await request(app).post('/api/projects').set(auth(tokenB)).send({ name: 'Bob' })).body.id;
    const upload = await request(app).post('/api/media').set(auth(tokenB)).field('projectId', projectId).attach('file', path.join(FIXTURES_DIR, 'still.png'));
    expect(upload.status).toBe(404);
    const t = captionTimeline();
    t.clips.push({ id: randomUUID(), track: 'video', assetId, order: 0, startMs: 0, trimStartMs: 0, durationMs: 1000, volume: 1, fit: 'cover', loop: false, transition: 'none', transitionMs: 300 });
    const save = await request(app).put(`/api/projects/${bobProject}/timeline`).set(auth(tokenB)).send({ timeline: t, revision: 0 });
    expect(save.status).toBe(409);
  });

  it('serves stored files only through valid signed URLs, with range support', async () => {
    const row = await ctx.pool.query<{ storage_path: string }>('select storage_path from public.media_assets where id = $1', [assetId]);
    const url = new URL(await ctx.storage.createSignedUrl(row.rows[0]!.storage_path, { expiresInSeconds: 60 }));
    const ok = await request(app).get(url.pathname + url.search).set('range', 'bytes=0-99');
    expect(ok.status).toBe(206);
    expect(ok.headers['content-length']).toBe('100');
    const tampered = new URL(url);
    tampered.searchParams.set('sig', 'A'.repeat(43));
    expect((await request(app).get(tampered.pathname + tampered.search)).status).toBe(403);
    expect((await request(app).get(url.pathname)).status).toBe(403);
    const traversal = await request(app).get(`/files/${userA}/../../etc/passwd?exp=9999999999&sig=x`);
    expect([403, 404]).toContain(traversal.status);
  });
});

describe('script generation', () => {
  let projectId: string;
  beforeAll(async () => {
    projectId = (await request(app).post('/api/projects').set(auth(tokenA)).send({ name: 'Script' })).body.id;
  });

  it('generates a validated script and saves it to the project', async () => {
    const res = await request(app).post(`/api/projects/${projectId}/script/generate`).set(auth(tokenA)).send({ topic: 'octopus facts', targetDurationSec: 20 });
    expect(res.status).toBe(200);
    expect(res.body.hook).toBe('Octopuses have three hearts.');
    const project = await request(app).get(`/api/projects/${projectId}`).set(auth(tokenA));
    expect(project.body.script.segments).toHaveLength(2);
    expect(project.body.scriptInput.topic).toBe('octopus facts');
  });

  it('rejects malformed model output instead of saving it', async () => {
    const res = await request(app).post(`/api/projects/${projectId}/script/generate`).set(auth(tokenA)).send({ topic: 'INVALID output please' });
    expect(res.status).toBe(502);
    expect(res.body.error.code).toBe('provider_error');
    const project = await request(app).get(`/api/projects/${projectId}`).set(auth(tokenA));
    expect(project.body.script.hook).toBe('Octopuses have three hearts.');
  });

  it('builds captions from the script with estimated timing', async () => {
    const res = await request(app).post(`/api/projects/${projectId}/captions/from-script`).set(auth(tokenA)).send({});
    expect(res.status).toBe(200);
    expect(res.body.timing).toBe('estimated');
    expect(res.body.captions.length).toBeGreaterThan(2);
    expect(res.body.captions.every((c: { timingSource: string }) => c.timingSource === 'estimated')).toBe(true);
  });

  it('enforces the monthly quota without charging', async () => {
    // Quota is 3 in this test context; one success so far (failed calls are not counted).
    await request(app).post(`/api/projects/${projectId}/script/generate`).set(auth(tokenA)).send({ topic: 'more octopus facts' });
    await request(app).post(`/api/projects/${projectId}/script/generate`).set(auth(tokenA)).send({ topic: 'even more octopus facts' });
    const blocked = await request(app).post(`/api/projects/${projectId}/script/generate`).set(auth(tokenA)).send({ topic: 'too many octopus facts' });
    expect(blocked.status).toBe(402);
    expect(blocked.body.error.code).toBe('quota_exceeded');
    const usage = await request(app).get('/api/usage').set(auth(tokenA));
    expect(usage.body.items.find((i: { kind: string }) => i.kind === 'script_generation')).toMatchObject({ used: 3, limit: 3 });
  });

  it('explains when a provider is not configured', async () => {
    const bare = createTestContext();
    const bareApp = createApp(bare, { disableRateLimits: true }).app;
    try {
      const res = await request(bareApp).post(`/api/projects/${projectId}/script/generate`).set(auth(tokenA)).send({ topic: 'octopus facts' });
      expect(res.status).toBe(503);
      expect(res.body.error.code).toBe('integration_not_configured');
      const voice = await request(bareApp).post(`/api/projects/${projectId}/voiceover`).set(auth(tokenA)).send({ voiceId: 'en-us' });
      expect(voice.status).toBe(503);
      const integrations = await request(bareApp).get('/api/integrations').set(auth(tokenA));
      expect(integrations.body).toMatchObject({ llm: { configured: false }, tts: { configured: false }, auth: { provider: 'local' } });
      expect(JSON.stringify(integrations.body)).not.toContain('fake-key');
    } finally {
      await bare.pool.end();
    }
  });
});

describe('render jobs', () => {
  let projectId: string;
  let jobId: string;

  beforeAll(async () => {
    projectId = (await request(app).post('/api/projects').set(auth(tokenA)).send({ name: 'Render rules' })).body.id;
  });

  it('refuses to render an empty project', async () => {
    const res = await request(app).post(`/api/projects/${projectId}/renders`).set(auth(tokenA)).send({});
    expect(res.status).toBe(422);
  });

  it('queues one job and reuses it for duplicate or idempotent requests', async () => {
    await request(app).put(`/api/projects/${projectId}/timeline`).set(auth(tokenA)).send({ timeline: captionTimeline(), revision: 0 });
    const first = await request(app).post(`/api/projects/${projectId}/renders`).set(auth(tokenA)).set('idempotency-key', 'key-123456').send({ profile: 'preview' });
    expect(first.status).toBe(202);
    expect(first.body).toMatchObject({ status: 'queued', profile: 'preview', attempt: 0 });
    jobId = first.body.id;
    const retry = await request(app).post(`/api/projects/${projectId}/renders`).set(auth(tokenA)).set('idempotency-key', 'key-123456').send({ profile: 'preview' });
    expect(retry.status).toBe(200);
    expect(retry.body.id).toBe(jobId);
    const dup = await request(app).post(`/api/projects/${projectId}/renders`).set(auth(tokenA)).send({});
    expect(dup.status).toBe(200);
    expect(dup.body.id).toBe(jobId);
    expect(ctx.queue.take(QUEUE_NAMES.renderVideo)).toEqual([{ renderJobId: jobId }]);
  });

  it('only lets the owner see, cancel or download a job', async () => {
    expect((await request(app).get(`/api/renders/${jobId}`).set(auth(tokenB))).status).toBe(404);
    expect((await request(app).post(`/api/renders/${jobId}/cancel`).set(auth(tokenB))).status).toBe(404);
    expect((await request(app).get(`/api/renders/${jobId}/download`).set(auth(tokenB))).status).toBe(404);
    expect((await request(app).get(`/api/renders/${jobId}/download`).set(auth(tokenA))).status).toBe(409);
    const cancelled = await request(app).post(`/api/renders/${jobId}/cancel`).set(auth(tokenA));
    expect(cancelled.body.status).toBe('cancelled');
    const list = await request(app).get(`/api/projects/${projectId}/renders`).set(auth(tokenA));
    expect(list.body.map((r: { id: string }) => r.id)).toEqual([jobId]);
  });

  it('rejects malformed idempotency keys', async () => {
    const res = await request(app).post(`/api/projects/${projectId}/renders`).set(auth(tokenA)).set('idempotency-key', 'bad key!').send({});
    expect(res.status).toBe(400);
  });
});

describe('fixtures', () => {
  it('fake.mp4 is really not a video', () => {
    expect(readFileSync(path.join(FIXTURES_DIR, 'fake.mp4'), 'utf8')).toContain('not a video');
  });
});
