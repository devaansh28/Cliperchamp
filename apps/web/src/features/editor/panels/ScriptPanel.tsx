import { useMutation, useQueryClient } from '@tanstack/react-query';
import { estimateSpeechDurationMs, ScriptRequestSchema, ScriptSchema, type IntegrationStatus, type ProjectDetail, type Script } from '@clipforge/shared';
import { Plus, Sparkles, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Field, Input, Textarea } from '@/components/ui/input';
import { Notice, Spinner } from '@/components/ui/misc';
import { api, ApiError, errorMessage } from '@/lib/api';
import { qk } from '@/lib/query';

const EMPTY_SCRIPT: Script = { hook: '', segments: [{ narration: '', scene: '' }], callToAction: '', estimatedDurationSec: 1 };

export function scriptText(script: Script): string {
  return [script.hook, ...script.segments.map((s) => s.narration), script.callToAction ?? ''].map((s) => s.trim()).filter(Boolean).join(' ');
}

export function ScriptPanel({ project, integrations }: { project: ProjectDetail; integrations: IntegrationStatus | undefined }) {
  const qc = useQueryClient();
  const [draft, setDraft] = useState<Script>(project.script ?? EMPTY_SCRIPT);
  const [dirty, setDirty] = useState(false);
  const [topic, setTopic] = useState(project.scriptInput?.topic ?? '');
  const [audience, setAudience] = useState(project.scriptInput?.audience ?? '');
  const [tone, setTone] = useState(project.scriptInput?.tone ?? 'energetic');
  const [duration, setDuration] = useState(project.scriptInput?.targetDurationSec ?? 45);
  const [language, setLanguage] = useState(project.scriptInput?.language ?? 'English');
  const [genError, setGenError] = useState<string | null>(null);

  useEffect(() => {
    if (!dirty) setDraft(project.script ?? EMPTY_SCRIPT);
  }, [project.script, dirty]);

  const edit = (fn: (s: Script) => Script) => {
    setDraft((s) => fn(s));
    setDirty(true);
  };

  const save = useMutation({
    mutationFn: async () => {
      const text = scriptText(draft);
      const parsed = ScriptSchema.safeParse({
        ...draft,
        segments: draft.segments.filter((s) => s.narration.trim()),
        estimatedDurationSec: Math.max(1, Math.round(estimateSpeechDurationMs(text) / 1000)),
      });
      if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? 'The script is incomplete: add a hook and at least one line of narration.');
      return api.updateProject(project.id, { script: parsed.data });
    },
    onSuccess: () => {
      setDirty(false);
      toast.success('Script saved');
      void qc.invalidateQueries({ queryKey: qk.project(project.id) });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  const generate = useMutation({
    mutationFn: () => {
      const input = ScriptRequestSchema.parse({ topic, audience: audience || undefined, tone, targetDurationSec: duration, language });
      return api.generateScript(project.id, input);
    },
    onSuccess: (script) => {
      setDraft(script);
      setDirty(false);
      setGenError(null);
      toast.success('Script generated. Review and edit it below.');
      void qc.invalidateQueries({ queryKey: qk.project(project.id) });
      void qc.invalidateQueries({ queryKey: qk.usage });
    },
    onError: (e) => setGenError(e instanceof ApiError && e.code === 'integration_not_configured' ? `${e.message} Write the script yourself below in the meantime.` : errorMessage(e)),
  });

  const llmReady = integrations?.llm.configured ?? false;
  const estSec = Math.round(estimateSpeechDurationMs(scriptText(draft)) / 1000);

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <Sparkles className="size-4 text-accent" /> Generate with AI
        </h3>
        {!llmReady ? <Notice tone="warning">AI script writing is not configured on this server. Write your script manually below, or ask an admin to set LLM_PROVIDER.</Notice> : null}
        <Field label="Topic or idea" htmlFor="script-topic">
          <Textarea id="script-topic" rows={2} maxLength={500} placeholder="Why octopuses are smarter than you think" value={topic} onChange={(e) => setTopic(e.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="Audience" htmlFor="script-audience">
            <Input id="script-audience" maxLength={200} placeholder="general audience" value={audience} onChange={(e) => setAudience(e.target.value)} />
          </Field>
          <Field label="Tone" htmlFor="script-tone">
            <Input id="script-tone" maxLength={60} value={tone} onChange={(e) => setTone(e.target.value)} />
          </Field>
          <Field label="Length (seconds)" htmlFor="script-duration">
            <Input id="script-duration" type="number" min={10} max={180} value={duration} onChange={(e) => setDuration(Number(e.target.value) || 45)} />
          </Field>
          <Field label="Language" htmlFor="script-language">
            <Input id="script-language" maxLength={40} value={language} onChange={(e) => setLanguage(e.target.value)} />
          </Field>
        </div>
        {genError ? <Notice tone="error">{genError}</Notice> : null}
        <Button className="w-full" disabled={!llmReady || topic.trim().length < 3 || generate.isPending} onClick={() => generate.mutate()}>
          {generate.isPending ? <Spinner /> : <Sparkles />} {generate.isPending ? 'Writing…' : 'Generate script'}
        </Button>
      </section>

      <section className="space-y-3 border-t border-border pt-4">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">Script</h3>
          <span className="text-xs text-muted-foreground">≈ {estSec}s spoken (estimate)</span>
        </div>
        <Field label="Hook" htmlFor="script-hook">
          <Textarea id="script-hook" rows={2} maxLength={400} value={draft.hook} onChange={(e) => edit((s) => ({ ...s, hook: e.target.value }))} />
        </Field>
        {draft.segments.map((seg, i) => (
          <div key={i} className="space-y-2 rounded-md border border-border p-2">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground">Scene {i + 1}</span>
              <Button size="icon-sm" variant="ghost" aria-label={`Remove scene ${i + 1}`} disabled={draft.segments.length === 1} onClick={() => edit((s) => ({ ...s, segments: s.segments.filter((_, j) => j !== i) }))}>
                <Trash2 />
              </Button>
            </div>
            <Textarea aria-label={`Narration ${i + 1}`} rows={3} maxLength={1200} placeholder="What the voice says" value={seg.narration} onChange={(e) => edit((s) => ({ ...s, segments: s.segments.map((x, j) => (j === i ? { ...x, narration: e.target.value } : x)) }))} />
            <Input aria-label={`Visual ${i + 1}`} maxLength={400} placeholder="What we see (used for footage suggestions)" value={seg.scene} onChange={(e) => edit((s) => ({ ...s, segments: s.segments.map((x, j) => (j === i ? { ...x, scene: e.target.value } : x)) }))} />
          </div>
        ))}
        <Button size="sm" variant="outline" disabled={draft.segments.length >= 30} onClick={() => edit((s) => ({ ...s, segments: [...s.segments, { narration: '', scene: '' }] }))}>
          <Plus /> Add scene
        </Button>
        <Field label="Call to action" htmlFor="script-cta">
          <Input id="script-cta" maxLength={300} value={draft.callToAction ?? ''} onChange={(e) => edit((s) => ({ ...s, callToAction: e.target.value }))} />
        </Field>
        <Button className="w-full" variant={dirty ? 'default' : 'secondary'} disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? <Spinner /> : null} {dirty ? 'Save script' : 'Script saved'}
        </Button>
      </section>
    </div>
  );
}
