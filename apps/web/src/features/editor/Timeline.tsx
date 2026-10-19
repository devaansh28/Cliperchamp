import type { PlayerRef } from '@remotion/player';
import { placeClips, timelineDurationMs, type Timeline as TimelineData } from '@clipforge/shared';
import { Captions, Film, Minus, Music, Plus, Mic } from 'lucide-react';
import { useRef, useState, type ReactNode, type RefObject } from 'react';
import { Button } from '@/components/ui/button';
import type { MediaAssetWithUrl } from '@/lib/api';
import { cn, formatMs } from '@/lib/utils';
import { useEditorStore } from './editor-store';
import { patchClip, reorderVideoClip } from './timeline-ops';

const TRACK_LABEL_W = 92;

export function Timeline({
  timeline,
  byId,
  playerRef,
}: {
  timeline: TimelineData;
  byId: Map<string, MediaAssetWithUrl>;
  playerRef: RefObject<PlayerRef | null>;
}) {
  const [pxPerSec, setPxPerSec] = useState(60);
  const selection = useEditorStore((s) => s.selection);
  const select = useEditorStore((s) => s.select);
  const update = useEditorStore((s) => s.update);
  const currentMs = useEditorStore((s) => s.currentMs);
  const [dragId, setDragId] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const total = timelineDurationMs(timeline);
  const width = Math.max(600, (total / 1000) * pxPerSec + 80);
  const placed = placeClips(timeline.clips);
  const x = (ms: number) => (ms / 1000) * pxPerSec;
  const fps = timeline.output.fps;

  const seek = (ms: number) => {
    playerRef.current?.seekTo(Math.max(0, Math.round((ms / 1000) * fps)));
    useEditorStore.getState().setCurrentMs(ms);
  };

  const seekFromEvent = (e: React.MouseEvent<HTMLDivElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    seek(((e.clientX - rect.left) / pxPerSec) * 1000);
  };

  // Drag the right edge of a clip to change its length.
  const startResize = (e: React.PointerEvent, clipId: string, startDuration: number, maxMs: number | null) => {
    e.stopPropagation();
    e.preventDefault();
    const startX = e.clientX;
    const target = e.currentTarget as HTMLElement;
    target.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      let duration = Math.round(startDuration + ((ev.clientX - startX) / pxPerSec) * 1000);
      duration = Math.max(100, maxMs === null ? duration : Math.min(duration, maxMs));
      update((t) => patchClip(t, clipId, { durationMs: duration }), `resize:${clipId}`);
    };
    const up = () => {
      target.removeEventListener('pointermove', move);
      target.removeEventListener('pointerup', up);
    };
    target.addEventListener('pointermove', move);
    target.addEventListener('pointerup', up);
  };

  const ticks: number[] = [];
  const step = pxPerSec >= 80 ? 1 : pxPerSec >= 30 ? 2 : 5;
  for (let s = 0; s <= total / 1000 + step; s += step) ticks.push(s);

  const row = (label: string, icon: ReactNode, children: ReactNode, testId: string) => (
    <div key={testId} className="flex h-12 border-b border-border/60" data-testid={testId}>
      <div className="sticky left-0 z-10 flex shrink-0 items-center gap-1.5 border-r border-border bg-card px-2 text-[11px] text-muted-foreground" style={{ width: TRACK_LABEL_W }}>
        {icon}
        {label}
      </div>
      <div className="relative" style={{ width }} onClick={seekFromEvent}>
        {children}
      </div>
    </div>
  );

  const videoClips = placed.filter((c) => c.track === 'video');

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
        <span>
          {formatMs(currentMs)} / {formatMs(total)}
        </span>
        <div className="flex items-center gap-1">
          <Button size="icon-sm" variant="ghost" aria-label="Zoom out timeline" onClick={() => setPxPerSec((p) => Math.max(15, p / 1.5))}>
            <Minus />
          </Button>
          <Button size="icon-sm" variant="ghost" aria-label="Zoom in timeline" onClick={() => setPxPerSec((p) => Math.min(300, p * 1.5))}>
            <Plus />
          </Button>
        </div>
      </div>
      <div ref={scrollRef} className="relative flex-1 overflow-auto" aria-label="Timeline">
        <div style={{ width: width + TRACK_LABEL_W }} className="relative">
          {/* Ruler */}
          <div className="flex h-6 border-b border-border">
            <div className="sticky left-0 z-10 shrink-0 border-r border-border bg-card" style={{ width: TRACK_LABEL_W }} />
            <div className="relative cursor-pointer" style={{ width }} onClick={seekFromEvent} data-testid="timeline-ruler">
              {ticks.map((s) => (
                <span key={s} className="absolute top-1 text-[10px] text-muted-foreground" style={{ left: x(s * 1000) + 2 }}>
                  {s}s
                </span>
              ))}
            </div>
          </div>

          {row(
            'Video',
            <Film className="size-3.5" />,
            videoClips.length === 0 ? (
              <span className="absolute inset-y-0 left-2 flex items-center text-[11px] text-muted-foreground">Add footage from the Media tab</span>
            ) : (
              videoClips.map((clip, index) => {
                const asset = byId.get(clip.assetId);
                const maxMs = asset?.kind === 'video' && !clip.loop && asset.durationMs ? asset.durationMs - clip.trimStartMs : null;
                const selected = selection?.type === 'clip' && selection.id === clip.id;
                return (
                  <div
                    key={clip.id}
                    role="button"
                    tabIndex={0}
                    aria-label={`Video clip ${index + 1}: ${asset?.originalName ?? 'media'}`}
                    aria-pressed={selected}
                    draggable
                    onDragStart={(e) => {
                      setDragId(clip.id);
                      e.dataTransfer.effectAllowed = 'move';
                    }}
                    onDragEnd={() => setDragId(null)}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={(e) => {
                      e.preventDefault();
                      if (dragId && dragId !== clip.id) update((t) => reorderVideoClip(t, dragId, index));
                      setDragId(null);
                    }}
                    onClick={(e) => {
                      e.stopPropagation();
                      select({ type: 'clip', id: clip.id });
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') select({ type: 'clip', id: clip.id });
                    }}
                    className={cn(
                      'absolute inset-y-1 flex items-center overflow-hidden rounded-md border bg-primary/25 px-2 text-[11px]',
                      selected ? 'border-primary ring-1 ring-primary' : 'border-primary/40',
                      dragId === clip.id && 'opacity-50',
                    )}
                    style={{ left: x(clip.timelineStartMs), width: Math.max(8, x(clip.durationMs) - 2) }}
                  >
                    <span className="truncate">{asset?.originalName ?? 'Clip'}</span>
                    <span
                      aria-hidden
                      className="absolute inset-y-0 right-0 w-2 cursor-ew-resize bg-primary/60 opacity-0 hover:opacity-100"
                      onPointerDown={(e) => startResize(e, clip.id, clip.durationMs, maxMs)}
                    />
                  </div>
                );
              })
            ),
            'track-video',
          )}

          {(['narration', 'music'] as const).map((track) =>
            row(
              track === 'narration' ? 'Voice' : 'Music',
              track === 'narration' ? <Mic className="size-3.5" /> : <Music className="size-3.5" />,
              placed
                .filter((c) => c.track === track)
                .map((clip) => {
                  const asset = byId.get(clip.assetId);
                  const selected = selection?.type === 'clip' && selection.id === clip.id;
                  return (
                    <button
                      key={clip.id}
                      type="button"
                      aria-label={`${track} clip: ${asset?.originalName ?? 'audio'}`}
                      aria-pressed={selected}
                      onClick={(e) => {
                        e.stopPropagation();
                        select({ type: 'clip', id: clip.id });
                      }}
                      className={cn(
                        'absolute inset-y-1 overflow-hidden truncate rounded-md border px-2 text-left text-[11px]',
                        track === 'narration' ? 'bg-success/20' : 'bg-accent/20',
                        selected ? 'border-foreground' : 'border-transparent',
                      )}
                      style={{ left: x(clip.timelineStartMs), width: Math.max(8, x(clip.durationMs) - 2) }}
                    >
                      {asset?.originalName ?? track}
                    </button>
                  );
                }),
              `track-${track}`,
            ),
          )}

          {row(
            'Captions',
            <Captions className="size-3.5" />,
            timeline.captions.map((cap) => {
              const selected = selection?.type === 'caption' && selection.id === cap.id;
              return (
                <button
                  key={cap.id}
                  type="button"
                  aria-label={`Caption: ${cap.text}`}
                  aria-pressed={selected}
                  onClick={(e) => {
                    e.stopPropagation();
                    select({ type: 'caption', id: cap.id });
                    seek(cap.startMs);
                  }}
                  className={cn(
                    'absolute inset-y-1 overflow-hidden truncate rounded-sm border px-1 text-left text-[10px]',
                    cap.timingSource === 'estimated' ? 'border-dashed border-warning/60 bg-warning/10' : 'border-transparent bg-muted',
                    selected && 'border-solid border-foreground',
                  )}
                  style={{ left: x(cap.startMs), width: Math.max(4, x(cap.endMs - cap.startMs) - 1) }}
                  title={cap.timingSource === 'estimated' ? 'Estimated timing' : undefined}
                >
                  {cap.text}
                </button>
              );
            }),
            'track-captions',
          )}

          {/* Playhead */}
          <div className="pointer-events-none absolute inset-y-0 z-20 w-px bg-accent" style={{ left: TRACK_LABEL_W + x(currentMs) }} />
        </div>
      </div>
    </div>
  );
}
