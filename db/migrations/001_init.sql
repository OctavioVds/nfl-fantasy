create table if not exists sync_snapshots (
  id uuid primary key,
  season integer not null,
  week integer not null,
  status text not null,
  payload jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists sync_snapshots_created_at_idx on sync_snapshots (created_at desc);

create table if not exists provider_health (
  provider text primary key,
  status text not null,
  last_success timestamptz,
  last_failure timestamptz,
  latency_ms integer,
  freshness jsonb not null default '{}'::jsonb
);

create table if not exists external_ingest_events (
  id bigserial primary key,
  source text not null,
  season integer not null,
  week integer not null,
  payload jsonb not null,
  source_timestamp timestamptz not null,
  fetched_at timestamptz not null default now()
);
