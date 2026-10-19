import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Field, Input } from '@/components/ui/input';
import { Notice } from '@/components/ui/misc';
import { api, errorMessage } from '@/lib/api';
import { auth } from '@/lib/auth';
import { ConnectedAccounts } from '@/features/social/ConnectedAccounts';
import { qk } from '@/lib/query';

export function SettingsPage() {
  const qc = useQueryClient();
  const me = useQuery({ queryKey: qk.me, queryFn: api.me });
  const integrations = useQuery({ queryKey: qk.integrations, queryFn: api.integrations });
  const [displayName, setDisplayName] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');

  // Result of a social OAuth round trip (the API redirects back here). Show it once, then clean the URL.
  const [params, setParams] = useSearchParams();
  useEffect(() => {
    const result = params.get('social');
    if (!result) return;
    if (result === 'connected') toast.success(`Connected ${params.get('account') || 'account'}`, { id: 'social-oauth' });
    else toast.error(params.get('message') || 'Could not connect the account.', { id: 'social-oauth' });
    void qc.invalidateQueries({ queryKey: qk.social });
    setParams({}, { replace: true });
    document.getElementById('accounts')?.scrollIntoView();
  }, [params, setParams, qc]);

  useEffect(() => {
    if (me.data) setDisplayName(me.data.displayName ?? '');
  }, [me.data]);

  const saveProfile = useMutation({
    mutationFn: () => api.updateMe(displayName.trim() || null),
    onSuccess: () => {
      toast.success('Profile saved');
      void qc.invalidateQueries({ queryKey: qk.me });
    },
    onError: (e) => toast.error(errorMessage(e)),
  });
  const changePassword = useMutation({
    mutationFn: () => auth.changePassword(currentPassword, newPassword),
    onSuccess: () => {
      toast.success('Password changed');
      setCurrentPassword('');
      setNewPassword('');
    },
    onError: (e) => toast.error(errorMessage(e)),
  });

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <h1 className="text-2xl font-bold">Settings</h1>
      <Card>
        <CardHeader>
          <CardTitle>Profile</CardTitle>
          <CardDescription>{me.data?.email}</CardDescription>
        </CardHeader>
        <CardContent>
          <form
            className="flex items-end gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              saveProfile.mutate();
            }}
          >
            <div className="flex-1">
              <Field label="Display name" htmlFor="display-name">
                <Input id="display-name" maxLength={80} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
              </Field>
            </div>
            <Button type="submit" disabled={saveProfile.isPending}>
              Save
            </Button>
          </form>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Password</CardTitle>
        </CardHeader>
        <CardContent>
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              changePassword.mutate();
            }}
          >
            {auth.provider === 'local' ? (
              <Field label="Current password" htmlFor="current-password">
                <Input id="current-password" type="password" autoComplete="current-password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} />
              </Field>
            ) : null}
            <Field label="New password" htmlFor="new-password" hint="At least 8 characters.">
              <Input id="new-password" type="password" autoComplete="new-password" minLength={8} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
            </Field>
            <Button type="submit" disabled={newPassword.length < 8 || changePassword.isPending}>
              Change password
            </Button>
          </form>
        </CardContent>
      </Card>

      <ConnectedAccounts />

      <Card>
        <CardHeader>
          <CardTitle>Integrations</CardTitle>
          <CardDescription>Configured on the server through environment variables. Keys are never shown here.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-2 text-sm">
          {integrations.data ? (
            <>
              <Row name="Script generation (LLM)" value={integrations.data.llm.configured ? `${integrations.data.llm.provider}${integrations.data.llm.model ? ` · ${integrations.data.llm.model}` : ''}` : null} />
              <Row name="Text to speech" value={integrations.data.tts.configured ? integrations.data.tts.provider : null} />
              <Row name="Stock media" value={integrations.data.media.configured ? integrations.data.media.provider : null} />
              <Row name="Caption alignment" value={integrations.data.alignment.configured ? integrations.data.alignment.provider : null} />
              <Row name="Sign-in" value={integrations.data.auth.provider} />
            </>
          ) : integrations.isError ? (
            <Notice tone="error">{errorMessage(integrations.error)}</Notice>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}

function Row({ name, value }: { name: string; value: string | null }) {
  return (
    <div className="flex justify-between gap-4">
      <span>{name}</span>
      <span className={value ? 'text-success' : 'text-muted-foreground'}>{value ?? 'Not configured'}</span>
    </div>
  );
}
