import type { RenderSnapshot } from '@clipforge/server-core';
import type { CompositionInput, ResolvedAsset } from '@clipforge/shared';

export interface StagedAsset {
  id: string;
  kind: 'video' | 'image' | 'audio';
  filename: string;
  durationMs: number | null;
  width: number | null;
  height: number | null;
}

/** Same props the editor preview passes to the Player, with sources pointing at the job's loopback server. */
export function buildCompositionInput(
  snapshot: RenderSnapshot,
  staged: StagedAsset[],
  urlFor: (filename: string) => string,
): CompositionInput {
  const assets: Record<string, ResolvedAsset> = {};
  for (const a of staged) {
    assets[a.id] = { id: a.id, kind: a.kind, src: urlFor(a.filename), durationMs: a.durationMs, width: a.width, height: a.height };
  }
  return { timeline: { ...snapshot.timeline, output: snapshot.output }, assets };
}
