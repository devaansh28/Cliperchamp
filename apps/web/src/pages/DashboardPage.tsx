import { useQuery } from '@tanstack/react-query';
import { VIDEO_TEMPLATES } from '@clipforge/shared';
import { ArrowRight, Film, Plus } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { EmptyState, Notice, Progress, Skeleton } from '@/components/ui/misc';
import { ProjectCard } from '@/features/projects/ProjectCard';
import { api, errorMessage } from '@/lib/api';
import { qk } from '@/lib/query';
import { formatUsage } from '@/lib/utils';

export function DashboardPage() {
  const projects = useQuery({ queryKey: qk.projects('', 'updated'), queryFn: () => api.listProjects({ sort: 'updated' }) });
  const usage = useQuery({ queryKey: qk.usage, queryFn: api.usage });
  const integrations = useQuery({ queryKey: qk.integrations, queryFn: api.integrations });
  const recent = projects.data?.slice(0, 4) ?? [];

  return (
    <div className="mx-auto max-w-6xl space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">Dashboard</h1>
          <p className="text-sm text-muted-foreground">Pick up where you left off or start something new.</p>
        </div>
        <Button asChild>
          <Link to="/app/projects/new">
            <Plus /> New video
          </Link>
        </Button>
      </div>

      <section className="grid gap-3 sm:grid-cols-3" aria-label="Start from a template">
        {VIDEO_TEMPLATES.map((t) => (
          <Link key={t.id} to={`/app/projects/new?template=${t.id}`} className="rounded-lg border border-border bg-card p-4 transition-colors hover:border-primary/60">
            <p className="font-medium">{t.label}</p>
            <p className="text-xs text-muted-foreground">{t.description}</p>
          </Link>
        ))}
      </section>

      <section aria-labelledby="recent">
        <div className="mb-3 flex items-center justify-between">
          <h2 id="recent" className="font-semibold">
            Recent projects
          </h2>
          <Link to="/app/projects" className="flex items-center gap-1 text-sm text-primary hover:underline">
            All projects <ArrowRight className="size-3.5" />
          </Link>
        </div>
        {projects.isPending ? (
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="aspect-[9/14]" />
            ))}
          </div>
        ) : projects.isError ? (
          <Notice tone="error">{errorMessage(projects.error)}</Notice>
        ) : recent.length === 0 ? (
          <EmptyState icon={<Film />} title="No videos yet" description="Create your first short in a few steps." action={<Button asChild><Link to="/app/projects/new">Create a video</Link></Button>} />
        ) : (
          <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
            {recent.map((p) => (
              <ProjectCard key={p.id} project={p} />
            ))}
          </div>
        )}
      </section>

      <div className="grid gap-4 md:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>This month</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {usage.data?.items.slice(0, 3).map((item) => (
              <div key={item.kind} className="space-y-1">
                <div className="flex justify-between text-xs">
                  <span className="capitalize">{item.kind.replace(/_/gu, ' ')}</span>
                  <span className="text-muted-foreground">
                    {formatUsage(item.used, item.unit)} / {formatUsage(item.limit, item.unit)}
                  </span>
                </div>
                <Progress label={item.kind} value={item.limit > 0 ? item.used / item.limit : 0} />
              </div>
            )) ?? <Skeleton className="h-16" />}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>Integrations</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {integrations.data ? (
              <>
                <IntegrationRow name="AI script writer" ok={integrations.data.llm.configured} detail={integrations.data.llm.provider} />
                <IntegrationRow name="Voiceover" ok={integrations.data.tts.configured} detail={integrations.data.tts.provider} />
                <IntegrationRow name="Stock footage" ok={integrations.data.media.configured} detail={integrations.data.media.provider} />
                <IntegrationRow name="Caption alignment" ok={integrations.data.alignment.configured} detail={integrations.data.alignment.provider} />
              </>
            ) : (
              <Skeleton className="h-16" />
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

function IntegrationRow({ name, ok, detail }: { name: string; ok: boolean; detail: string }) {
  return (
    <div className="flex items-center justify-between">
      <span>{name}</span>
      <span className={ok ? 'text-success' : 'text-muted-foreground'}>{ok ? `On (${detail})` : 'Not configured'}</span>
    </div>
  );
}
