import { zodResolver } from '@hookform/resolvers/zod';
import { CredentialsSchema } from '@clipforge/shared';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import type { z } from 'zod';
import { Logo } from '@/components/layout/Logo';
import { Button } from '@/components/ui/button';
import { Field, Input } from '@/components/ui/input';
import { Notice, Spinner } from '@/components/ui/misc';
import { auth } from '@/lib/auth';

type FormValues = z.input<typeof CredentialsSchema>;

export function AuthPage({ mode }: { mode: 'login' | 'register' }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const form = useForm<FormValues>({ resolver: zodResolver(CredentialsSchema), defaultValues: { email: '', password: '' } });
  const from = (location.state as { from?: string } | null)?.from ?? '/app';

  const onSubmit = form.handleSubmit(async (values) => {
    setError(null);
    setInfo(null);
    try {
      if (mode === 'login') {
        await auth.signIn(values.email, values.password);
      } else {
        const result = await auth.signUp(values.email, values.password);
        if ('needsConfirmation' in result) {
          setInfo('Check your inbox to confirm your email, then sign in.');
          return;
        }
      }
      navigate(from, { replace: true });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong');
    }
  });

  const isLogin = mode === 'login';
  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-sm space-y-6">
        <Logo className="justify-center" />
        <div className="rounded-lg border border-border bg-card p-6">
          <h1 className="text-xl font-semibold">{isLogin ? 'Welcome back' : 'Create your account'}</h1>
          <p className="mb-5 mt-1 text-sm text-muted-foreground">{isLogin ? 'Sign in to keep editing your videos.' : 'Start making short videos for free.'}</p>
          <form onSubmit={onSubmit} className="space-y-4" noValidate>
            <Field label="Email" htmlFor="email" error={form.formState.errors.email?.message}>
              <Input id="email" type="email" autoComplete="email" {...form.register('email')} />
            </Field>
            <Field label="Password" htmlFor="password" error={form.formState.errors.password?.message} hint={isLogin ? undefined : 'At least 8 characters.'}>
              <Input id="password" type="password" autoComplete={isLogin ? 'current-password' : 'new-password'} {...form.register('password')} />
            </Field>
            {error ? <Notice tone="error">{error}</Notice> : null}
            {info ? <Notice>{info}</Notice> : null}
            <Button type="submit" className="w-full" disabled={form.formState.isSubmitting}>
              {form.formState.isSubmitting ? <Spinner /> : null}
              {isLogin ? 'Sign in' : 'Create account'}
            </Button>
          </form>
        </div>
        <p className="text-center text-sm text-muted-foreground">
          {isLogin ? (
            <>
              New here? <Link className="text-primary hover:underline" to="/register">Create an account</Link>
            </>
          ) : (
            <>
              Already have an account? <Link className="text-primary hover:underline" to="/login">Sign in</Link>
            </>
          )}
        </p>
      </div>
    </div>
  );
}
