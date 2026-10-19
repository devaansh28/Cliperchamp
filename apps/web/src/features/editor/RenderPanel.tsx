import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { RenderJob } from '@clipforge/shared';
import { CheckCircle2, Download, Film, RotateCcw, XCircle } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Badge, Notice, Progress, Spinner } from '@/components/ui/misc';
import { api, errorMessage } from '@/lib/api';
import { qk } from '@/lib/query';
import { formatBytes, formatMs, relativeTime } from '@/lib/utils';
import { useEditorStore } from './editor-store';

const ACTIVE = new Set(['queued', 'processing']);

const STATUS_LABEL: Record<RenderJob['status'], string> = {
  queued: 'Waiting for a renderer',
  processing: 'Rendering',
  completed: 'Ready',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

export function RenderPanel({ projectId }: { projectId: string }) {
  const qc = useQueryClient();
  const save = useEditorStore((s) => s.save);
  const saveState = useEditorStore((s) => s.saveState);
  const [profile, setProfile] = useState<'full' | 'preview'>('full');

  const renders = useQuery({
    queryKey: qk.renders(projectId),
    queryFn: () => api.listRenders(projectId),
    refetchInterval: (q) => (q.state.data?.some((r) => ACTIVE.has(r.status)) ? 1500 : false),
  });
  const latest = renders.data?.[0];
  const active = renders.data?.find((r) => ACTIVE.has(r.status));

  const start = useMutation({
    mutationFn: async () => {
      // Render exactly what is on screen: flush pending edits first.
      const ok = await save();
      if (!ok) throw new Error(useEditorStore.getState().saveError ?? 'Save your changes before exporting.');
      return api.createRender(projectId, profile, crypto.randomUUID());
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.renders(projectId) });
      void qc.invalidateQueries({ queryKey: qk.usage });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const cancel = useMutation({
    mutationFn: (id: string) => api.cancelRender(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.renders(projectId) }),
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <div className="space-y-4" data-testid="render-panel">
      {active ? (
        <ActiveRender job={active} onCancel={() => cancel.mutate(active.id)} cancelling={cancel.isPending} />
      ) : (
        <div className="space-y-3">
          <fieldset className="grid grid-cols-2 gap-2">
            <legend className="sr-only">Quality</legend>
            {(
              [
                ['full', 'Full HD', '1080×1920 · final'],
                ['preview', 'Draft', '540×960 · faster'],
              ] as const
            ).map(([id, label, hint]) => (
              <label key={id} className={`cursor-pointer rounded-md border p-2 text-xs ${profile === id ? 'border-primary bg-primary/10' : 'border-border'}`}>
                <input type="radio" className="sr-only" name="profile" checked={profile === id} onChange={() => setProfile(id)} />
                <span className="block font-medium">{label}</span>
                <span className="text-muted-foreground">{hint}</span>
              </label>
            ))}
          </fieldset>
          {saveState === 'conflict' ? <Notice tone="error">Reload the page before exporting; this project changed elsewhere.</Notice> : null}
          <Button className="w-full" size="lg" onClick={() => start.mutate()} disabled={start.isPending || saveState === 'conflict'}>
            {start.isPending ? <Spinner /> : <Film />} Export MP4
          </Button>
        </div>
      )}

      {latest && !ACTIVE.has(latest.status) ? <FinishedRender job={latest} /> : null}

      {renders.data && renders.data.length > 1 ? (
        <section className="space-y-1 border-t border-border pt-3">
          <h4 className="text-xs font-medium text-muted-foreground">History</h4>
          {renders.data.slice(1, 8).map((r) => (
            <div key={r.id} className="flex items-center justify-between text-xs">
              <span>
                {relativeTime(r.createdAt)} · {r.profile === 'full' ? '1080p' : 'draft'}
              </span>
              <span className="flex items-center gap-2">
                <StatusBadge status={r.status} />
                {r.status === 'completed' ? <DownloadButton id={r.id} size="icon-sm" /> : null}
              </span>
            </div>
          ))}
        </section>
      ) : null}
    </div>
  );
}

function StatusBadge({ status }: { status: RenderJob['status'] }) {
  const variant = status === 'completed' ? 'success' : status === 'failed' ? 'destructive' : status === 'cancelled' ? 'secondary' : 'default';
  return <Badge variant={variant}>{STATUS_LABEL[status]}</Badge>;
}

function ActiveRender({ job, onCancel, cancelling }: { job: RenderJob; onCancel: () => void; cancelling: boolean }) {
  return (
    <div className="space-y-3 rounded-md border border-border p-3" data-testid="render-active" data-status={job.status}>
      <div className="flex items-center justify-between">
        <StatusBadge status={job.status} />
        <span className="text-xs text-muted-foreground">{job.status === 'processing' && job.progress !== null ? `${Math.round(job.progress * 100)}%` : ''}</span>
      </div>
      {/* Real progress from the renderer when available, otherwise an indeterminate bar. */}
      <Progress label="Render progress" value={job.status === 'processing' ? job.progress : null} />
      <p className="text-xs text-muted-foreground">
        {job.status === 'queued' ? 'Your export is in line. It starts as soon as a renderer is free.' : `Attempt ${job.attempt}. You can keep editing; changes made now are not part of this export.`}
      </p>
      <Button size="sm" variant="outline" onClick={onCancel} disabled={cancelling}>
        Cancel export
      </Button>
    </div>
  );
}

function FinishedRender({ job }: { job: RenderJob }) {
  const playback = useQuery({ queryKey: ['playback', job.id], queryFn: () => api.renderPlayback(job.id), enabled: job.status === 'completed', staleTime: 5 * 60_000 });
  if (job.status === 'completed') {
    return (
      <div className="space-y-2 rounded-md border border-success/40 p-3" data-testid="render-completed">
        <p className="flex items-center gap-2 text-sm font-medium text-success">
          <CheckCircle2 className="size-4" /> Export ready
        </p>
        {playback.data ? <video src={playback.data.url} controls playsInline className="aspect-[9/16] max-h-72 w-full rounded bg-black" data-testid="render-video" /> : <Spinner />}
        <p className="text-xs text-muted-foreground">
          {job.outputDurationMs ? formatMs(job.outputDurationMs) : ''} · {job.outputSizeBytes ? formatBytes(job.outputSizeBytes) : ''} · MP4 H.264/AAC
        </p>
        <DownloadButton id={job.id} />
      </div>
    );
  }
  if (job.status === 'failed') {
    return (
      <Notice tone="error">
        <span className="flex items-center gap-1 font-medium">
          <XCircle className="size-3.5" /> Export failed
        </span>
        {job.errorMessage ?? 'Something went wrong.'} <span className="inline-flex items-center gap-1"><RotateCcw className="size-3" /> Fix the issue and export again.</span>
      </Notice>
    );
  }
  return <Notice>Last export was cancelled.</Notice>;
}

function DownloadButton({ id, size }: { id: string; size?: 'icon-sm' }) {
  const download = useMutation({
    mutationFn: () => api.renderDownload(id),
    onSuccess: ({ url }) => {
      const a = document.createElement('a');
      a.href = url;
      a.rel = 'noopener';
      a.click();
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  return (
    <Button size={size ?? 'sm'} variant={size ? 'ghost' : 'default'} className={size ? '' : 'w-full'} aria-label="Download MP4" onClick={() => download.mutate()} disabled={download.isPending}>
      <Download /> {size ? null : 'Download MP4'}
    </Button>
  );
}
