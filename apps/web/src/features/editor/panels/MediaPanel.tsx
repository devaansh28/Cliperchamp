import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ALLOWED_UPLOAD_MIME, type IntegrationStatus, type ProjectDetail } from '@clipforge/shared';
import { AlertTriangle, Film, Image as ImageIcon, Music, Plus, Search, Trash2, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Badge, EmptyState, Notice, Spinner } from '@/components/ui/misc';
import { api, errorMessage, type MediaAssetWithUrl } from '@/lib/api';
import { qk } from '@/lib/query';
import { cn, formatBytes, formatMs } from '@/lib/utils';
import { useEditorStore } from '../editor-store';
import { addClip, clipForAsset } from '../timeline-ops';

const ACCEPT = [...ALLOWED_UPLOAD_MIME.video, ...ALLOWED_UPLOAD_MIME.image, ...ALLOWED_UPLOAD_MIME.audio, '.mkv', '.mov', '.m4a'].join(',');

export function useUpload(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (file: File) => api.uploadMedia(file, projectId),
    onSuccess: (asset) => {
      toast.success(`Uploaded ${asset.originalName ?? 'file'}. Processing…`);
      void qc.invalidateQueries({ queryKey: qk.media() });
      void qc.invalidateQueries({ queryKey: qk.usage });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
}

export function UploadDrop({ projectId, accept = ACCEPT, label = 'Upload video, images or audio' }: { projectId: string; accept?: string; label?: string }) {
  const input = useRef<HTMLInputElement>(null);
  const upload = useUpload(projectId);
  const [over, setOver] = useState(false);
  const send = (files: FileList | null) => {
    for (const f of Array.from(files ?? []).slice(0, 10)) upload.mutate(f);
  };
  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        send(e.dataTransfer.files);
      }}
      className={cn('flex flex-col items-center gap-2 rounded-lg border border-dashed border-border p-4 text-center text-xs text-muted-foreground', over && 'border-primary bg-primary/5')}
    >
      <Upload className="size-5" />
      <span>{label}</span>
      <Button size="sm" variant="outline" onClick={() => input.current?.click()} disabled={upload.isPending}>
        {upload.isPending ? <Spinner /> : null} Choose files
      </Button>
      <input ref={input} type="file" multiple accept={accept} className="hidden" data-testid="media-upload-input" onChange={(e) => { send(e.target.files); e.target.value = ''; }} />
    </div>
  );
}

export function MediaItem({ asset, actions }: { asset: MediaAssetWithUrl; actions: React.ReactNode }) {
  const Icon = asset.kind === 'video' ? Film : asset.kind === 'image' ? ImageIcon : Music;
  return (
    <div className="flex items-center gap-2 rounded-md border border-border p-2" data-testid="media-item" data-status={asset.status}>
      <div className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded bg-muted">
        {asset.status === 'ready' && asset.url && asset.kind === 'image' ? (
          <img src={asset.url} alt="" className="size-full object-cover" />
        ) : asset.status === 'ready' && asset.url && asset.kind === 'video' ? (
          <video src={`${asset.url}#t=0.5`} muted preload="metadata" className="size-full object-cover" />
        ) : (
          <Icon className="size-5 text-muted-foreground" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-xs font-medium" title={asset.originalName ?? undefined}>
          {asset.originalName ?? asset.kind}
        </p>
        <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
          {asset.status === 'pending' ? (
            <>
              <Spinner className="size-3" /> Processing
            </>
          ) : asset.status === 'failed' ? (
            <span className="flex items-center gap-1 text-destructive" title={asset.errorMessage ?? undefined}>
              <AlertTriangle className="size-3" /> {asset.errorMessage ?? 'Failed'}
            </span>
          ) : (
            <>
              {asset.durationMs ? formatMs(asset.durationMs) : `${asset.width ?? '?'}×${asset.height ?? '?'}`} · {formatBytes(asset.sizeBytes)}
              {asset.source === 'tts' ? <Badge variant="secondary">voice</Badge> : null}
              {asset.source === 'stock' ? <Badge variant="secondary">stock</Badge> : null}
            </>
          )}
        </p>
        {asset.attribution ? <p className="truncate text-[10px] text-muted-foreground">{asset.attribution}</p> : null}
      </div>
      <div className="flex shrink-0 gap-1">{actions}</div>
    </div>
  );
}

export function MediaPanel({
  project,
  media,
  integrations,
  kinds = ['video', 'image'],
}: {
  project: ProjectDetail;
  media: MediaAssetWithUrl[];
  integrations: IntegrationStatus | undefined;
  kinds?: ('video' | 'image' | 'audio')[];
}) {
  const qc = useQueryClient();
  const update = useEditorStore((s) => s.update);
  const [scope, setScope] = useState<'project' | 'all'>('project');
  const [deleting, setDeleting] = useState<MediaAssetWithUrl | null>(null);
  const items = media.filter((m) => kinds.includes(m.kind) && (scope === 'all' || m.projectId === project.id));

  const remove = useMutation({
    mutationFn: (id: string) => api.deleteMedia(id),
    onSuccess: () => {
      setDeleting(null);
      toast.success('Media deleted');
      void qc.invalidateQueries({ queryKey: qk.media() });
    },
    onError: (e) => {
      setDeleting(null);
      toast.error(errorMessage(e));
    },
  });

  return (
    <div className="space-y-4">
      <UploadDrop projectId={project.id} />
      <div className="flex gap-1 text-xs">
        {(['project', 'all'] as const).map((s) => (
          <Button key={s} size="sm" variant={scope === s ? 'secondary' : 'ghost'} onClick={() => setScope(s)}>
            {s === 'project' ? 'This project' : 'All my media'}
          </Button>
        ))}
      </div>
      {items.length === 0 ? (
        <EmptyState title="No footage yet" description="Upload clips or images to build your video." />
      ) : (
        <div className="space-y-2">
          {items.map((asset) => (
            <MediaItem
              key={asset.id}
              asset={asset}
              actions={
                <>
                  <Button
                    size="icon-sm"
                    variant="secondary"
                    aria-label={`Add ${asset.originalName ?? 'media'} to timeline`}
                    disabled={asset.status !== 'ready'}
                    onClick={() => {
                      update((t) => addClip(t, clipForAsset(t, asset, 'video')));
                      toast.success('Added to the timeline');
                    }}
                  >
                    <Plus />
                  </Button>
                  <Button size="icon-sm" variant="ghost" aria-label={`Delete ${asset.originalName ?? 'media'}`} onClick={() => setDeleting(asset)}>
                    <Trash2 />
                  </Button>
                </>
              }
            />
          ))}
        </div>
      )}
      <StockSearch project={project} configured={integrations?.media.configured ?? false} />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
        title="Delete media?"
        description={`“${deleting?.originalName ?? 'This file'}” will be removed from your library. Media used in a project cannot be deleted until you remove it from the timeline and save.`}
        confirmLabel="Delete"
        busy={remove.isPending}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
      />
    </div>
  );
}

function StockSearch({ project, configured }: { project: ProjectDetail; configured: boolean }) {
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [submitted, setSubmitted] = useState('');
  const results = useQuery({ queryKey: ['stock', submitted], queryFn: () => api.searchStock(submitted), enabled: configured && submitted.length >= 2 });
  const suggestions = useQuery({ queryKey: ['suggestions', project.id, project.script?.hook], queryFn: () => api.mediaSuggestions(project.id), enabled: configured && Boolean(project.script) });
  const importer = useMutation({
    mutationFn: (externalId: string) => api.importStock(externalId, project.id),
    onSuccess: () => {
      toast.success('Importing stock clip…');
      void qc.invalidateQueries({ queryKey: qk.media() });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <section className="space-y-2 border-t border-border pt-4">
      <h3 className="text-sm font-semibold">Stock footage</h3>
      {!configured ? (
        <Notice>Stock search is off on this server (set MEDIA_PROVIDER=pexels with a free API key). You can upload your own footage instead.</Notice>
      ) : (
        <>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              setSubmitted(q.trim());
            }}
          >
            <Input aria-label="Search stock footage" placeholder="ocean, city at night…" value={q} onChange={(e) => setQ(e.target.value)} />
            <Button type="submit" size="icon" variant="secondary" aria-label="Search">
              <Search />
            </Button>
          </form>
          {suggestions.data?.scenes.length && !submitted ? (
            <div className="flex flex-wrap gap-1">
              {suggestions.data.scenes.map((s) => (
                <Button key={s.index} size="sm" variant="outline" onClick={() => { setQ(s.query); setSubmitted(s.query); }}>
                  {s.query}
                </Button>
              ))}
            </div>
          ) : null}
          {results.isFetching ? <Spinner /> : null}
          {results.isError ? <Notice tone="error">{errorMessage(results.error)}</Notice> : null}
          <div className="grid grid-cols-3 gap-2">
            {results.data?.map((r) => (
              <button key={r.externalId} type="button" className="group relative aspect-[9/16] overflow-hidden rounded bg-muted" onClick={() => importer.mutate(r.externalId)} title={r.attribution} aria-label={`Import stock clip by ${r.attribution}`}>
                <img src={r.previewUrl} alt="" className="size-full object-cover" loading="lazy" />
                <span className="absolute inset-0 flex items-center justify-center bg-black/50 opacity-0 group-hover:opacity-100">
                  <Plus className="size-5" />
                </span>
              </button>
            ))}
          </div>
          {results.data ? <p className="text-[10px] text-muted-foreground">Videos provided by Pexels. Attribution is saved with each import.</p> : null}
        </>
      )}
    </section>
  );
}
