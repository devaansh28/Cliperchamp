import { randomUUID } from 'node:crypto';
import { withUserTx, type ServerContext } from '@clipforge/server-core';
import {
  CAPTION_PRESETS,
  CaptionStyleSchema,
  normalizeOrders,
  timelineDurationMs,
  VIDEO_TEMPLATES,
  type ProjectDetail,
  type ProjectSummary,
  type Script,
  type ScriptRequest,
  type Timeline,
} from '@clipforge/shared';
import { projectRepository, type SortKey } from '../repositories/project-repository.js';
import { renderRepository } from '../repositories/render-repository.js';
import { conflict, notFound, unprocessable } from '../utils/errors.js';

export function captionStyleForTemplate(templateId: string) {
  const template = VIDEO_TEMPLATES.find((t) => t.id === templateId) ?? VIDEO_TEMPLATES[0]!;
  const preset = CAPTION_PRESETS.find((p) => p.id === template.captionPreset) ?? CAPTION_PRESETS[0]!;
  return CaptionStyleSchema.parse({ ...preset.style, preset: preset.id });
}

export class ProjectService {
  constructor(private readonly ctx: ServerContext) {}

  list(userId: string, opts: { search?: string; sort: SortKey }): Promise<ProjectSummary[]> {
    return withUserTx(this.ctx.pool, userId, async (db) => {
      const rows = await projectRepository.list(db, userId, { ...opts, limit: 200 });
      return Promise.all(
        rows.map(async ({ thumbnailPath, ...p }) => ({
          ...p,
          thumbnailUrl: thumbnailPath
            ? await this.ctx.storage.createSignedUrl(thumbnailPath, { expiresInSeconds: this.ctx.env.SIGNED_URL_TTL_SECONDS }).catch(() => null)
            : null,
        })),
      );
    });
  }

  create(userId: string, name: string, template = 'story'): Promise<ProjectSummary> {
    const templateId = VIDEO_TEMPLATES.some((t) => t.id === template) ? template : 'story';
    return withUserTx(this.ctx.pool, userId, (db) =>
      projectRepository.create(db, userId, { name, template: templateId, captionStyle: captionStyleForTemplate(templateId) }),
    );
  }

  get(userId: string, id: string): Promise<ProjectDetail> {
    return withUserTx(this.ctx.pool, userId, async (db) => {
      const row = await projectRepository.getRow(db, userId, id);
      if (!row) throw notFound('Project');
      return projectRepository.detail(db, row);
    });
  }

  update(
    userId: string,
    id: string,
    patch: { name?: string; script?: Script | null; scriptInput?: Partial<ScriptRequest>; settings?: Record<string, unknown> },
  ): Promise<ProjectDetail> {
    return withUserTx(this.ctx.pool, userId, async (db) => {
      const row = await projectRepository.getRow(db, userId, id, true);
      if (!row) throw notFound('Project');
      const settings = patch.settings ? { ...(row.settings as object), ...patch.settings } : undefined;
      await projectRepository.update(db, id, { ...patch, settings });
      const fresh = await projectRepository.getRow(db, userId, id);
      return projectRepository.detail(db, fresh!);
    });
  }

  /** Optimistic concurrency: rejects saves based on a stale revision so two tabs cannot silently overwrite each other. */
  saveTimeline(userId: string, id: string, timeline: Timeline, revision: number): Promise<{ revision: number; durationMs: number }> {
    if (timelineDurationMs(timeline) > this.ctx.env.RENDER_MAX_DURATION_SECONDS * 1000) {
      throw unprocessable(`Videos can be at most ${this.ctx.env.RENDER_MAX_DURATION_SECONDS} seconds long`);
    }
    return withUserTx(this.ctx.pool, userId, async (db) => {
      const row = await projectRepository.getRow(db, userId, id, true);
      if (!row) throw notFound('Project');
      if (row.revision !== revision) {
        throw conflict('This project was changed in another tab or device. Reload to get the latest version.', { currentRevision: row.revision });
      }
      const normalized = { ...timeline, clips: normalizeOrders(timeline.clips) };
      await projectRepository.replaceTimeline(db, userId, id, normalized, revision + 1);
      return { revision: revision + 1, durationMs: timelineDurationMs(normalized) };
    });
  }

  duplicate(userId: string, id: string): Promise<ProjectSummary> {
    return withUserTx(this.ctx.pool, userId, async (db) => {
      const row = await projectRepository.getRow(db, userId, id);
      if (!row) throw notFound('Project');
      const timeline = await projectRepository.getTimeline(db, row);
      const copy = await projectRepository.create(db, userId, {
        name: `${row.name} (copy)`.slice(0, 120),
        template: row.template,
        captionStyle: timeline.captionStyle,
      });
      await projectRepository.update(db, copy.id, {
        script: row.script,
        scriptInput: row.script_input ?? undefined,
        settings: row.settings,
      });
      const fresh = {
        ...timeline,
        clips: timeline.clips.map((c) => ({ ...c, id: randomUUID() })),
        captions: timeline.captions.map((c) => ({ ...c, id: randomUUID() })),
      };
      await projectRepository.replaceTimeline(db, userId, copy.id, fresh, 1);
      return copy;
    });
  }

  /** Deletes the project and its render outputs. Uploaded media stays in the user's library. */
  async delete(userId: string, id: string): Promise<void> {
    const outputs = await withUserTx(this.ctx.pool, userId, async (db) => {
      const row = await projectRepository.getRow(db, userId, id, true);
      if (!row) throw notFound('Project');
      const jobs = await renderRepository.listForProject(db, userId, id);
      await projectRepository.delete(db, userId, id);
      return jobs.flatMap((j) => [j.output_path, j.thumbnail_path]).filter((p): p is string => Boolean(p));
    });
    await this.ctx.storage.remove(outputs).catch((err: unknown) => this.ctx.log.warn({ err }, 'render output cleanup failed; cleanup job will retry'));
  }
}
