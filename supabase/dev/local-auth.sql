-- DEVELOPMENT/TEST ONLY: credentials for AUTH_PROVIDER=local.
-- The API refuses to start with AUTH_PROVIDER=local when NODE_ENV=production.

create schema if not exists local_auth;
revoke all on schema local_auth from public;

create table if not exists local_auth.credentials (
  user_id uuid primary key references auth.users (id) on delete cascade,
  password_hash text not null,
  created_at timestamptz not null default now()
);

create table if not exists local_auth.refresh_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  token_hash text not null unique,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists refresh_tokens_user_idx on local_auth.refresh_tokens (user_id);
