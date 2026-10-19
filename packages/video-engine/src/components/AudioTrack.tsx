import React from 'react';
import { Audio, Sequence, useVideoConfig } from 'remotion';
import { msToFrames, type Clip, type ResolvedAsset } from '@clipforge/shared';

interface Props {
  clips: Clip[];
  assets: Record<string, ResolvedAsset>;
}

/** Narration and music live on separate tracks; Remotion mixes them into the output audio stream. */
export const AudioTrack: React.FC<Props> = ({ clips, assets }) => {
  const { fps } = useVideoConfig();
  return (
    <>
      {clips
        .filter((c) => c.track === 'narration' || c.track === 'music')
        .map((clip) => {
          const asset = assets[clip.assetId];
          if (!asset || asset.kind !== 'audio') return null;
          return (
            <Sequence
              key={clip.id}
              from={msToFrames(clip.startMs, fps)}
              durationInFrames={Math.max(1, msToFrames(clip.durationMs, fps))}
              name={`${clip.track}:${clip.id.slice(0, 8)}`}
              layout="none"
            >
              <Audio
                src={asset.src}
                trimBefore={msToFrames(clip.trimStartMs, fps)}
                volume={clip.volume}
                loop={clip.loop}
                pauseWhenBuffering
              />
            </Sequence>
          );
        })}
    </>
  );
};
