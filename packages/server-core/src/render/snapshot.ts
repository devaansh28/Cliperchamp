import { z } from 'zod';
import { OutputProfileSchema, TimelineSchema } from '@clipforge/shared';

/** Everything the worker needs, frozen when the user clicked Render. */
export const RenderSnapshotSchema = z.object({
  version: z.literal(1),
  timeline: TimelineSchema,
  output: OutputProfileSchema,
  assets: z.array(
    z.object({
      id: z.string().uuid(),
      kind: z.enum(['video', 'image', 'audio']),
      storagePath: z.string(),
      mimeType: z.string(),
      durationMs: z.number().int().nullable(),
      width: z.number().int().nullable(),
      height: z.number().int().nullable(),
    }),
  ),
});
export type RenderSnapshot = z.infer<typeof RenderSnapshotSchema>;
