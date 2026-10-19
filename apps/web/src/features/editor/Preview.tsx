import { Player, type PlayerRef } from '@remotion/player';
import { durationInFrames, type ResolvedAsset, type Timeline } from '@clipforge/shared';
import { ShortVideo } from '@clipforge/video-engine';
import { useEffect, useMemo, type RefObject } from 'react';
import { useEditorStore } from './editor-store';

/**
 * Live preview. Uses the exact composition the render worker uses (ShortVideo from
 * @clipforge/video-engine), so captions, trims and transitions look the same in the export.
 */
export function Preview({ timeline, assets, playerRef }: { timeline: Timeline; assets: Record<string, ResolvedAsset>; playerRef: RefObject<PlayerRef | null> }) {
  const setCurrentMs = useEditorStore((s) => s.setCurrentMs);
  const { fps, width, height } = timeline.output;
  const frames = durationInFrames(timeline, fps);
  const inputProps = useMemo(() => ({ timeline, assets }), [timeline, assets]);

  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    const onFrame = (e: { detail: { frame: number } }) => setCurrentMs(Math.round((e.detail.frame / fps) * 1000));
    player.addEventListener('frameupdate', onFrame);
    player.addEventListener('seeked', onFrame);
    return () => {
      player.removeEventListener('frameupdate', onFrame);
      player.removeEventListener('seeked', onFrame);
    };
  }, [playerRef, fps, setCurrentMs]);

  return (
    <div className="flex h-full w-full items-center justify-center" data-testid="preview">
      <div className="h-full max-h-full overflow-hidden rounded-xl border border-border bg-black shadow-2xl" style={{ aspectRatio: `${width} / ${height}` }}>
        <Player
          ref={playerRef}
          component={ShortVideo}
          inputProps={inputProps}
          durationInFrames={frames}
          compositionWidth={width}
          compositionHeight={height}
          fps={fps}
          controls
          showVolumeControls
          allowFullscreen
          clickToPlay
          spaceKeyToPlayOrPause={false}
          bufferStateDelayInMilliseconds={300}
          style={{ width: '100%', height: '100%' }}
          errorFallback={({ error }) => (
            <div className="flex h-full items-center justify-center p-4 text-center text-xs text-destructive">Preview error: {error.message}</div>
          )}
        />
      </div>
    </div>
  );
}
