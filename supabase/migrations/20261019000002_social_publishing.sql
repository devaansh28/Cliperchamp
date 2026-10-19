-- Social publishing: connected accounts (OAuth tokens encrypted by the server) and publish jobs.

alter table public.render_jobs add constraint render_jobs_id_user_unique unique (id, user_id);

-- ---------------------------------------------------------------------------
-- Connected social accounts. Tokens are AES-256-GCM ciphertext written by the API;
-- the authenticated role cannot read the token columns at all (column grants below).
-- ---------------------------------------------------------------------------
create table public.social_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  platform text not null check (platform in ('youtube', 'tiktok', 'instagram')),
  external_account_id text not null check (char_length(external_account_id) <= 200),
  display_name text check (char_length(display_name) <= 200),
  avatar_url text check (char_length(avatar_url) <= 2000),
  scopes text[] not null default '{}',
  access_token_enc text not null,
  refresh_token_enc text,
  token_expires_at timestamptz,
  status text not null default 'active' check (status in ('active', 'needs_reconnect')),
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, platform, external_account_id),
  unique (id, user_id)
);
create index social_accounts_user_idx on public.social_accounts (user_id);
create trigger social_accounts_updated_at before update on public.social_accounts
  for each row execute function public.set_updated_at();

-- One-time OAuth state values (CSRF protection for the connect flow). Server-only.
create table public.social_oauth_states (
  state text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  platform text not null check (platform in ('youtube', 'tiktok', 'instagram')),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- Publish jobs: one finished export posted to one account.
-- ---------------------------------------------------------------------------
create table public.publish_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  project_id uuid not null,
  render_job_id uuid not null,
  social_account_id uuid not null,
  platform text not null check (platform in ('youtube', 'tiktok', 'instagram')),
  status text not null default 'queued' check (status in ('queued', 'processing', 'published', 'failed', 'cancelled')),
  trigger text not null default 'manual' check (trigger in ('auto', 'manual')),
  title text not null default '' check (char_length(title) <= 100),
  caption text not null default '' check (char_length(caption) <= 5000),
  privacy text not null default 'public' check (privacy in ('public', 'unlisted', 'private')),
  scheduled_at timestamptz,
  attempt integer not null default 0 check (attempt >= 0),
  max_attempts integer not null default 3,
  -- Platform handle saved as soon as the platform accepts the upload, so a retry
  -- resumes (checks status / finishes publishing) instead of posting twice.
  platform_ref text,
  external_post_id text,
  external_url text,
  error_category text check (error_category is null or error_category in ('validation', 'auth', 'platform', 'storage', 'cancelled', 'internal')),
  error_message text,
  error_detail text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  updated_at timestamptz not null default now(),
  foreign key (project_id, user_id) references public.projects (id, user_id) on delete cascade,
  foreign key (render_job_id, user_id) references public.render_jobs (id, user_id) on delete cascade,
  foreign key (social_account_id, user_id) references public.social_accounts (id, user_id) on delete cascade,
  -- Never post the same export to the same account twice.
  unique (render_job_id, social_account_id)
);
create index publish_jobs_project_idx on public.publish_jobs (project_id, created_at desc);
create index publish_jobs_status_idx on public.publish_jobs (status, updated_at);
create trigger publish_jobs_updated_at before update on public.publish_jobs
  for each row execute function public.set_updated_at();

alter table public.social_accounts enable row level security;
alter table public.social_oauth_states enable row level security;
alter table public.publish_jobs enable row level security;

create policy social_accounts_select_own on public.social_accounts for select to authenticated using (user_id = (select auth.uid()));
create policy social_accounts_delete_own on public.social_accounts for delete to authenticated using (user_id = (select auth.uid()));
create policy publish_jobs_select_own on public.publish_jobs for select to authenticated using (user_id = (select auth.uid()));
create policy publish_jobs_insert_own on public.publish_jobs for insert to authenticated with check (user_id = (select auth.uid()) and status = 'queued' and attempt = 0);

-- Token columns are deliberately not granted.
grant select (id, user_id, platform, external_account_id, display_name, avatar_url, scopes, token_expires_at, status, last_error, created_at, updated_at)
  on public.social_accounts to authenticated;
grant delete on public.social_accounts to authenticated;
grant select on public.publish_jobs to authenticated;
grant insert (user_id, project_id, render_job_id, social_account_id, platform, trigger, title, caption, privacy, scheduled_at)
  on public.publish_jobs to authenticated;
