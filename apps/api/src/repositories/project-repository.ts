import type { PoolClient } from '@clipforge/server-core';
import {
  CaptionStyleSchema,
  DEFAULT_OUTPUT_PROFILE,
  OutputProfileSchema,
  ProjectSettingsSchema,
  type CaptionSegment,
  type Clip,
  type ProjectDetail,
  type ProjectSummary,
  type Script,
  type ScriptRequest,
  type Timeline,
} from '@clipforge/shared';

interface ProjectRow {
  id: string;
  user_id: string;
  name: string;
  template: string;
  script: Script | null;
  script_input: Partial<ScriptRequest> | null;
  settings: unknown;
  caption_style: unknown;
  output_profile: unknown;
  background_color: string;
  revision: number;
  thumbnail_path: string | null;
  created_at: Date;
  updated_at: Date;
}

interface ClipRow {
  id: string;
  asset_id: string;
  track: Clip['track'];
  sort_order: number;
  start_ms: number;
  trim_start_ms: number;
  duration_ms: number;
  volume: number;
  fit: Clip['fit'];
  loop: boolean;
  transition: Clip['transition'];
  transition_ms: number;
}

interface CaptionRow {
  id: string;
  start_ms: number;
  end_ms: number;
  text: string;
  words: CaptionSegment['words'] | null;
  timing_source: CaptionSegment['timingSource'];
}

export type SortKey = 'updated' | 'created' | 'name';

const SORT_SQL: Record<SortKey, string> = {
  updated: 'updated_at desc',
  created: 'created_at desc',
  name: 'lower(name) asc, updated_at desc',
};

function toSummary(row: ProjectRow): ProjectSummary {
  return {
    id: row.id,
    name: row.name,
    template: row.template,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    thumbnailUrl: null,
  };
}

/** All queries run inside withUserTx, so RLS limits rows to the caller; user_id filters are defense in depth. */
export const projectRepository = {
  async list(db: PoolClient, userId: string, opts: { search?: string; sort: SortKey; limit: number }): Promise<(ProjectSummary & { thumbnailPath: string | null })[]> {
    const params: unknown[] = [userId, opts.limit];
    let where = 'user_id = $1';
    if (opts.search) {
      params.push(`%${opts.search.replace(/[\\%_]/gu, (m) => `\\${m}`)}%`);
      where += ` and name ilike $${params.length}`;
    }
    const r = await db.query<ProjectRow>(
      `select * from public.projects where ${where} order by ${SORT_SQL[opts.sort]} limit $2`,
      params,
    );
    return r.rows.map((row) => ({ ...toSummary(row), thumbnailPath: row.thumbnail_path }));
  },

  async create(db: PoolClient, userId: string, input: { name: string; template: string; captionStyle: unknown }): Promise<ProjectSummary> {
    const r = await db.query<ProjectRow>(
      `insert into public.projects (user_id, name, template, caption_style, output_profile, settings)
       values ($1, $2, $3, $4, $5, $6) returning *`,
      [userId, input.name, input.template, input.captionStyle, DEFAULT_OUTPUT_PROFILE, ProjectSettingsSchema.parse({ template: input.template })],
    );
    return toSummary(r.rows[0]!);
  },

  async getRow(db: PoolClient, userId: string, id: string, forUpdate = false): Promise<ProjectRow | null> {
    const r = await db.query<ProjectRow>(
      `select * from public.projects where id = $1 and user_id = $2 ${forUpdate ? 'for update' : ''}`,
      [id, userId],
    );
    return r.rows[0] ?? null;
  },

  async getTimeline(db: PoolClient, row: ProjectRow): Promise<Timeline> {
    const clips = await db.query<ClipRow>(
      `select * from public.timeline_clips where project_id = $1 order by track, sort_order, start_ms`,
      [row.id],
    );
    const captions = await db.query<CaptionRow>(
      `select * from public.caption_segments where project_id = $1 order by start_ms`,
      [row.id],
    );
    return {
      clips: clips.rows.map((c) => ({
        id: c.id,
        track: c.track,
        assetId: c.asset_id,
        order: c.sort_order,
        startMs: c.start_ms,
        trimStartMs: c.trim_start_ms,
        durationMs: c.duration_ms,
        volume: Number(c.volume),
        fit: c.fit,
        loop: c.loop,
        transition: c.transition,
        transitionMs: c.transition_ms,
      })),
      captions: captions.rows.map((c) => ({
        id: c.id,
        startMs: c.start_ms,
        endMs: c.end_ms,
        text: c.text,
        ...(c.words ? { words: c.words } : {}),
        timingSource: c.timing_source,
      })),
      captionStyle: CaptionStyleSchema.parse(row.caption_style ?? {}),
      output: OutputProfileSchema.catch(DEFAULT_OUTPUT_PROFILE).parse(row.output_profile),
      backgroundColor: row.background_color,
    };
  },

  async detail(db: PoolClient, row: ProjectRow): Promise<ProjectDetail> {
    return {
      ...toSummary(row),
      script: row.script,
      scriptInput: row.script_input,
      settings: ProjectSettingsSchema.parse(row.settings ?? {}),
      timeline: await this.getTimeline(db, row),
      revision: row.revision,
    };
  },

  async update(
    db: PoolClient,
    id: string,
    patch: { name?: string; script?: Script | null; scriptInput?: Partial<ScriptRequest>; settings?: unknown },
  ): Promise<void> {
    const sets: string[] = [];
    const params: unknown[] = [id];
    const add = (col: string, v: unknown) => {
      params.push(v);
      sets.push(`${col} = $${params.length}`);
    };
    if (patch.name !== undefined) add('name', patch.name);
    if (patch.script !== undefined) add('script', patch.script === null ? null : JSON.stringify(patch.script));
    if (patch.scriptInput !== undefined) add('script_input', JSON.stringify(patch.scriptInput));
    if (patch.settings !== undefined) add('settings', JSON.stringify(patch.settings));
    if (sets.length === 0) return;
    await db.query(`update public.projects set ${sets.join(', ')} where id = $1`, params);
  },

  /** Replace the canonical timeline rows. Composite foreign keys reject assets owned by someone else. */
  async replaceTimeline(db: PoolClient, userId: string, projectId: string, timeline: Timeline, nextRevision: number): Promise<void> {
    await db.query('delete from public.timeline_clips where project_id = $1', [projectId]);
    await db.query('delete from public.caption_segments where project_id = $1', [projectId]);
    if (timeline.clips.length) {
      await db.query(
        `insert into public.timeline_clips
           (id, project_id, user_id, asset_id, track, sort_order, start_ms, trim_start_ms, duration_ms, volume, fit, loop, transition, transition_ms)
         select x.id, $1, $2, x."assetId", x.track, x."order", x."startMs", x."trimStartMs", x."durationMs", x.volume, x.fit, x.loop, x.transition, x."transitionMs"
           from jsonb_to_recordset($3::jsonb) as x(id uuid, "assetId" uuid, track text, "order" int, "startMs" int, "trimStartMs" int,
                "durationMs" int, volume numeric, fit text, loop boolean, transition text, "transitionMs" int)`,
        [projectId, userId, JSON.stringify(timeline.clips)],
      );
    }
    if (timeline.captions.length) {
      await db.query(
        `insert into public.caption_segments (id, project_id, user_id, start_ms, end_ms, text, words, timing_source)
         select x.id, $1, $2, x."startMs", x."endMs", x.text, x.words, x."timingSource"
           from jsonb_to_recordset($3::jsonb) as x(id uuid, "startMs" int, "endMs" int, text text, words jsonb, "timingSource" text)`,
        [projectId, userId, JSON.stringify(timeline.captions.map((c) => ({ ...c, words: c.words ?? null })))],
      );
    }
    await db.query(
      `update public.projects set caption_style = $2, output_profile = $3, background_color = $4, revision = $5 where id = $1`,
      [projectId, JSON.stringify(timeline.captionStyle), JSON.stringify(timeline.output), timeline.backgroundColor, nextRevision],
    );
  },

  async delete(db: PoolClient, userId: string, id: string): Promise<boolean> {
    const r = await db.query('delete from public.projects where id = $1 and user_id = $2', [id, userId]);
    return (r.rowCount ?? 0) > 0;
  },
};

export type { ProjectRow };
