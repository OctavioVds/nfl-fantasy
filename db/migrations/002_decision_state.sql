create table if not exists schema_migrations (
  version text primary key,
  applied_at timestamptz not null default now()
);

create table if not exists sync_runs (
  id uuid primary key,
  season integer not null,
  week integer not null,
  status text not null,
  data_updated_at timestamptz,
  data_version text,
  payload jsonb not null,
  started_at timestamptz not null,
  completed_at timestamptz
);
create index if not exists sync_runs_completed_at_idx on sync_runs (completed_at desc);
create table if not exists agent_runs (
  sync_run_id uuid not null references sync_runs(id) on delete cascade,
  provider text not null,
  status text not null,
  latency_ms integer not null,
  fetched_at timestamptz,
  payload jsonb not null,
  primary key (sync_run_id, provider)
);

create table if not exists current_league_state (
  scope_key text primary key,
  source text not null,
  league_id text,
  season integer not null,
  week integer not null,
  data_version text not null,
  source_timestamp timestamptz not null,
  fetched_at timestamptz not null,
  payload jsonb not null
);
create index if not exists current_league_state_fetched_at_idx on current_league_state (fetched_at desc);
alter table external_ingest_events add column if not exists sync_run_id uuid;

create table if not exists league_snapshots (
  sync_run_id uuid primary key references sync_runs(id) on delete cascade,
  source text not null,
  season integer not null,
  week integer not null,
  data_version text,
  payload jsonb not null,
  source_timestamp timestamptz,
  fetched_at timestamptz not null
);

create table if not exists roster_snapshots (
  sync_run_id uuid primary key references sync_runs(id) on delete cascade,
  source text not null,
  season integer not null,
  week integer not null,
  payload jsonb not null,
  data_version text,
  source_timestamp timestamptz,
  fetched_at timestamptz not null
);

create table if not exists players (
  canonical_player_id text primary key,
  display_name text not null,
  team text,
  position text,
  updated_at timestamptz not null default now()
);
create table if not exists player_id_map (
  provider text not null,
  provider_player_id text not null,
  canonical_player_id text not null references players(canonical_player_id),
  confidence numeric(5,4),
  updated_at timestamptz not null default now(),
  primary key (provider, provider_player_id)
);

create table if not exists projections_by_source (
  sync_run_id uuid not null references sync_runs(id) on delete cascade,
  canonical_player_id text not null,
  provider text not null,
  season integer not null,
  week integer not null,
  scoring jsonb,
  projection numeric not null,
  provider_confidence numeric(5,4),
  source_timestamp timestamptz,
  fetched_at timestamptz not null,
  primary key (sync_run_id, canonical_player_id, provider)
);
create table if not exists projection_snapshots (
  sync_run_id uuid not null references sync_runs(id) on delete cascade,
  canonical_player_id text not null,
  season integer not null,
  week integer not null,
  floor numeric,
  median numeric,
  ceiling numeric,
  confidence numeric(5,4),
  payload jsonb not null,
  primary key (sync_run_id, canonical_player_id)
);

create table if not exists recommendations (
  sync_run_id uuid not null references sync_runs(id) on delete cascade,
  recommendation_id text not null,
  kind text not null,
  payload jsonb not null,
  primary key (sync_run_id, recommendation_id)
);
create table if not exists decision_snapshots (
  sync_run_id uuid primary key references sync_runs(id) on delete cascade,
  payload jsonb not null,
  created_at timestamptz not null default now()
);
create table if not exists waiver_claims (
  sync_run_id uuid not null references sync_runs(id) on delete cascade,
  provider_claim_id text not null,
  status text not null,
  payload jsonb not null,
  primary key (sync_run_id, provider_claim_id)
);

create table if not exists actuals (
  canonical_player_id text not null,
  season integer not null,
  week integer not null,
  scoring jsonb not null,
  actual_points numeric not null,
  provider text not null,
  source_timestamp timestamptz,
  fetched_at timestamptz not null,
  primary key (canonical_player_id, season, week, scoring)
);
create table if not exists accuracy_metrics (
  provider text not null,
  position text not null,
  season integer not null,
  week integer not null,
  sample_size integer not null,
  mae numeric,
  rmse numeric,
  bias numeric,
  calibration jsonb not null default '{}'::jsonb,
  calculated_at timestamptz not null default now(),
  primary key (provider, position, season, week)
);
