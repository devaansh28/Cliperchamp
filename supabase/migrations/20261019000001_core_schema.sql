-- ClipForge AI core schema.
-- Runs on Supabase (auth schema provided by Supabase) and on plain PostgreSQL
-- after supabase/dev/auth-shim.sql has created a compatible auth schema.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------
create or replace function public.set_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Profiles
-- ---------------------------------------------------------------------------
create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text check (display_name is null or char_length(display_name) between 1 and 80),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create trigger profiles_updated_at before update on public.profiles
  for each row execute function public.set_updated_at();

create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id) values (new.id) on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Projects
-- ---------------------------------------------------------------------------
create table public.projects (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null check (char_length(name) between 1 and 120),
  template text not null default 'story',
  script jsonb,
  script_input jsonb,
  settings jsonb not null default '{}'::jsonb,
  caption_style jsonb not null default '{}'::jsonb,
  output_profile jsonb not null default '{}'::jsonb,
  background_color text not null default '#0b0b10' check (background_color ~ '^#[0-9a-fA-F]{6}$'),
  revision integer not null default 0 check (revision >= 0),
  thumbnail_path text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id)
);
create index projects_user_updated_idx on public.projects (user_id, updated_at desc);
create index projects_user_name_idx on public.projects (user_id, lower(name));
create trigger projects_updated_at before update on public.projects
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Media assets (bytes live in object storage; only metadata here)
-- ---------------------------------------------------------------------------
create table public.media_assets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  project_id uuid references public.projects (id) on delete set null,
  kind text not null check (kind in ('video', 'image', 'audio')),
  source text not null check (source in ('upload', 'tts', 'stock', 'test')),
  status text not null default 'pending' check (status in ('pending', 'ready', 'failed')),
  storage_path text not null unique,
  original_name text check (original_name is null or char_length(original_name) <= 255),
  mime_type text not null,
  size_bytes bigint not null default 0 check (size_bytes >= 0),
  duration_ms integer check (duration_ms is null or duration_ms >= 0),
  width integer,
  height integer,
  attribution text,
  license text,
  source_url text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, user_id)
);
create index media_assets_user_created_idx on public.media_assets (user_id, created_at desc);
create index media_assets_project_idx on public.media_assets (project_id);
create trigger media_assets_updated_at before update on public.media_assets
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Timeline clips (canonical timeline rows; composite FKs force same owner)
-- ---------------------------------------------------------------------------
create table public.timeline_clips (
  id uuid primary key,
  project_id uuid not null,
  user_id uuid not null,
  asset_id uuid not null,
  track text not null check (track in ('video', 'narration', 'music')),
  sort_order integer not null default 0 check (sort_order >= 0),
  start_ms integer not null default 0 check (start_ms >= 0),
  trim_start_ms integer not null default 0 check (trim_start_ms >= 0),
  duration_ms integer not null check (duration_ms between 100 and 600000),
  volume numeric(4, 3) not null default 1 check (volume between 0 and 2),
  fit text not null default 'cover' check (fit in ('cover', 'contain')),
  loop boolean not null default false,
  transition text not null default 'none' check (transition in ('none', 'fade', 'slide')),
  transition_ms integer not null default 300 check (transition_ms between 0 and 2000),
  created_at timestamptz not null default now(),
  foreign key (project_id, user_id) references public.projects (id, user_id) on delete cascade,
  foreign key (asset_id, user_id) references public.media_assets (id, user_id) on delete cascade
);
create index timeline_clips_project_idx on public.timeline_clips (project_id, track, sort_order);
create index timeline_clips_asset_idx on public.timeline_clips (asset_id);

-- ---------------------------------------------------------------------------
-- Caption segments
-- ---------------------------------------------------------------------------
create table public.caption_segments (
  id uuid primary key,
  project_id uuid not null,
  user_id uuid not null,
  start_ms integer not null check (start_ms >= 0),
  end_ms integer not null,
  text text not null check (char_length(text) between 1 and 500),
  words jsonb,
  timing_source text not null default 'estimated' check (timing_source in ('estimated', 'aligned', 'imported', 'manual')),
  created_at timestamptz not null default now(),
  check (end_ms > start_ms),
  foreign key (project_id, user_id) references public.projects (id, user_id) on delete cascade
);
create index caption_segments_project_idx on public.caption_segments (project_id, start_ms);

-- ---------------------------------------------------------------------------
-- Render jobs
-- ---------------------------------------------------------------------------
create table public.render_jobs (
  id uuid primary key default gen_random_uuid(),
  project_id uuid not null,
  user_id uuid not null,
  status text not null default 'queued' check (status in ('queued', 'processing', 'completed', 'failed', 'cancelled')),
  profile text not null default 'full' check (profile in ('full', 'preview')),
  attempt integer not null default 0 check (attempt >= 0),
  max_attempts integer not null default 3,
  progress real check (progress is null or (progress >= 0 and progress <= 1)),
  idempotency_key text check (idempotency_key is null or char_length(idempotency_key) <= 100),
  input_snapshot jsonb not null,
  output_path text,
  output_size_bytes bigint,
  output_duration_ms integer,
  thumbnail_path text,
  error_category text check (error_category is null or error_category in ('validation', 'media', 'render', 'storage', 'timeout', 'cancelled', 'internal')),
  error_message text,
  error_detail text,
  cancel_requested boolean not null default false,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  completed_at timestamptz,
  heartbeat_at timestamptz,
  updated_at timestamptz not null default now(),
  foreign key (project_id, user_id) references public.projects (id, user_id) on delete cascade
);
create index render_jobs_project_idx on public.render_jobs (project_id, created_at desc);
create index render_jobs_status_idx on public.render_jobs (status, updated_at);
-- At most one active render per project: duplicate requests reuse the active job.
create unique index render_jobs_one_active_per_project on public.render_jobs (project_id)
  where status in ('queued', 'processing');
create unique index render_jobs_idempotency on public.render_jobs (user_id, idempotency_key)
  where idempotency_key is not null;
create trigger render_jobs_updated_at before update on public.render_jobs
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Usage events (append-only accounting; no money is charged in the MVP)
-- ---------------------------------------------------------------------------
create table public.usage_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  kind text not null check (kind in ('script_generation', 'voice_seconds', 'storage_bytes', 'render_seconds', 'export')),
  quantity numeric not null,
  unit text not null,
  project_id uuid references public.projects (id) on delete set null,
  render_job_id uuid references public.render_jobs (id) on delete set null,
  created_at timestamptz not null default now()
);
create index usage_events_user_kind_idx on public.usage_events (user_id, kind, created_at desc);

-- ---------------------------------------------------------------------------
-- Row Level Security
-- ---------------------------------------------------------------------------
alter table public.profiles enable row level security;
alter table public.projects enable row level security;
alter table public.media_assets enable row level security;
alter table public.timeline_clips enable row level security;
alter table public.caption_segments enable row level security;
alter table public.render_jobs enable row level security;
alter table public.usage_events enable row level security;

create policy profiles_select_own on public.profiles for select to authenticated using (id = (select auth.uid()));
create policy profiles_update_own on public.profiles for update to authenticated using (id = (select auth.uid())) with check (id = (select auth.uid()));

create policy projects_all_own on public.projects for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create policy media_select_own on public.media_assets for select to authenticated using (user_id = (select auth.uid()));
create policy media_insert_own on public.media_assets for insert to authenticated with check (user_id = (select auth.uid()));
create policy media_update_own on public.media_assets for update to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));
create policy media_delete_own on public.media_assets for delete to authenticated using (user_id = (select auth.uid()));

create policy clips_all_own on public.timeline_clips for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

create policy captions_all_own on public.caption_segments for all to authenticated
  using (user_id = (select auth.uid())) with check (user_id = (select auth.uid()));

-- Users can read their jobs and request new ones; status changes are made by the worker (service role).
create policy renders_select_own on public.render_jobs for select to authenticated using (user_id = (select auth.uid()));
create policy renders_insert_own on public.render_jobs for insert to authenticated
  with check (user_id = (select auth.uid()) and status = 'queued');

create policy usage_select_own on public.usage_events for select to authenticated using (user_id = (select auth.uid()));

grant usage on schema public to authenticated;
grant select, insert, update, delete on public.projects, public.media_assets, public.timeline_clips, public.caption_segments to authenticated;
grant select, update on public.profiles to authenticated;
grant select, insert on public.render_jobs to authenticated;
grant select on public.usage_events to authenticated;

-- ---------------------------------------------------------------------------
-- Private storage bucket (Supabase only). Server uses the service role; no client policies.
-- ---------------------------------------------------------------------------
do $$
begin
  if exists (select 1 from information_schema.schemata where schema_name = 'storage')
     and exists (select 1 from information_schema.tables where table_schema = 'storage' and table_name = 'buckets') then
    insert into storage.buckets (id, name, public, file_size_limit)
    values ('clipforge-media', 'clipforge-media', false, 524288000)
    on conflict (id) do nothing;
  end if;
end;
$$;
