import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ALLOWED_UPLOAD_MIME, type ProjectDetail } from '@clipforge/shared';
import { Mic, Play, Plus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Field, Select } from '@/components/ui/input';
import { EmptyState, Notice, Spinner } from '@/components/ui/misc';
import { api, errorMessage, type MediaAssetWithUrl } from '@/lib/api';
import { qk } from '@/lib/query';
import { useEditorStore } from '../editor-store';
import { addClip, clipForAsset } from '../timeline-ops';
import { MediaItem, UploadDrop } from './MediaPanel';
import { scriptText } from './ScriptPanel';

/** Narration: generate with TTS, preview, or upload a recording. Also used for the Music tab with track="music". */
export function AudioPanel({ project, media, track }: { project: ProjectDetail; media: MediaAssetWithUrl[]; track: 'narration' | 'music' }) {
  const update = useEditorStore((s) => s.update);
  const timeline = useEditorStore((s) => s.timeline);
  const items = media.filter((m) => m.kind === 'audio' && (m.projectId === project.id || track === 'music') && (track === 'music' ? m.source !== 'tts' : true));
  const current = timeline?.clips.find((c) => c.track === track);

  return (
    <div className="space-y-4">
      {track === 'narration' ? <VoiceGenerator project={project} /> : <Notice>Use music you own or have a license for. Music loops under the whole video at 25% volume; change it in the inspector.</Notice>}
      <UploadDrop projectId={project.id} accept={[...ALLOWED_UPLOAD_MIME.audio, '.m4a'].join(',')} label={track === 'narration' ? 'Upload a voice recording' : 'Upload a music track'} />
      {items.length === 0 ? (
        <EmptyState title={track === 'narration' ? 'No voiceovers yet' : 'No music yet'} />
      ) : (
        <div className="space-y-2">
          {items.map((asset) => (
            <MediaItem
              key={asset.id}
              asset={asset}
              actions={
                <Button
                  size="sm"
                  variant={current?.assetId === asset.id ? 'secondary' : 'default'}
                  disabled={asset.status !== 'ready' || current?.assetId === asset.id}
                  aria-label={`Use ${asset.originalName ?? 'audio'} as ${track}`}
                  onClick={() => {
                    update((t) => addClip(t, clipForAsset(t, asset, track)));
                    toast.success(track === 'narration' ? 'Voiceover added' : 'Music added');
                  }}
                >
                  {current?.assetId === asset.id ? 'In use' : <><Plus /> Use</>}
                </Button>
              }
            />
          ))}
        </div>
      )}
    </div>
  );
}

function VoiceGenerator({ project }: { project: ProjectDetail }) {
  const qc = useQueryClient();
  const voices = useQuery({ queryKey: qk.voices, queryFn: api.voices });
  const [voiceId, setVoiceId] = useState(project.settings.voice.voiceId);
  const [speed, setSpeed] = useState(project.settings.voice.speed);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const text = project.script ? scriptText(project.script) : '';

  useEffect(() => {
    const first = voices.data?.voices[0];
    if (first && !voices.data?.voices.some((v) => v.id === voiceId)) setVoiceId(first.id);
  }, [voices.data, voiceId]);
  useEffect(() => () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  const preview = useMutation({
    mutationFn: () => api.previewVoice({ text: (text || 'This is how your narration will sound.').slice(0, 200), voiceId, speed }),
    onSuccess: (blob) => {
      setPreviewUrl(URL.createObjectURL(blob));
      setTimeout(() => void audioRef.current?.play().catch(() => undefined), 50);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const generate = useMutation({
    mutationFn: async () => {
      await api.updateProject(project.id, { settings: { voice: { voiceId, speed } } });
      return api.generateVoiceover(project.id, { voiceId, speed });
    },
    onSuccess: () => {
      toast.success('Generating voiceover. It appears below when ready.');
      void qc.invalidateQueries({ queryKey: qk.media() });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  if (voices.isPending) return <Spinner />;
  if (!voices.data?.configured) {
    return <Notice tone="warning">Voice generation is not configured on this server (TTS_PROVIDER). Upload a recording instead.</Notice>;
  }
  return (
    <section className="space-y-3">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        <Mic className="size-4 text-accent" /> Generate voiceover
      </h3>
      <div className="grid grid-cols-2 gap-2">
        <Field label="Voice" htmlFor="voice-id">
          <Select id="voice-id" value={voiceId} onChange={(e) => setVoiceId(e.target.value)}>
            {voices.data.voices.map((v) => (
              <option key={v.id} value={v.id}>
                {v.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={`Speed ${speed.toFixed(2)}×`} htmlFor="voice-speed">
          <input id="voice-speed" type="range" min={0.5} max={2} step={0.05} value={speed} onChange={(e) => setSpeed(Number(e.target.value))} className="mt-3 w-full" />
        </Field>
      </div>
      {!text ? <Notice>Save a script first; the voiceover reads it aloud.</Notice> : null}
      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={() => preview.mutate()} disabled={preview.isPending}>
          {preview.isPending ? <Spinner /> : <Play />} Preview
        </Button>
        <Button size="sm" className="flex-1" onClick={() => generate.mutate()} disabled={!text || generate.isPending}>
          {generate.isPending ? <Spinner /> : <Mic />} Generate from script
        </Button>
      </div>
      {previewUrl ? <audio ref={audioRef} src={previewUrl} controls className="h-8 w-full" /> : null}
      <p className="text-[11px] text-muted-foreground">Provider: {voices.data.provider}. Generated voice counts toward your monthly voice seconds.</p>
    </section>
  );
}
