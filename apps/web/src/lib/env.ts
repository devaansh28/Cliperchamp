/** Browser configuration. Only public values live here; secrets stay on the server. */
export const webEnv = {
  apiBaseUrl: (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/u, ''),
  authProvider: (import.meta.env.VITE_AUTH_PROVIDER ?? 'local') as 'local' | 'supabase',
  supabaseUrl: import.meta.env.VITE_SUPABASE_URL ?? '',
  supabasePublishableKey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY ?? '',
};
