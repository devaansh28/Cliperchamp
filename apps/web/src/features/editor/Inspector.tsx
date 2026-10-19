import { moveVideoClip, trimClip, type Timeline } from '@clipforge/shared';
import { ArrowLeft, ArrowRight, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { Badge } from '@/components/ui/misc';
import type { MediaAssetWithUrl } from '@/lib/api';
import { formatMs } from '@/lib/utils';
import { useEditorStore } from './editor-store';
import { patchCaption, patchClip, removeCaption, removeClip } from './timeline-ops';

function NumberField({ label, value, onChange, min, max, step = 100, suffix = 'ms', id }: { label: string; value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number; suffix?: string; id: string }) {
  return (
    <Field label={`${label} (${suffix})`} htmlFor={id}>
      <Input
        id={id}
        type="number"
        value={value}
        min={min}
        max={max}
        step={step}
        onChange={(e) => {
          const v = Number(e.target.value);
          if (Number.isFinite(v)) onChange(v);
        }}
      />
    </Field>
  );
}

export function Inspector({ timeline, byId }: { timeline: Timeline; byId: Map<string, MediaAssetWithUrl> }) {
  const selection = useEditorStore((s) => s.selection);
  const update = useEditorStore((s) => s.update);
  const select = useEditorStore((s) => s.select);

  if (selection?.type === 'clip') {
    const clip = timeline.clips.find((c) => c.id === selection.id);
    if (!clip) return <ProjectInspector timeline={timeline} />;
    const asset = byId.get(clip.assetId);
    const source = asset?.kind === 'image' ? null : (asset?.durationMs ?? null);
    const key = (f: string) => `clip:${clip.id}:${f}`;
    return (
      <div className="space-y-4" data-testid="inspector-clip">
        <div className="flex items-center justify-between gap-2">
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{asset?.originalName ?? 'Clip'}</p>
            <p className="text-xs capitalize text-muted-foreground">
              {clip.track} {source ? `· source ${formatMs(source)}` : ''}
            </p>
          </div>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Delete clip"
            onClick={() => {
              update((t) => removeClip(t, clip.id));
              select(null);
            }}
          >
            <Trash2 />
          </Button>
        </div>
        {clip.track === 'video' ? (
          <div className="flex gap-2">
            <Button size="sm" variant="outline" onClick={() => update((t) => ({ ...t, clips: moveVideoClip(t.clips, clip.id, -1) }))}>
              <ArrowLeft /> Earlier
            </Button>
            <Button size="sm" variant="outline" onClick={() => update((t) => ({ ...t, clips: moveVideoClip(t.clips, clip.id, 1) }))}>
              Later <ArrowRight />
            </Button>
          </div>
        ) : (
          <NumberField id="clip-start" label="Starts at" value={clip.startMs} min={0} onChange={(v) => update((t) => patchClip(t, clip.id, { startMs: Math.max(0, Math.round(v)) }), key('start'))} />
        )}
        <div className="grid grid-cols-2 gap-3">
          <NumberField id="clip-trim" label="Trim start" value={clip.trimStartMs} min={0} onChange={(v) => update((t) => ({ ...t, clips: t.clips.map((c) => (c.id === clip.id ? trimClip(c, { trimStartMs: v }, source) : c)) }), key('trim'))} />
          <NumberField id="clip-duration" label="Duration" value={clip.durationMs} min={100} onChange={(v) => update((t) => ({ ...t, clips: t.clips.map((c) => (c.id === clip.id ? trimClip(c, { durationMs: v }, source) : c)) }), key('duration'))} />
        </div>
        {asset?.kind !== 'image' ? (
          <Field label={`Volume ${Math.round(clip.volume * 100)}%`} htmlFor="clip-volume">
            <input id="clip-volume" type="range" min={0} max={2} step={0.05} value={clip.volume} className="w-full accent-[var(--color-primary)]" onChange={(e) => update((t) => patchClip(t, clip.id, { volume: Number(e.target.value) }), key('volume'))} />
          </Field>
        ) : null}
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={clip.loop} onChange={(e) => update((t) => patchClip(t, clip.id, { loop: e.target.checked }))} /> Loop when shorter than the clip
        </label>
        {clip.track === 'video' ? (
          <div className="grid grid-cols-2 gap-3">
            <Field label="Fit" htmlFor="clip-fit">
              <Select id="clip-fit" value={clip.fit} onChange={(e) => update((t) => patchClip(t, clip.id, { fit: e.target.value as 'cover' | 'contain' }))}>
                <option value="cover">Fill frame</option>
                <option value="contain">Fit inside</option>
              </Select>
            </Field>
            <Field label="Transition in" htmlFor="clip-transition">
              <Select id="clip-transition" value={clip.transition} onChange={(e) => update((t) => patchClip(t, clip.id, { transition: e.target.value as 'none' | 'fade' | 'slide' }))}>
                <option value="none">None</option>
                <option value="fade">Fade</option>
                <option value="slide">Slide</option>
              </Select>
            </Field>
          </div>
        ) : null}
      </div>
    );
  }

  if (selection?.type === 'caption') {
    const cap = timeline.captions.find((c) => c.id === selection.id);
    if (!cap) return <ProjectInspector timeline={timeline} />;
    const key = (f: string) => `caption:${cap.id}:${f}`;
    return (
      <div className="space-y-4" data-testid="inspector-caption">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <p className="text-sm font-medium">Caption</p>
            <Badge variant={cap.timingSource === 'estimated' ? 'warning' : 'secondary'}>{cap.timingSource === 'estimated' ? 'Estimated timing' : cap.timingSource}</Badge>
          </div>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Delete caption"
            onClick={() => {
              update((t) => removeCaption(t, cap.id));
              select(null);
            }}
          >
            <Trash2 />
          </Button>
        </div>
        <Field label="Text" htmlFor="caption-text">
          <Textarea id="caption-text" maxLength={500} value={cap.text} onChange={(e) => e.target.value.trim() && update((t) => patchCaption(t, cap.id, { text: e.target.value }), key('text'))} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <NumberField id="caption-start" label="Start" value={cap.startMs} min={0} onChange={(v) => v < cap.endMs && update((t) => patchCaption(t, cap.id, { startMs: Math.max(0, Math.round(v)) }), key('start'))} />
          <NumberField id="caption-end" label="End" value={cap.endMs} min={cap.startMs + 1} onChange={(v) => v > cap.startMs && update((t) => patchCaption(t, cap.id, { endMs: Math.round(v) }), key('end'))} />
        </div>
      </div>
    );
  }

  return <ProjectInspector timeline={timeline} />;
}

function ProjectInspector({ timeline }: { timeline: Timeline }) {
  const update = useEditorStore((s) => s.update);
  return (
    <div className="space-y-4" data-testid="inspector-project">
      <p className="text-sm font-medium">Video</p>
      <dl className="grid grid-cols-2 gap-y-1 text-xs">
        <dt className="text-muted-foreground">Size</dt>
        <dd>
          {timeline.output.width}×{timeline.output.height}
        </dd>
        <dt className="text-muted-foreground">Frame rate</dt>
        <dd>{timeline.output.fps} fps</dd>
        <dt className="text-muted-foreground">Format</dt>
        <dd>MP4 · H.264 · AAC</dd>
      </dl>
      <Field label="Background color" htmlFor="bg-color">
        <div className="flex items-center gap-2">
          <input id="bg-color" type="color" value={timeline.backgroundColor} onChange={(e) => update((t) => ({ ...t, backgroundColor: e.target.value }), 'bg')} className="h-9 w-12 cursor-pointer rounded border border-border bg-transparent" />
          <span className="font-mono text-xs text-muted-foreground">{timeline.backgroundColor}</span>
        </div>
      </Field>
      <p className="text-xs text-muted-foreground">Select a clip or caption on the timeline to edit it.</p>
    </div>
  );
}
