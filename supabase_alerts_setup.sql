create extension if not exists pgcrypto;

create table if not exists public.admin_alerts (
  id uuid primary key default gen_random_uuid(),
  source_id text unique,
  title text not null default 'Emergency alert',
  message text not null default '',
  disaster_type text not null default 'General',
  severity text not null default 'High',
  active boolean not null default true,
  sent_by text not null default '',
  created_at timestamptz not null default now()
);

create index if not exists admin_alerts_created_at_idx
  on public.admin_alerts (created_at desc);

create table if not exists public.device_tokens (
  id uuid primary key default gen_random_uuid(),
  token text not null unique,
  platform text not null default 'mobile',
  device_label text not null default '',
  is_active boolean not null default true,
  last_seen_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);

create index if not exists device_tokens_active_idx
  on public.device_tokens (is_active, last_seen_at desc);

alter table public.admin_alerts enable row level security;
alter table public.device_tokens enable row level security;

drop policy if exists "admin_alerts_read_all" on public.admin_alerts;
create policy "admin_alerts_read_all"
  on public.admin_alerts
  for select
  to anon, authenticated
  using (true);

drop policy if exists "device_tokens_upsert_anon" on public.device_tokens;
create policy "device_tokens_upsert_anon"
  on public.device_tokens
  for insert
  to anon, authenticated
  with check (true);

drop policy if exists "device_tokens_update_anon" on public.device_tokens;
create policy "device_tokens_update_anon"
  on public.device_tokens
  for update
  to anon, authenticated
  using (true)
  with check (true);
