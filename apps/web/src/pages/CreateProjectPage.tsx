import { useMutation, useQueryClient } from '@tanstack/react-query';
import { VIDEO_TEMPLATES } from '@clipforge/shared';
import { Check } from 'lucide-react';
import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';
import { Spinner } from '@/components/ui/misc';
import { api, errorMessage } from '@/lib/api';
import { qk } from '@/lib/query';
import { cn } from '@/lib/utils';

export function CreateProjectPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const initial = VIDEO_TEMPLATES.some((t) => t.id === params.get('template')) ? params.get('template')! : 'story';
  const [template, setTemplate] = useState(initial);
  const [name, setName] = useState('');

  const create = useMutation({
    mutationFn: () => api.createProject(name.trim() || 'Untitled video', template),
    onSuccess: (p) => {
      void qc.invalidateQueries({ queryKey: qk.allProjects });
      navigate(`/app/projects/${p.id}/edit`);
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold">New video</h1>
        <p className="text-sm text-muted-foreground">Choose a starting point. You can change everything in the editor.</p>
      </div>
      <form
        className="space-y-6"
        onSubmit={(e) => {
          e.preventDefault();
          create.mutate();
        }}
      >
        <Field label="Project name" htmlFor="project-name">
          <Input id="project-name" placeholder="Untitled video" maxLength={120} value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Field>
        <fieldset className="space-y-2">
          <legend className="mb-2 text-xs font-medium text-muted-foreground">Template</legend>
          <div className="grid gap-3 sm:grid-cols-3">
            {VIDEO_TEMPLATES.map((t) => (
              <label
                key={t.id}
                className={cn('relative cursor-pointer rounded-lg border border-border bg-card p-4 transition-colors hover:border-primary/60', template === t.id && 'border-primary ring-1 ring-primary')}
              >
                <input type="radio" name="template" value={t.id} checked={template === t.id} onChange={() => setTemplate(t.id)} className="sr-only" />
                {template === t.id ? <Check className="absolute right-3 top-3 size-4 text-primary" /> : null}
                <p className="font-medium">{t.label}</p>
                <p className="mt-1 text-xs text-muted-foreground">{t.description}</p>
              </label>
            ))}
          </div>
        </fieldset>
        <Button type="submit" size="lg" disabled={create.isPending}>
          {create.isPending ? <Spinner /> : null} Create and open editor
        </Button>
      </form>
    </div>
  );
}
