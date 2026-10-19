import { z } from 'zod';
import {
  CreateProjectSchema,
  CreateRenderSchema,
  PublishRequestSchema,
  CredentialsSchema,
  SaveTimelineSchema,
  ScriptRequestSchema,
  ScriptSchema,
  TimelineSchema,
  UpdateProjectSchema,
  VoicePreviewSchema,
  VoiceRequestSchema,
} from '@clipforge/shared';

const schema = (s: z.ZodType) => z.toJSONSchema(s, { io: 'input', unrepresentable: 'any' });

type Op = { summary: string; body?: string; auth?: boolean; params?: string[]; responses?: Record<string, string> };

const ops: Record<string, Record<string, Op>> = {
  '/health': { get: { summary: 'Liveness probe', auth: false } },
  '/health/ready': { get: { summary: 'Readiness: database and queue', auth: false } },
  '/api/auth/register': { post: { summary: 'Register (AUTH_PROVIDER=local only)', body: 'Credentials', auth: false } },
  '/api/auth/login': { post: { summary: 'Log in (AUTH_PROVIDER=local only)', body: 'Credentials', auth: false } },
  '/api/auth/refresh': { post: { summary: 'Rotate refresh token (local only)', auth: false } },
  '/api/auth/logout': { post: { summary: 'Revoke refresh token (local only)', auth: false } },
  '/api/me': { get: { summary: 'Current user profile' }, patch: { summary: 'Update display name' } },
  '/api/integrations': { get: { summary: 'Which optional integrations are configured' } },
  '/api/usage': { get: { summary: 'Usage against demo quotas' } },
  '/api/projects': {
    get: { summary: 'List projects (search, sort)' },
    post: { summary: 'Create project', body: 'CreateProject', responses: { '201': 'Created' } },
  },
  '/api/projects/{id}': {
    get: { summary: 'Project with script, settings and canonical timeline', params: ['id'] },
    patch: { summary: 'Rename, save script or settings', body: 'UpdateProject', params: ['id'] },
    delete: { summary: 'Delete project and its renders', params: ['id'] },
  },
  '/api/projects/{id}/timeline': { put: { summary: 'Save timeline (optimistic revision check)', body: 'SaveTimeline', params: ['id'], responses: { '409': 'Stale revision' } } },
  '/api/projects/{id}/duplicate': { post: { summary: 'Duplicate project', params: ['id'] } },
  '/api/projects/{id}/script/generate': { post: { summary: 'Generate script with the configured LLM', body: 'ScriptRequest', params: ['id'], responses: { '503': 'No LLM configured' } } },
  '/api/projects/{id}/captions/from-script': { post: { summary: 'Estimated captions from the script', params: ['id'] } },
  '/api/projects/{id}/captions/align': { post: { summary: 'Audio-aligned captions (alignment provider required)', params: ['id'] } },
  '/api/projects/{id}/media-suggestions': { get: { summary: 'Scene to stock media suggestions', params: ['id'] } },
  '/api/projects/{id}/voiceover': { post: { summary: 'Queue narration generation', body: 'VoiceRequest', params: ['id'] } },
  '/api/projects/{id}/renders': {
    get: { summary: 'Render history', params: ['id'] },
    post: { summary: 'Start a render (deduplicated; Idempotency-Key supported)', body: 'CreateRender', params: ['id'], responses: { '202': 'Queued', '200': 'Existing active job' } },
  },
  '/api/renders/{id}': { get: { summary: 'Render status and progress', params: ['id'] } },
  '/api/renders/{id}/cancel': { post: { summary: 'Cancel render', params: ['id'] } },
  '/api/renders/{id}/download': { get: { summary: 'Time-limited signed download URL (owner only)', params: ['id'] } },
  '/api/renders/{id}/playback': { get: { summary: 'Time-limited signed playback URL (owner only)', params: ['id'] } },
  '/api/media': { get: { summary: 'List media (optionally for a project)' }, post: { summary: 'Upload media (multipart field "file")' } },
  '/api/media/{id}': { get: { summary: 'Media asset', params: ['id'] }, delete: { summary: 'Delete media', params: ['id'] } },
  '/api/media/stock/search': { get: { summary: 'Search stock media provider' } },
  '/api/media/stock/import': { post: { summary: 'Import stock media' } },
  '/api/voices': { get: { summary: 'Available TTS voices' } },
  '/api/voice/preview': { post: { summary: 'Short voice preview (audio bytes)', body: 'VoicePreview' } },
  '/api/social/accounts': { get: { summary: 'Platforms (configured or not) and connected accounts. Tokens are never returned.' } },
  '/api/social/{platform}/connect': { post: { summary: 'Start OAuth: returns the platform consent URL', params: ['platform'], responses: { '503': 'Platform not configured' } } },
  '/api/social/oauth/{platform}/callback': { get: { summary: 'OAuth redirect target (browser); redirects back to the app', params: ['platform'], auth: false } },
  '/api/social/accounts/{id}': { delete: { summary: 'Disconnect an account (revokes tokens where supported)', params: ['id'] } },
  '/api/renders/{id}/publish': { post: { summary: 'Post a finished Full HD export to connected accounts, now or scheduled', body: 'PublishRequest', params: ['id'], responses: { '202': 'Queued', '422': 'Not allowed by platform rules' } } },
  '/api/renders/{id}/publications': { get: { summary: 'Posts for an export', params: ['id'] } },
  '/api/projects/{id}/publications': { get: { summary: 'Posts for a project', params: ['id'] } },
  '/api/publications/{id}/cancel': { post: { summary: 'Cancel a post that has not started', params: ['id'] } },
  '/api/publications/{id}/retry': { post: { summary: 'Retry a failed post', params: ['id'] } },
};

export function buildOpenApi(serverUrl: string) {
  const components = {
    Credentials: schema(CredentialsSchema),
    CreateProject: schema(CreateProjectSchema),
    UpdateProject: schema(UpdateProjectSchema),
    SaveTimeline: schema(SaveTimelineSchema),
    Timeline: schema(TimelineSchema),
    ScriptRequest: schema(ScriptRequestSchema),
    Script: schema(ScriptSchema),
    VoiceRequest: schema(VoiceRequestSchema),
    VoicePreview: schema(VoicePreviewSchema),
    CreateRender: schema(CreateRenderSchema),
    PublishRequest: schema(PublishRequestSchema),
  };
  const paths: Record<string, Record<string, unknown>> = {};
  for (const [p, methods] of Object.entries(ops)) {
    paths[p] = {};
    for (const [method, op] of Object.entries(methods)) {
      paths[p][method] = {
        summary: op.summary,
        ...(op.auth === false ? { security: [] } : {}),
        ...(op.params ? { parameters: op.params.map((name) => ({ name, in: 'path', required: true, schema: { type: 'string', format: 'uuid' } })) } : {}),
        ...(op.body ? { requestBody: { required: true, content: { 'application/json': { schema: { $ref: `#/components/schemas/${op.body}` } } } } } : {}),
        responses: { '200': { description: 'OK' }, ...Object.fromEntries(Object.entries(op.responses ?? {}).map(([k, v]) => [k, { description: v }])) },
      };
    }
  }
  return {
    openapi: '3.1.0',
    info: { title: 'ClipForge AI API', version: '0.1.0' },
    servers: [{ url: serverUrl }],
    components: { schemas: components, securitySchemes: { bearer: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' } } },
    security: [{ bearer: [] }],
    paths,
  };
}
