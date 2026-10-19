import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { webEnv } from './env';

export interface AuthUser {
  id: string;
  email: string | null;
}

export interface AuthSession {
  user: AuthUser;
}

type Listener = (session: AuthSession | null) => void;

/** One interface for both auth modes so the rest of the app does not care which is active. */
export interface AuthClient {
  readonly provider: 'local' | 'supabase';
  init(): Promise<AuthSession | null>;
  signIn(email: string, password: string): Promise<AuthSession>;
  signUp(email: string, password: string): Promise<AuthSession | { needsConfirmation: true }>;
  signOut(): Promise<void>;
  getAccessToken(): Promise<string | null>;
  /** Called after the API answers 401: try to get a fresh token once. */
  refresh(): Promise<string | null>;
  changePassword(currentPassword: string, newPassword: string): Promise<void>;
  onChange(listener: Listener): () => void;
}

export class AuthError extends Error {}

function decodeJwt(token: string): { sub?: string; email?: string; exp?: number } {
  try {
    const part = token.split('.')[1] ?? '';
    return JSON.parse(atob(part.replace(/-/gu, '+').replace(/_/gu, '/'))) as { sub?: string; email?: string; exp?: number };
  } catch {
    return {};
  }
}

const REFRESH_KEY = 'clipforge.refresh';

/**
 * Development auth against the API's local auth routes. The access token lives in memory only;
 * the rotating refresh token is kept in localStorage so a reload keeps you signed in.
 */
export class LocalAuthClient implements AuthClient {
  readonly provider = 'local' as const;
  private accessToken: string | null = null;
  private session: AuthSession | null = null;
  private listeners = new Set<Listener>();
  private refreshing: Promise<string | null> | null = null;

  constructor(private readonly baseUrl: string) {}

  private emit() {
    for (const l of this.listeners) l(this.session);
  }

  private async post<T>(path: string, body: unknown, token?: string): Promise<T> {
    const res = await fetch(`${this.baseUrl}/api/auth${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body),
    });
    if (res.status === 204) return undefined as T;
    const data = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
    if (!res.ok) throw new AuthError(data.error?.message ?? `Request failed (${res.status})`);
    return data as T;
  }

  private accept(tokens: { accessToken: string; refreshToken: string; user: AuthUser }): AuthSession {
    this.accessToken = tokens.accessToken;
    localStorage.setItem(REFRESH_KEY, tokens.refreshToken);
    this.session = { user: tokens.user };
    this.emit();
    return this.session;
  }

  async init(): Promise<AuthSession | null> {
    if (!localStorage.getItem(REFRESH_KEY)) return null;
    await this.refresh();
    return this.session;
  }

  async signIn(email: string, password: string) {
    return this.accept(await this.post('/login', { email, password }));
  }

  async signUp(email: string, password: string) {
    return this.accept(await this.post('/register', { email, password }));
  }

  async signOut() {
    const refreshToken = localStorage.getItem(REFRESH_KEY);
    localStorage.removeItem(REFRESH_KEY);
    this.accessToken = null;
    this.session = null;
    this.emit();
    if (refreshToken) await this.post('/logout', { refreshToken }).catch(() => undefined);
  }

  async getAccessToken() {
    if (this.accessToken) {
      const { exp } = decodeJwt(this.accessToken);
      if (!exp || exp * 1000 > Date.now() + 30_000) return this.accessToken;
    }
    return this.refresh();
  }

  refresh(): Promise<string | null> {
    this.refreshing ??= (async () => {
      const refreshToken = localStorage.getItem(REFRESH_KEY);
      if (!refreshToken) return null;
      try {
        this.accept(await this.post('/refresh', { refreshToken }));
        return this.accessToken;
      } catch {
        localStorage.removeItem(REFRESH_KEY);
        this.accessToken = null;
        this.session = null;
        this.emit();
        return null;
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  async changePassword(currentPassword: string, newPassword: string) {
    const token = await this.getAccessToken();
    if (!token) throw new AuthError('Sign in again to change your password');
    await this.post('/password', { currentPassword, newPassword }, token);
  }

  onChange(listener: Listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

/** Production auth with Supabase. Only the publishable key is used in the browser. */
export class SupabaseAuthClient implements AuthClient {
  readonly provider = 'supabase' as const;
  private readonly client: SupabaseClient;

  constructor(url: string, publishableKey: string) {
    this.client = createClient(url, publishableKey, { auth: { persistSession: true, autoRefreshToken: true } });
  }

  private static toSession(user: { id: string; email?: string | null } | null | undefined): AuthSession | null {
    return user ? { user: { id: user.id, email: user.email ?? null } } : null;
  }

  async init() {
    const { data } = await this.client.auth.getSession();
    return SupabaseAuthClient.toSession(data.session?.user);
  }

  async signIn(email: string, password: string) {
    const { data, error } = await this.client.auth.signInWithPassword({ email, password });
    if (error || !data.user) throw new AuthError(error?.message ?? 'Sign-in failed');
    return SupabaseAuthClient.toSession(data.user)!;
  }

  async signUp(email: string, password: string) {
    const { data, error } = await this.client.auth.signUp({ email, password, options: { emailRedirectTo: `${window.location.origin}/login` } });
    if (error) throw new AuthError(error.message);
    if (!data.session) return { needsConfirmation: true as const };
    return SupabaseAuthClient.toSession(data.user)!;
  }

  async signOut() {
    await this.client.auth.signOut();
  }

  async getAccessToken() {
    const { data } = await this.client.auth.getSession();
    return data.session?.access_token ?? null;
  }

  async refresh() {
    const { data } = await this.client.auth.refreshSession();
    return data.session?.access_token ?? null;
  }

  async changePassword(_currentPassword: string, newPassword: string) {
    const { error } = await this.client.auth.updateUser({ password: newPassword });
    if (error) throw new AuthError(error.message);
  }

  onChange(listener: Listener) {
    const { data } = this.client.auth.onAuthStateChange((_event, session) => listener(SupabaseAuthClient.toSession(session?.user)));
    return () => data.subscription.unsubscribe();
  }
}

export function createAuthClient(): AuthClient {
  if (webEnv.authProvider === 'supabase') {
    if (!webEnv.supabaseUrl || !webEnv.supabasePublishableKey) {
      throw new Error('VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY are required when VITE_AUTH_PROVIDER=supabase');
    }
    return new SupabaseAuthClient(webEnv.supabaseUrl, webEnv.supabasePublishableKey);
  }
  return new LocalAuthClient(webEnv.apiBaseUrl);
}

export const auth: AuthClient = createAuthClient();
