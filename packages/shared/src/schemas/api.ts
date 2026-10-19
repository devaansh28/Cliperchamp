import { z } from 'zod';
import { PUBLISH_PRIVACY } from '../constants/social.js';
import { CaptionStyleSchema, TimelineSchema } from './timeline.js';

export const ScriptRequestSchema = z.object({
  topic: z.string().trim().min(3).max(500),
  audience: z.string().trim().max(200).default('general audience'),
  language: z.string().trim().min(2).max(40).default('English'),
  tone: z.string().trim().max(60).default('energetic'),
  targetDurationSec: z.number().int().min(10).max(180).default(45),
  objective: z.string().trim().max(300).default('educate and entertain'),
  sourceScript: z.string().max(10000).optional(),
});
export type ScriptRequest = z.infer<typeof ScriptRequestSchema>;

export const ScriptSegmentSchema = z.object({
  narration: z.string().trim().min(1).max(1200),
  scene: z.string().trim().max(400).default(''),
});

/** Validated structure we require from any LLM provider (and from manual edits). */
export const ScriptSchema = z.object({
  hook: z.string().trim().min(1).max(400),
  segments: z.array(ScriptSegmentSchema).min(1).max(30),
  callToAction: z.string().trim().max(300).optional().nullable(),
  estimatedDurationSec: z.number().min(1).max(600),
});
export type Script = z.infer<typeof ScriptSchema>;

export const PublishDetailsSchema = z.object({
  /** Used as the YouTube title. Other platforms only use the caption. */
  title: z.string().trim().max(100).default(''),
  caption: z.string().trim().max(2200).default(''),
  privacy: z.enum(PUBLISH_PRIVACY).default('public'),
});
export type PublishDetails = z.infer<typeof PublishDetailsSchema>;

/** Opt-in: post every finished Full HD export of this project to the chosen accounts. */
export const AutoPublishSchema = PublishDetailsSchema.extend({
  enabled: z.boolean().default(false),
  accountIds: z.array(z.string().uuid()).max(20).default([]),
});
export type AutoPublishSettings = z.infer<typeof AutoPublishSchema>;

export const PublishRequestSchema = PublishDetailsSchema.extend({
  accountIds: z.array(z.string().uuid()).min(1, 'Choose at least one account').max(20),
  /** ISO time to post later; omitted or past means now. */
  scheduledAt: z.string().datetime({ offset: true }).nullable().optional(),
});
export type PublishRequest = z.infer<typeof PublishRequestSchema>;

export const ProjectSettingsSchema = z.object({
  template: z.string().max(40).default('story'),
  voice: z
    .object({ voiceId: z.string().max(80).default('en-us'), speed: z.number().min(0.5).max(2).default(1) })
    .default({ voiceId: 'en-us', speed: 1 }),
  autoPublish: AutoPublishSchema.default({ enabled: false, accountIds: [], title: '', caption: '', privacy: 'public' }),
});
export type ProjectSettings = z.infer<typeof ProjectSettingsSchema>;

export const CreateProjectSchema = z.object({
  name: z.string().trim().min(1).max(120),
  template: z.string().max(40).optional(),
});
export const UpdateProjectSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  script: ScriptSchema.nullable().optional(),
  scriptInput: ScriptRequestSchema.partial().optional(),
  settings: ProjectSettingsSchema.partial().optional(),
});

export const SaveTimelineSchema = z.object({
  timeline: TimelineSchema,
  /** Optimistic concurrency: the revision the client last loaded. */
  revision: z.number().int().min(0),
});

export const CredentialsSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  password: z.string().min(8, 'Use at least 8 characters').max(128),
});

export const VoiceRequestSchema = z.object({
  text: z.string().trim().min(1).max(5000),
  voiceId: z.string().max(80),
  speed: z.number().min(0.5).max(2).default(1),
});

export const VoicePreviewSchema = VoiceRequestSchema.extend({ text: z.string().trim().min(1).max(200) });

export const CreateRenderSchema = z.object({
  profile: z.enum(['full', 'preview']).default('full'),
});

export const CaptionStylePatchSchema = CaptionStyleSchema.partial();

export const MediaImportSchema = z.object({
  provider: z.literal('pexels'),
  externalId: z.string().min(1).max(64),
});
