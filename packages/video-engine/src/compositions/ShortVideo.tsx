import React, { useEffect, useState } from 'react';
import { AbsoluteFill, continueRender, delayRender } from 'remotion';
import type { CompositionInput } from '@clipforge/shared';
import { AudioTrack } from '../components/AudioTrack.js';
import { CaptionOverlay } from '../components/CaptionOverlay.js';
import { VideoBackground } from '../components/VideoBackground.js';
import { fontLoadQueries } from '../presets/fonts.js';

export type ShortVideoProps = CompositionInput;

/** Waits for the caption font so the first rendered frames use the right typeface. */
function useCaptionFont(family: CompositionInput['timeline']['captionStyle']['fontFamily'], weight: number) {
  const [handle] = useState(() => delayRender(`font:${family}`, { timeoutInMilliseconds: 15000 }));
  useEffect(() => {
    const queries = fontLoadQueries(family, weight);
    const fonts = typeof document !== 'undefined' ? document.fonts : undefined;
    if (!fonts || queries.length === 0) {
      continueRender(handle);
      return;
    }
    Promise.all(queries.map((q) => fonts.load(q)))
      .catch(() => undefined)
      .finally(() => continueRender(handle));
  }, [family, weight, handle]);
}

export const ShortVideo: React.FC<ShortVideoProps> = ({ timeline, assets }) => {
  useCaptionFont(timeline.captionStyle.fontFamily, timeline.captionStyle.fontWeight);
  return (
    <AbsoluteFill style={{ backgroundColor: timeline.backgroundColor }}>
      <VideoBackground clips={timeline.clips} assets={assets} />
      <AudioTrack clips={timeline.clips} assets={assets} />
      <CaptionOverlay captions={timeline.captions} style={timeline.captionStyle} />
    </AbsoluteFill>
  );
};
