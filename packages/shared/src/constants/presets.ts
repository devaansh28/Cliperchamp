import type { CaptionStyle } from '../schemas/timeline.js';

export interface CaptionPreset {
  id: string;
  label: string;
  style: Partial<CaptionStyle>;
}

/** Original ClipForge caption presets. */
export const CAPTION_PRESETS: CaptionPreset[] = [
  { id: 'bold-pop', label: 'Bold Pop', style: { fontFamily: 'Inter', fontWeight: 900, textColor: '#ffffff', highlightColor: '#ffd400', strokeWidth: 8, animation: 'karaoke', uppercase: true } },
  { id: 'forge', label: 'Forge', style: { fontFamily: 'Montserrat', fontWeight: 800, textColor: '#ffffff', highlightColor: '#ff6a2b', strokeWidth: 6, animation: 'pop', uppercase: true } },
  { id: 'clean', label: 'Clean', style: { fontFamily: 'Inter', fontWeight: 600, textColor: '#ffffff', highlightColor: '#8b5cf6', strokeWidth: 0, shadow: true, animation: 'fade', uppercase: false, fontSize: 60 } },
  { id: 'headline', label: 'Headline', style: { fontFamily: 'Bebas Neue', fontWeight: 400, textColor: '#fefce8', highlightColor: '#22c55e', strokeWidth: 5, animation: 'pop', uppercase: true, fontSize: 96 } },
  { id: 'terminal', label: 'Terminal', style: { fontFamily: 'Roboto Mono', fontWeight: 700, textColor: '#a7f3d0', highlightColor: '#ffffff', strokeWidth: 4, animation: 'karaoke', uppercase: false, fontSize: 56 } },
];

export interface VideoTemplate {
  id: string;
  label: string;
  description: string;
  captionPreset: string;
}

export const VIDEO_TEMPLATES: VideoTemplate[] = [
  { id: 'story', label: 'Story narration', description: 'Voiced story over looping background footage.', captionPreset: 'bold-pop' },
  { id: 'explainer', label: 'Quick explainer', description: 'Hook, three points and a call to action.', captionPreset: 'forge' },
  { id: 'quote', label: 'Quote card', description: 'Calm captions over a still image.', captionPreset: 'clean' },
];
