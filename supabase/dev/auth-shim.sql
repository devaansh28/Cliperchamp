-- DEVELOPMENT/TEST ONLY. Never apply to a Supabase project.
-- Recreates the small part of Supabase's auth schema our migrations rely on,
-- so migrations and RLS policies can run on a plain PostgreSQL server.

create schema if not exists auth;

create table if not exists auth.users (
  id uuid primary key default gen_random_uuid(),
  email text unique,
  created_at timestamptz not null default now()
);

-- Same contract as Supabase: the user id comes from the request's JWT claims.
create or replace function auth.uid() returns uuid
language sql stable as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated nologin noinherit; end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role nologin noinherit bypassrls; end if;
end;
$$;

grant usage on schema auth to authenticated, anon;
grant execute on function auth.uid() to authenticated, anon;
-- Let the connecting (owner) role switch into "authenticated", as Supabase's postgres role can.
do $$ begin execute format('grant authenticated to %I', current_user); end; $$;
