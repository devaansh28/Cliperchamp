import type { PlayerRef } from '@remotion/player';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, Captions, Check, CloudOff, Film, FileText, Mic, Music, Palette, Redo2, Undo2 } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Notice, Spinner } from '@/components/ui/misc';
import { TabList } from '@/components/ui/tabs';
import { useEditorStore, type SaveState } from '@/features/editor/editor-store';
import { Inspector } from '@/features/editor/Inspector';
import { CaptionsPanel } from '@/features/editor/panels/CaptionsPanel';
import { MediaPanel } from '@/features/editor/panels/MediaPanel';
import { ScriptPanel } from '@/features/editor/panels/ScriptPanel';
import { StylePanel } from '@/features/editor/panels/StylePanel';
import { AudioPanel } from '@/features/editor/panels/VoicePanel';
import { Preview } from '@/features/editor/Preview';
import { RenderPanel } from '@/features/editor/RenderPanel';
import { Timeline } from '@/features/editor/Timeline';
import { useAutosave, useEditorShortcuts } from '@/features/editor/use-autosave';
import { useMediaLibrary } from '@/features/editor/use-media';
import { api, errorMessage } from '@/lib/api';
import { qk } from '@/lib/query';

type LeftTab = 'script' | 'media' | 'voice' | 'captions' | 'music' | 'style';
const LEFT_TABS = [
  { id: 'script' as const, label: 'Script', icon: <FileText /> },
  { id: 'media' as const, label: 'Media', icon: <Film /> },
  { id: 'voice' as const, label: 'Voice', icon: <Mic /> },
  { id: 'captions' as const, label: 'Captions', icon: <Captions /> },
  { id: 'music' as const, label: 'Music', icon: <Music /> },
  { id: 'style' as const, label: 'Style', icon: <Palette /> },
];

function SaveIndicator({ state, error, onRetry }: { state: SaveState; error: string | null; onRetry: () => void }) {
  if (state === 'saving') return <span className="flex items-center gap-1.5 text-xs text-muted-foreground" role="status"><Spinner className="size-3" /> Saving…</span>;
  if (state === 'unsaved') return <span className="text-xs text-muted-foreground" role="status">Unsaved changes</span>;
  if (state === 'error')
    return (
      <button type="button" className="flex items-center gap-1.5 text-xs text-destructive" onClick={onRetry} title={error ?? undefined} role="status">
        <CloudOff className="size-3.5" /> Not saved · retry
      </button>
    );
  if (state === 'conflict') return <span className="text-xs text-destructive" role="status">Changed elsewhere · reload</span>;
  return <span className="flex items-center gap-1.5 text-xs text-muted-foreground" role="status" data-testid="save-state-saved"><Check className="size-3.5" /> Saved</span>;
}

export default function EditorPage() {
  const { projectId = '' } = useParams();
  const qc = useQueryClient();
  const playerRef = useRef<PlayerRef>(null);
  const [left, setLeft] = useState<LeftTab>('script');
  const [right, setRight] = useState<'inspect' | 'export'>('inspect');

  const project = useQuery({ queryKey: qk.project(projectId), queryFn: () => api.getProject(projectId), enabled: Boolean(projectId) });
  const integrations = useQuery({ queryKey: qk.integrations, queryFn: api.integrations });
  const library = useMediaLibrary();

  const store = useEditorStore();
  const { timeline, saveState, saveError, past, future } = store;
  const loadedFor = useRef<string | null>(null);

  // Load the timeline into the editor once per project; later refetches must not clobber local edits.
  useEffect(() => {
    if (project.data && loadedFor.current !== project.data.id) {
      loadedFor.current = project.data.id;
      useEditorStore.getState().load(project.data.id, project.data.timeline, project.data.revision);
    }
  }, [project.data]);

  // Save any pending edits when leaving the editor.
  useEffect(
    () => () => {
      void useEditorStore.getState().save();
    },
    [],
  );

  useAutosave();
  const togglePlay = useCallback(() => playerRef.current?.toggle(), []);
  useEditorShortcuts(togglePlay);

  const [name, setName] = useState('');
  useEffect(() => {
    if (project.data) setName(project.data.name);
  }, [project.data]);
  const rename = useMutation({
    mutationFn: (n: string) => api.updateProject(projectId, { name: n }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: qk.project(projectId) });
      void qc.invalidateQueries({ queryKey: qk.allProjects });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  if (project.isError) {
    return (
      <div className="flex min-h-screen flex-col items-center justify-center gap-4">
        <Notice tone="error">{errorMessage(project.error)}</Notice>
        <Button asChild variant="outline">
          <Link to="/app/projects">Back to projects</Link>
        </Button>
      </div>
    );
  }
  if (!project.data || !timeline || store.projectId !== projectId) {
    return (
      <div className="flex min-h-screen items-center justify-center gap-2 text-sm text-muted-foreground">
        <Spinner /> Loading project…
      </div>
    );
  }

  const p = project.data;
  return (
    <div className="flex h-screen flex-col overflow-hidden">
      {/* Top bar */}
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-border px-3">
        <Button asChild size="icon-sm" variant="ghost" aria-label="Back to projects">
          <Link to="/app/projects">
            <ArrowLeft />
          </Link>
        </Button>
        <Input
          aria-label="Project name"
          className="h-8 max-w-64 border-transparent bg-transparent font-medium hover:border-border"
          value={name}
          maxLength={120}
          onChange={(e) => setName(e.target.value)}
          onBlur={() => name.trim() && name.trim() !== p.name && rename.mutate(name.trim())}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
        <SaveIndicator state={saveState} error={saveError} onRetry={() => void store.save()} />
        <div className="ml-auto flex items-center gap-1">
          <Button size="icon-sm" variant="ghost" aria-label="Undo" title="Undo (Ctrl+Z)" disabled={past.length === 0} onClick={store.undo}>
            <Undo2 />
          </Button>
          <Button size="icon-sm" variant="ghost" aria-label="Redo" title="Redo (Ctrl+Shift+Z)" disabled={future.length === 0} onClick={store.redo}>
            <Redo2 />
          </Button>
          <Button size="sm" variant="accent" className="ml-2" onClick={() => setRight('export')}>
            <Film /> Export
          </Button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* Left: tools */}
        <aside className="flex w-[360px] shrink-0 border-r border-border" aria-label="Tools">
          <TabList label="Editor tools" orientation="vertical" tabs={LEFT_TABS} value={left} onChange={setLeft} className="w-[72px] shrink-0 border-r border-border p-1.5" />
          <div role="tabpanel" id={`panel-${left}`} aria-labelledby={`tab-${left}`} className="min-w-0 flex-1 overflow-y-auto p-4">
            {left === 'script' ? <ScriptPanel project={p} integrations={integrations.data} /> : null}
            {left === 'media' ? <MediaPanel project={p} media={library.media} integrations={integrations.data} /> : null}
            {left === 'voice' ? <AudioPanel project={p} media={library.media} track="narration" /> : null}
            {left === 'captions' ? <CaptionsPanel project={p} integrations={integrations.data} /> : null}
            {left === 'music' ? <AudioPanel project={p} media={library.media} track="music" /> : null}
            {left === 'style' ? <StylePanel /> : null}
          </div>
        </aside>

        {/* Center: preview + timeline */}
        <main className="flex min-w-0 flex-1 flex-col">
          <div className="min-h-0 flex-1 bg-[radial-gradient(circle_at_center,#18181b,#09090b)] p-4">
            <Preview timeline={timeline} assets={library.assets} playerRef={playerRef} />
          </div>
          <div className="h-[268px] shrink-0 border-t border-border bg-card/40">
            <Timeline timeline={timeline} byId={library.byId} playerRef={playerRef} />
          </div>
        </main>

        {/* Right: inspector / export */}
        <aside className="flex w-[300px] shrink-0 flex-col border-l border-border" aria-label="Properties">
          <TabList
            label="Properties"
            tabs={[
              { id: 'inspect' as const, label: 'Inspector' },
              { id: 'export' as const, label: 'Export' },
            ]}
            value={right}
            onChange={setRight}
            className="border-b border-border p-1.5"
          />
          <div role="tabpanel" className="min-h-0 flex-1 overflow-y-auto p-4">
            {right === 'inspect' ? <Inspector timeline={timeline} byId={library.byId} /> : <RenderPanel projectId={p.id} />}
          </div>
        </aside>
      </div>
    </div>
  );
}
