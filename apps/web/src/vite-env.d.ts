/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Public API origin. Empty in development (Vite proxies /api). Never put secrets in VITE_ variables. */
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_AUTH_PROVIDER?: 'local' | 'supabase';
  readonly VITE_SUPABASE_URL?: string;
  /** Supabase publishable (anon) key — safe for browsers by design; RLS protects data. */
  readonly VITE_SUPABASE_PUBLISHABLE_KEY?: string;
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
