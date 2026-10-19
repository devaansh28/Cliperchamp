import React from 'react';
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import {
  activeCaptionAt,
  isKeyword,
  wordsForSegment,
  wrapCaptionLines,
  type CaptionSegment,
  type CaptionStyle,
} from '@clipforge/shared';
import { fontStack } from '../presets/fonts.js';

interface Props {
  captions: CaptionSegment[];
  style: CaptionStyle;
}

const POSITION_TOP_PCT: Record<CaptionStyle['position'], number> = { top: 18, center: 50, bottom: 78 };

/** Renders the caption active at the current frame. Same code runs in the editor preview and the renderer. */
export const CaptionOverlay: React.FC<Props> = ({ captions, style }) => {
  const frame = useCurrentFrame();
  const { fps, width } = useVideoConfig();
  const ms = (frame / fps) * 1000;
  const segment = activeCaptionAt(captions, ms);
  if (!segment) return null;

  const scale = width / 1080;
  const fontSize = style.fontSize * scale;
  const { words } = wordsForSegment(segment);
  const lines = wrapCaptionLines(segment.text, style.maxCharsPerLine);

  const segStartFrame = Math.round((segment.startMs / 1000) * fps);
  const local = frame - segStartFrame;
  const pop = style.animation === 'pop' ? spring({ frame: local, fps, config: { damping: 12, stiffness: 180 }, durationInFrames: 10 }) : 1;
  const opacity = style.animation === 'fade' ? interpolate(local, [0, 6], [0, 1], { extrapolateRight: 'clamp' }) : 1;
  const popScale = style.animation === 'pop' ? interpolate(pop, [0, 1], [0.7, 1]) : 1;

  const shadow = style.shadow ? `0 ${4 * scale}px ${12 * scale}px rgba(0,0,0,0.65)` : 'none';
  const stroke = style.strokeWidth > 0 ? `${style.strokeWidth * scale}px ${style.strokeColor}` : undefined;

  let wordIndex = 0;
  const top = POSITION_TOP_PCT[style.position] + style.offsetY;

  return (
    <AbsoluteFill style={{ pointerEvents: 'none' }}>
      <div
        data-testid="caption"
        style={{
          position: 'absolute',
          left: '6%',
          right: '6%',
          top: `${top}%`,
          transform: `translateY(-50%) scale(${popScale})`,
          opacity,
          textAlign: 'center',
          fontFamily: fontStack(style.fontFamily),
          fontWeight: style.fontWeight,
          fontSize,
          lineHeight: 1.15,
          color: style.textColor,
          WebkitTextStroke: stroke,
          paintOrder: 'stroke fill',
          textShadow: shadow,
          textTransform: style.uppercase ? 'uppercase' : 'none',
        }}
      >
        {lines.map((line, li) => (
          <div key={li}>
            {line.split(' ').map((w, wi) => {
              const timing = words[wordIndex];
              wordIndex += 1;
              const spoken = timing ? ms >= timing.startMs && ms < timing.endMs : false;
              const highlighted =
                isKeyword(w, style.highlightKeywords) || (style.animation === 'karaoke' && spoken);
              return (
                <span key={wi} style={{ color: highlighted ? style.highlightColor : undefined }}>
                  {w}
                  {wi < line.split(' ').length - 1 ? ' ' : ''}
                </span>
              );
            })}
          </div>
        ))}
      </div>
    </AbsoluteFill>
  );
};
