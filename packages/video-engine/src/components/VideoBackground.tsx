import React from 'react';
import { AbsoluteFill, Img, interpolate, Loop, OffthreadVideo, Sequence, useCurrentFrame, useVideoConfig } from 'remotion';
import { msToFrames, placeClips, type Clip, type ResolvedAsset } from '@clipforge/shared';

interface Props {
  clips: Clip[];
  assets: Record<string, ResolvedAsset>;
}

const TransitionWrap: React.FC<{ clip: Clip; durationInFrames: number; children: React.ReactNode }> = ({
  clip,
  durationInFrames,
  children,
}) => {
  const frame = useCurrentFrame();
  const { fps, width } = useVideoConfig();
  const t = Math.max(1, Math.min(msToFrames(clip.transitionMs, fps), Math.floor(durationInFrames / 2)));
  let opacity = 1;
  let translateX = 0;
  if (clip.transition === 'fade') {
    opacity = interpolate(frame, [0, t, durationInFrames - t, durationInFrames], [0, 1, 1, 0], {
      extrapolateLeft: 'clamp',
      extrapolateRight: 'clamp',
    });
  } else if (clip.transition === 'slide') {
    translateX = interpolate(frame, [0, t], [width, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  }
  return <AbsoluteFill style={{ opacity, transform: `translateX(${translateX}px)` }}>{children}</AbsoluteFill>;
};

const ClipMedia: React.FC<{ clip: Clip; asset: ResolvedAsset; durationInFrames: number }> = ({
  clip,
  asset,
  durationInFrames,
}) => {
  const { fps } = useVideoConfig();
  const style: React.CSSProperties = { width: '100%', height: '100%', objectFit: clip.fit };
  if (asset.kind === 'image') return <Img src={asset.src} style={style} />;

  const trimFrames = msToFrames(clip.trimStartMs, fps);
  const video = (
    <OffthreadVideo
      src={asset.src}
      trimBefore={trimFrames}
      volume={clip.volume}
      style={style}
      pauseWhenBuffering
    />
  );
  const sourceFrames = asset.durationMs ? msToFrames(asset.durationMs - clip.trimStartMs, fps) : null;
  if (clip.loop && sourceFrames && sourceFrames > 0 && sourceFrames < durationInFrames) {
    return <Loop durationInFrames={sourceFrames}>{video}</Loop>;
  }
  return video;
};

export const VideoBackground: React.FC<Props> = ({ clips, assets }) => {
  const { fps } = useVideoConfig();
  const video = placeClips(clips).filter((c) => c.track === 'video');
  return (
    <AbsoluteFill>
      {video.map((clip) => {
        const asset = assets[clip.assetId];
        if (!asset) return null;
        const from = msToFrames(clip.timelineStartMs, fps);
        const durationInFrames = Math.max(1, msToFrames(clip.durationMs, fps));
        return (
          <Sequence key={clip.id} from={from} durationInFrames={durationInFrames} name={`video:${clip.id.slice(0, 8)}`}>
            <TransitionWrap clip={clip} durationInFrames={durationInFrames}>
              <ClipMedia clip={clip} asset={asset} durationInFrames={durationInFrames} />
            </TransitionWrap>
          </Sequence>
        );
      })}
    </AbsoluteFill>
  );
};
