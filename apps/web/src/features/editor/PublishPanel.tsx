import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { ProjectDetail, Publication, PublishPrivacy, SocialAccount } from '@clipforge/shared';
import { PLATFORM_RULES } from '@clipforge/shared';
import { CalendarClock, ExternalLink, RotateCcw, Send, X } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/dialog';
import { Field, Input, Select, Textarea } from '@/components/ui/input';
import { Badge, Notice, Spinner } from '@/components/ui/misc';
import { accountLabel } from '@/features/social/ConnectedAccounts';
import { api, errorMessage } from '@/lib/api';
import { qk } from '@/lib/query';
import { relativeTime } from '@/lib/utils';

const ACTIVE = new Set(['queued', 'processing']);
const STATUS: Record<Publication['status'], { label: string; variant: 'default' | 'success' | 'destructive' | 'secondary' }> = {
  queued: { label: 'Waiting', variant: 'default' },
  processing: { label: 'Uploading', variant: 'default' },
  published: { label: 'Posted', variant: 'success' },
  failed: { label: 'Failed', variant: 'destructive' },
  cancelled: { label: 'Cancelled', variant: 'secondary' },
};

const DEFAULT_AUTO = { enabled: false, accountIds: [] as string[], title: '', caption: '', privacy: 'public' as PublishPrivacy };

/** Post the latest Full HD export to connected accounts, now or later, and opt in to auto-posting. */
export function PublishPanel({ project }: { project: ProjectDetail }) {
  const qc = useQueryClient();
  const auto = { ...DEFAULT_AUTO, ...project.settings.autoPublish };
  const social = useQuery({ queryKey: qk.social, queryFn: api.socialAccounts });
  const renders = useQuery({ queryKey: qk.renders(project.id), queryFn: () => api.listRenders(project.id) });
  const publications = useQuery({
    queryKey: qk.publications(project.id),
    queryFn: () => api.projectPublications(project.id),
    refetchInterval: (q) => (q.state.data?.some((p) => ACTIVE.has(p.status)) ? 3000 : false),
  });

  const accounts = useMemo(() => social.data?.accounts ?? [], [social.data]);
  const usable = accounts.filter((a) => a.status === 'active');
  const render = renders.data?.find((r) => r.status === 'completed' && r.profile === 'full');

  const [selected, setSelected] = useState<string[]>(auto.accountIds);
  const [title, setTitle] = useState(auto.title || project.name);
  const [caption, setCaption] = useState(auto.caption);
  const [privacy, setPrivacy] = useState<PublishPrivacy>(auto.privacy);
  const [scheduleAt, setScheduleAt] = useState('');
  const [confirm, setConfirm] = useState<'publish' | 'auto' | null>(null);

  const chosen = usable.filter((a) => selected.includes(a.id));
  const hasYouTube = chosen.some((a) => a.platform === 'youtube');
  const scheduledIso = scheduleAt ? new Date(scheduleAt).toISOString() : null;
  const details = { title: title.trim(), caption: caption.trim(), privacy };

  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  const publish = useMutation({
    mutationFn: () => api.publishRender(render!.id, { ...details, accountIds: chosen.map((a) => a.id), scheduledAt: scheduledIso }),
    onSuccess: ({ created, existing }) => {
      setConfirm(null);
      if (created.length) toast.success(scheduledIso ? `Scheduled ${created.length} post${created.length > 1 ? 's' : ''}` : `Posting to ${created.length} account${created.length > 1 ? 's' : ''}`);
      if (existing.length) toast.message(`${existing.length} account${existing.length > 1 ? 's' : ''} already had this export; not posted twice.`);
      void qc.invalidateQueries({ queryKey: qk.publications(project.id) });
    },
    onError: (e) => {
      setConfirm(null);
      toast.error(errorMessage(e));
    },
  });
  const saveAuto = useMutation({
    mutationFn: (enabled: boolean) =>
      api.updateProject(project.id, { settings: { autoPublish: { ...details, enabled, accountIds: enabled ? chosen.map((a) => a.id) : auto.accountIds } } }),
    onSuccess: (_d, enabled) => {
      setConfirm(null);
      toast.success(enabled ? 'Auto-publish is on' : 'Auto-publish is off');
      void qc.invalidateQueries({ queryKey: qk.project(project.id) });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const cancel = useMutation({
    mutationFn: (id: string) => api.cancelPublication(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.publications(project.id) }),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const retry = useMutation({
    mutationFn: (id: string) => api.retryPublication(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: qk.publications(project.id) }),
    onError: (e) => toast.error(errorMessage(e)),
  });

  const names = chosen.map(accountLabel).join(', ');
  const autoAccounts = accounts.filter((a) => auto.accountIds.includes(a.id));

  return (
    <section className="space-y-3 border-t border-border pt-4" data-testid="publish-panel">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        <Send className="size-4" /> Post to social
      </h3>

      {social.isPending ? <Spinner /> : null}
      {social.isError ? <Notice tone="error">{errorMessage(social.error)}</Notice> : null}
      {social.data && accounts.length === 0 ? (
        <Notice>
          No accounts connected yet. <Link className="underline" to="/app/settings#accounts">Connect YouTube, TikTok or Instagram</Link> in Settings.
        </Notice>
      ) : null}

      {usable.length > 0 ? (
        <>
          <fieldset className="space-y-1.5">
            <legend className="mb-1 text-xs font-medium text-muted-foreground">Accounts</legend>
            {usable.map((a) => (
              <label key={a.id} className="flex cursor-pointer items-center gap-2 text-sm">
                <input type="checkbox" checked={selected.includes(a.id)} onChange={() => toggle(a.id)} className="accent-primary" />
                {accountLabel(a)}
              </label>
            ))}
            {accounts.some((a) => a.status === 'needs_reconnect') ? (
              <p className="text-xs text-warning">
                Some accounts need to be reconnected in <Link className="underline" to="/app/settings#accounts">Settings</Link>.
              </p>
            ) : null}
          </fieldset>
          {hasYouTube ? (
            <Field label="YouTube title" htmlFor="pub-title">
              <Input id="pub-title" maxLength={100} value={title} onChange={(e) => setTitle(e.target.value)} />
            </Field>
          ) : null}
          <Field label="Caption" htmlFor="pub-caption" hint="Hashtags go here. Used as the description on YouTube.">
            <Textarea id="pub-caption" rows={3} maxLength={2200} value={caption} onChange={(e) => setCaption(e.target.value)} />
          </Field>
          <Field label="Visibility" htmlFor="pub-privacy" hint={privacyHint(chosen, privacy)}>
            <Select id="pub-privacy" value={privacy} onChange={(e) => setPrivacy(e.target.value as PublishPrivacy)}>
              <option value="public">Public</option>
              <option value="unlisted">Unlisted (YouTube only)</option>
              <option value="private">Private / only me</option>
            </Select>
          </Field>
          <Field label="Post later (optional)" htmlFor="pub-schedule" hint="Leave empty to post as soon as you confirm. Up to 30 days ahead.">
            <Input id="pub-schedule" type="datetime-local" value={scheduleAt} onChange={(e) => setScheduleAt(e.target.value)} />
          </Field>

          {render ? (
            <Button className="w-full" onClick={() => setConfirm('publish')} disabled={!chosen.length || publish.isPending} data-testid="publish-button">
              {publish.isPending ? <Spinner /> : scheduledIso ? <CalendarClock /> : <Send />}
              {scheduledIso ? 'Schedule' : 'Publish'} to {chosen.length} account{chosen.length === 1 ? '' : 's'}
            </Button>
          ) : (
            <Notice>Export in Full HD first. Posts use your latest Full HD export.</Notice>
          )}

          <div className="space-y-2 rounded-md border border-border p-3">
            <label className="flex cursor-pointer items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-0.5 accent-primary"
                checked={auto.enabled}
                disabled={saveAuto.isPending}
                onChange={(e) => {
                  if (!e.target.checked) saveAuto.mutate(false);
                  else if (!chosen.length) toast.error('Choose at least one account first.');
                  else setConfirm('auto');
                }}
                data-testid="auto-publish-toggle"
              />
              <span>
                <span className="block font-medium">Auto-publish new exports</span>
                <span className="text-xs text-muted-foreground">
                  {auto.enabled
                    ? `Every new Full HD export is posted to ${autoAccounts.map(accountLabel).join(', ') || 'no accounts'}.`
                    : 'When on, each finished Full HD export is posted to the selected accounts automatically.'}
                </span>
              </span>
            </label>
            {auto.enabled ? (
              <Button size="sm" variant="outline" disabled={!chosen.length || saveAuto.isPending} onClick={() => setConfirm('auto')}>
                Use current accounts and caption
              </Button>
            ) : null}
          </div>
        </>
      ) : null}

      {publications.data && publications.data.length > 0 ? (
        <div className="space-y-1.5" data-testid="publications">
          <h4 className="text-xs font-medium text-muted-foreground">Posts</h4>
          {publications.data.slice(0, 20).map((p) => (
            <div key={p.id} className="space-y-0.5 rounded border border-border p-2 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate">
                  {PLATFORM_RULES[p.platform].label} · {p.accountName ?? 'account'}
                  {p.trigger === 'auto' ? <span className="text-muted-foreground"> · auto</span> : null}
                </span>
                <Badge variant={STATUS[p.status].variant}>{STATUS[p.status].label}</Badge>
              </div>
              <div className="flex items-center justify-between gap-2 text-muted-foreground">
                <span>
                  {p.status === 'queued' && p.scheduledAt && new Date(p.scheduledAt) > new Date()
                    ? `Scheduled ${new Date(p.scheduledAt).toLocaleString()}`
                    : relativeTime(p.completedAt ?? p.createdAt)}
                </span>
                <span className="flex items-center gap-1">
                  {p.externalUrl ? (
                    <a href={p.externalUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 underline">
                      View <ExternalLink className="size-3" />
                    </a>
                  ) : null}
                  {p.status === 'queued' ? (
                    <Button size="icon-sm" variant="ghost" aria-label="Cancel post" onClick={() => cancel.mutate(p.id)}>
                      <X />
                    </Button>
                  ) : null}
                  {p.status === 'failed' ? (
                    <Button size="icon-sm" variant="ghost" aria-label="Retry post" onClick={() => retry.mutate(p.id)}>
                      <RotateCcw />
                    </Button>
                  ) : null}
                </span>
              </div>
              {p.status === 'published' && !p.externalUrl ? <p className="text-muted-foreground">Sent to the platform. It may still be processing there.</p> : null}
              {p.errorMessage && p.status === 'failed' ? <p className="text-destructive">{p.errorMessage}</p> : null}
            </div>
          ))}
        </div>
      ) : null}

      <ConfirmDialog
        open={confirm !== null}
        onOpenChange={(open) => !open && setConfirm(null)}
        tone="default"
        title={confirm === 'auto' ? 'Turn on auto-publish?' : scheduledIso ? 'Schedule this video?' : 'Publish this video now?'}
        description={
          confirm === 'auto'
            ? `Every new Full HD export of "${project.name}" will be posted to: ${names}. You can turn this off at any time.`
            : `This posts your latest Full HD export ${scheduledIso ? `on ${new Date(scheduledIso).toLocaleString()} ` : ''}to: ${names}.`
        }
        confirmLabel={confirm === 'auto' ? 'Turn on' : scheduledIso ? 'Schedule' : 'Publish'}
        busy={publish.isPending || saveAuto.isPending}
        onConfirm={() => (confirm === 'auto' ? saveAuto.mutate(true) : publish.mutate())}
      />
    </section>
  );
}

function privacyHint(chosen: SocialAccount[], privacy: PublishPrivacy): string | undefined {
  const notes: string[] = [];
  if (chosen.some((a) => a.platform === 'instagram') && privacy !== 'public') notes.push('Instagram Reels are always public.');
  if (chosen.some((a) => a.platform === 'tiktok') && privacy === 'unlisted') notes.push('TikTok has no unlisted option; choose public or private.');
  return notes.join(' ') || undefined;
}
