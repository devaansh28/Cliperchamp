import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { SocialAccount, SocialPlatform } from '@clipforge/shared';
import { PLATFORM_RULES } from '@clipforge/shared';
import { Link2, Unlink } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { ConfirmDialog } from '@/components/ui/dialog';
import { Badge, Notice, Skeleton, Spinner } from '@/components/ui/misc';
import { api, errorMessage } from '@/lib/api';
import { qk } from '@/lib/query';

export function accountLabel(a: Pick<SocialAccount, 'platform' | 'displayName' | 'externalAccountId'>) {
  return `${PLATFORM_RULES[a.platform].label} · ${a.displayName ?? a.externalAccountId}`;
}

/** Settings card: connect YouTube, TikTok and Instagram through each platform's own consent screen. */
export function ConnectedAccounts() {
  const qc = useQueryClient();
  const social = useQuery({ queryKey: qk.social, queryFn: api.socialAccounts });
  const [removing, setRemoving] = useState<SocialAccount | null>(null);

  const connect = useMutation({
    mutationFn: (platform: SocialPlatform) => api.connectSocial(platform),
    // The platform's consent page redirects back to Settings when the user is done.
    onSuccess: ({ authorizeUrl }) => window.location.assign(authorizeUrl),
    onError: (e) => toast.error(errorMessage(e)),
  });
  const disconnect = useMutation({
    mutationFn: (id: string) => api.disconnectSocial(id),
    onSuccess: () => {
      toast.success('Account disconnected');
      setRemoving(null);
      void qc.invalidateQueries({ queryKey: qk.social });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <Card id="accounts" data-testid="connected-accounts">
      <CardHeader>
        <CardTitle>Connected accounts</CardTitle>
        <CardDescription>Connect your channels to post finished videos to all of them at once. ClipForge only posts when you press Publish or turn on auto-publish for a project.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {social.isPending ? <Skeleton className="h-24" /> : null}
        {social.isError ? <Notice tone="error">{errorMessage(social.error)}</Notice> : null}
        {social.data?.platforms.map((p) => {
          const accounts = social.data.accounts.filter((a) => a.platform === p.platform);
          return (
            <section key={p.platform} className="space-y-2 rounded-md border border-border p-3" data-testid={`platform-${p.platform}`}>
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="font-medium">{p.label}</p>
                  <p className="text-xs text-muted-foreground">{PLATFORM_RULES[p.platform].product}</p>
                </div>
                {p.configured ? (
                  <Button size="sm" variant="outline" onClick={() => connect.mutate(p.platform)} disabled={connect.isPending}>
                    {connect.isPending && connect.variables === p.platform ? <Spinner /> : <Link2 />} {accounts.length ? 'Add another' : 'Connect'}
                  </Button>
                ) : (
                  <span className="text-xs text-muted-foreground" title="The server admin needs to add this platform's app credentials.">
                    Not set up on this server
                  </span>
                )}
              </div>
              {accounts.map((a) => (
                <div key={a.id} className="flex items-center justify-between gap-3 text-sm" data-testid="social-account">
                  <span className="flex min-w-0 items-center gap-2">
                    {a.avatarUrl ? <img src={a.avatarUrl} alt="" className="size-6 rounded-full" referrerPolicy="no-referrer" /> : null}
                    <span className="truncate">{a.displayName ?? a.externalAccountId}</span>
                    {a.status === 'needs_reconnect' ? <Badge variant="warning">Reconnect needed</Badge> : <Badge variant="success">Connected</Badge>}
                  </span>
                  <span className="flex items-center gap-1">
                    {a.status === 'needs_reconnect' && p.configured ? (
                      <Button size="sm" variant="ghost" onClick={() => connect.mutate(p.platform)}>
                        Reconnect
                      </Button>
                    ) : null}
                    <Button size="icon-sm" variant="ghost" aria-label={`Disconnect ${accountLabel(a)}`} onClick={() => setRemoving(a)}>
                      <Unlink />
                    </Button>
                  </span>
                </div>
              ))}
              {accounts.some((a) => a.lastError && a.status === 'needs_reconnect') ? (
                <p className="text-xs text-warning">{accounts.find((a) => a.lastError)?.lastError}</p>
              ) : null}
            </section>
          );
        })}
      </CardContent>
      <ConfirmDialog
        open={Boolean(removing)}
        onOpenChange={(open) => !open && setRemoving(null)}
        title="Disconnect account?"
        description={removing ? `${accountLabel(removing)} will no longer receive posts, and its scheduled posts and post history here are removed. Videos already on the platform stay up.` : ''}
        confirmLabel="Disconnect"
        busy={disconnect.isPending}
        onConfirm={() => removing && disconnect.mutate(removing.id)}
      />
    </Card>
  );
}
