import { useMutation } from '@tanstack/react-query';
import { parseSrt, serializeSrt, SrtParseError, type IntegrationStatus, type ProjectDetail } from '@clipforge/shared';
import { Download, Plus, Upload, Wand2 } from 'lucide-react';
import { useRef } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge, EmptyState, Notice, Spinner } from '@/components/ui/misc';
import { api, errorMessage } from '@/lib/api';
import { cn, downloadText, formatMs } from '@/lib/utils';
import { useEditorStore } from '../editor-store';
import { insertCaption, newId, setCaptions } from '../timeline-ops';

export function CaptionsPanel({ project, integrations }: { project: ProjectDetail; integrations: IntegrationStatus | undefined }) {
  const timeline = useEditorStore((s) => s.timeline)!;
  const update = useEditorStore((s) => s.update);
  const select = useEditorStore((s) => s.select);
  const selection = useEditorStore((s) => s.selection);
  const currentMs = useEditorStore((s) => s.currentMs);
  const fileRef = useRef<HTMLInputElement>(null);
  const narration = timeline.clips.find((c) => c.track === 'narration');

  const fromScript = useMutation({
    mutationFn: () => api.captionsFromScript(project.id, { narrationAssetId: narration?.assetId }),
    onSuccess: (res) => {
      const offset = narration?.startMs ?? 0;
      update((t) => setCaptions(t, res.captions.map((c) => ({ ...c, startMs: c.startMs + offset, endMs: c.endMs + offset, words: c.words?.map((w) => ({ ...w, startMs: w.startMs + offset, endMs: w.endMs + offset })) }))));
      toast.success(res.basedOnAudioDuration ? 'Captions spread across your voiceover (estimated timing).' : 'Captions created with estimated timing.');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const align = useMutation({
    mutationFn: () => api.alignCaptions(project.id, { narrationAssetId: narration!.assetId }),
    onSuccess: (res) => {
      const offset = narration?.startMs ?? 0;
      update((t) => setCaptions(t, res.captions.map((c) => ({ ...c, startMs: c.startMs + offset, endMs: c.endMs + offset, words: c.words?.map((w) => ({ ...w, startMs: w.startMs + offset, endMs: w.endMs + offset })) }))));
      toast.success('Captions aligned to the voiceover.');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const importSrt = async (file: File) => {
    try {
      if (file.size > 1_000_000) throw new SrtParseError('That subtitle file is too large (1 MB max).', 0);
      const captions = parseSrt(await file.text(), newId);
      if (captions.length === 0) throw new SrtParseError('No captions found in that file.', 0);
      update((t) => setCaptions(t, captions));
      toast.success(`Imported ${captions.length} captions`);
    } catch (err) {
      toast.error(err instanceof SrtParseError ? err.message : 'Could not read that subtitle file.');
    }
  };

  const estimated = timeline.captions.some((c) => c.timingSource === 'estimated');

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-2">
        <Button size="sm" onClick={() => fromScript.mutate()} disabled={!project.script || fromScript.isPending}>
          {fromScript.isPending ? <Spinner /> : <Wand2 />} From script
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={() => align.mutate()}
          disabled={!narration || !integrations?.alignment.configured || align.isPending}
          title={!integrations?.alignment.configured ? 'Set ALIGNMENT_PROVIDER on the server to enable word-accurate timing' : !narration ? 'Add a voiceover first' : undefined}
        >
          {align.isPending ? <Spinner /> : null} Align to voice
        </Button>
        <Button size="sm" variant="outline" onClick={() => fileRef.current?.click()}>
          <Upload /> Import SRT
        </Button>
        <Button size="sm" variant="outline" disabled={timeline.captions.length === 0} onClick={() => downloadText(`${project.name.replace(/[^\w-]+/gu, '_')}.srt`, serializeSrt(timeline.captions), 'application/x-subrip')}>
          <Download /> Export SRT
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept=".srt,text/plain,application/x-subrip"
          className="hidden"
          data-testid="srt-input"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void importSrt(f);
            e.target.value = '';
          }}
        />
      </div>
      {!project.script ? <Notice>Save a script to create captions from it, or import an SRT file.</Notice> : null}
      {estimated ? (
        <Notice tone="warning">
          Some captions use <strong>estimated</strong> timing (spread by word count, not measured from audio). Adjust them on the timeline, or align to the voice when available.
        </Notice>
      ) : null}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">{timeline.captions.length} captions</h3>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            let id = '';
            update((t) => {
              const r = insertCaption(t, currentMs);
              id = r.id;
              return r.timeline;
            });
            if (id) select({ type: 'caption', id });
          }}
        >
          <Plus /> Add at playhead
        </Button>
      </div>
      {timeline.captions.length === 0 ? (
        <EmptyState title="No captions" description="Generate them from your script or import an SRT file." />
      ) : (
        <ol className="space-y-1">
          {timeline.captions.map((c) => (
            <li key={c.id}>
              <button
                type="button"
                onClick={() => select({ type: 'caption', id: c.id })}
                className={cn('w-full rounded-md border border-transparent px-2 py-1.5 text-left text-xs hover:bg-muted', selection?.id === c.id && 'border-primary bg-muted')}
              >
                <span className="mr-2 font-mono text-[10px] text-muted-foreground">
                  {formatMs(c.startMs)}–{formatMs(c.endMs)}
                </span>
                {c.timingSource === 'estimated' ? <Badge variant="warning" className="mr-1">est.</Badge> : null}
                {c.text}
              </button>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}
