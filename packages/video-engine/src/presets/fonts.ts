import '@fontsource/inter/400.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/800.css';
import '@fontsource/inter/900.css';
import '@fontsource/montserrat/700.css';
import '@fontsource/montserrat/800.css';
import '@fontsource/montserrat/900.css';
import '@fontsource/bebas-neue/400.css';
import '@fontsource/roboto-mono/700.css';
import type { CaptionStyle } from '@clipforge/shared';

const STACKS: Record<CaptionStyle['fontFamily'], string> = {
  Inter: '"Inter", "DejaVu Sans", sans-serif',
  Montserrat: '"Montserrat", "Inter", sans-serif',
  'Bebas Neue': '"Bebas Neue", "Inter", sans-serif',
  'Roboto Mono': '"Roboto Mono", "DejaVu Sans Mono", monospace',
  'DejaVu Sans': '"DejaVu Sans", sans-serif',
};

export function fontStack(family: CaptionStyle['fontFamily']): string {
  return STACKS[family];
}

/** CSS font shorthand values used to wait for fonts before rendering a frame. */
export function fontLoadQueries(family: CaptionStyle['fontFamily'], weight: number): string[] {
  if (family === 'DejaVu Sans') return [];
  return [`${weight} 48px "${family}"`];
}
