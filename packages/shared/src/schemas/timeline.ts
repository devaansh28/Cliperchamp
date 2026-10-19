import { z } from 'zod';
import { DEFAULT_OUTPUT_PROFILE } from '../constants/output.js';

/** Canonical project timeline shared by the editor preview, the API and the renderer. */

export const uuid = z.string().uuid();

export const OutputProfileSchema = z.object({
  width: z.number().int().min(144).max(2160),
  height: z.number().int().min(144).max(3840),
  fps: z.union([z.literal(24), z.literal(25), z.literal(30), z.literal(60)]),
  videoCodec: z.literal('h264'),
  audioCodec: z.literal('aac'),
  pixelFormat: z.literal('yuv420p'),
});
export type OutputProfile = z.infer<typeof OutputProfileSchema>;

export const TrackKindSchema = z.enum(['video', 'narration', 'music']);
export type TrackKind = z.infer<typeof TrackKindSchema>;

export const TransitionSchema = z.enum(['none', 'fade', 'slide']);

export const ClipSchema = z.object({
  id: uuid,
  track: TrackKindSchema,
  assetId: uuid,
  /** Order inside the video track (video clips play back to back). */
  order: z.number().int().min(0),
  /** Timeline start for audio clips. Ignored for video clips (computed from order). */
  startMs: z.number().int().min(0).default(0),
  /** Offset into the source media. */
  trimStartMs: z.number().int().min(0).default(0),
  /** Length of the clip on the timeline. */
  durationMs: z.number().int().min(100).max(10 * 60 * 1000),
  volume: z.number().min(0).max(2).default(1),
  fit: z.enum(['cover', 'contain']).default('cover'),
  loop: z.boolean().default(false),
  transition: TransitionSchema.default('none'),
  transitionMs: z.number().int().min(0).max(2000).default(300),
});
export type Clip = z.infer<typeof ClipSchema>;

export const CaptionWordSchema = z.object({
  text: z.string().min(1).max(64),
  startMs: z.number().int().min(0),
  endMs: z.number().int().min(0),
});
export type CaptionWord = z.infer<typeof CaptionWordSchema>;

export const TimingSourceSchema = z.enum(['estimated', 'aligned', 'imported', 'manual']);
export type TimingSource = z.infer<typeof TimingSourceSchema>;

export const CaptionSegmentSchema = z
  .object({
    id: uuid,
    startMs: z.number().int().min(0),
    endMs: z.number().int().min(1),
    text: z.string().min(1).max(500),
    words: z.array(CaptionWordSchema).max(200).optional(),
    timingSource: TimingSourceSchema.default('estimated'),
  })
  .refine((s) => s.endMs > s.startMs, { message: 'endMs must be after startMs', path: ['endMs'] });
export type CaptionSegment = z.infer<typeof CaptionSegmentSchema>;

const hexColor = z.string().regex(/^#[0-9a-fA-F]{6}$/u, 'Expected a #rrggbb color');

export const CaptionStyleSchema = z.object({
  preset: z.string().max(40).default('bold-pop'),
  fontFamily: z.enum(['Inter', 'Montserrat', 'Bebas Neue', 'Roboto Mono', 'DejaVu Sans']).default('Inter'),
  fontSize: z.number().int().min(24).max(160).default(72),
  fontWeight: z.union([z.literal(400), z.literal(600), z.literal(700), z.literal(800), z.literal(900)]).default(800),
  textColor: hexColor.default('#ffffff'),
  highlightColor: hexColor.default('#ffd400'),
  strokeColor: hexColor.default('#000000'),
  strokeWidth: z.number().min(0).max(16).default(6),
  shadow: z.boolean().default(true),
  position: z.enum(['top', 'center', 'bottom']).default('center'),
  /** Fine vertical offset in percent of the frame height (-30..30). */
  offsetY: z.number().min(-30).max(30).default(0),
  maxCharsPerLine: z.number().int().min(8).max(40).default(18),
  uppercase: z.boolean().default(true),
  animation: z.enum(['none', 'pop', 'karaoke', 'fade']).default('karaoke'),
  highlightKeywords: z.array(z.string().min(1).max(40)).max(50).default([]),
});
export type CaptionStyle = z.infer<typeof CaptionStyleSchema>;

export const TimelineSchema = z.object({
  clips: z.array(ClipSchema).max(200),
  captions: z.array(CaptionSegmentSchema).max(2000),
  captionStyle: CaptionStyleSchema,
  output: OutputProfileSchema.default(DEFAULT_OUTPUT_PROFILE),
  backgroundColor: hexColor.default('#0b0b10'),
});
export type Timeline = z.infer<typeof TimelineSchema>;
export type TimelineInput = z.input<typeof TimelineSchema>;

/** A media source the composition can load, resolved by the caller (signed URL or worker-local URL). */
export const ResolvedAssetSchema = z.object({
  id: uuid,
  kind: z.enum(['video', 'image', 'audio']),
  src: z.string().url(),
  durationMs: z.number().int().min(0).nullable(),
  width: z.number().int().nullable(),
  height: z.number().int().nullable(),
});
export type ResolvedAsset = z.infer<typeof ResolvedAssetSchema>;

export const CompositionInputSchema = z.object({
  timeline: TimelineSchema,
  assets: z.record(z.string(), ResolvedAssetSchema),
});
export type CompositionInput = z.infer<typeof CompositionInputSchema>;
