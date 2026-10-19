import { assertWithinQuota, recordUsage, withServiceTx, withUserTx, type ServerContext } from '@clipforge/server-core';
import type { Script, ScriptRequest } from '@clipforge/shared';
import { projectRepository } from '../repositories/project-repository.js';
import { notFound } from '../utils/errors.js';

export class ScriptService {
  constructor(private readonly ctx: ServerContext) {}

  /** Calls the configured LLM; never returns a canned script. Throws ProviderNotConfiguredError when no provider is set. */
  async generate(userId: string, projectId: string, input: ScriptRequest): Promise<Script> {
    await withUserTx(this.ctx.pool, userId, async (db) => {
      if (!(await projectRepository.getRow(db, userId, projectId))) throw notFound('Project');
      await assertWithinQuota(db, this.ctx.env, userId, 'script_generation', 1);
    });
    const script = await this.ctx.llm.generateScript(input);
    await withServiceTx(this.ctx.pool, async (db) => {
      await recordUsage(db, { userId, kind: 'script_generation', quantity: 1, projectId });
    });
    await withUserTx(this.ctx.pool, userId, (db) => projectRepository.update(db, projectId, { script, scriptInput: input }));
    return script;
  }
}

/** Narration text read aloud: hook, segments, then call to action. */
export function narrationText(script: Script): string {
  return [script.hook, ...script.segments.map((s) => s.narration), script.callToAction ?? '']
    .map((s) => s.trim())
    .filter(Boolean)
    .join(' ');
}
