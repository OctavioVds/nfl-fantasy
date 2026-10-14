create table if not exists core_inputs (
 scope text primary key, payload jsonb not null, updated_at timestamptz not null default now()
);
create table if not exists model_registry (
 version text primary key, scoring_hash text not null, feature_version text not null,
 trained_at timestamptz not null, training_cutoff timestamptz not null, payload jsonb not null
);
create index if not exists model_registry_scoring_idx on model_registry (scoring_hash, trained_at desc);
create table if not exists core_runs (
 run_id text primary key, scope text not null, season integer not null, week integer not null,
 input_digest text not null, model_version text, status text not null, payload jsonb not null,
 created_at timestamptz not null default now()
);
create index if not exists core_runs_scope_latest_idx on core_runs (scope, season, week, created_at desc);
create table if not exists features (
 scope text not null, entity_id text not null, season integer not null, week integer not null,
 name text not null, value double precision, source text not null, as_of timestamptz not null,
 fetched_at timestamptz not null, version text not null, estimated boolean not null,
 method text, reason text, primary key (scope,entity_id,season,week,name,source,as_of,version),
 check (value is not null or reason is not null), check (not estimated or method is not null)
);
create index if not exists features_training_idx on features (scope,season,week,as_of);
create table if not exists player_roles (
 scope text not null, player_id text not null, season integer not null, week integer not null,
 as_of timestamptz not null, payload jsonb not null, primary key (scope,player_id,season,week,as_of)
);
create table if not exists teammate_splits (
 scope text not null, a_id text not null, b_id text not null, metric text not null,
 as_of timestamptz not null, payload jsonb not null, primary key(scope,a_id,b_id,metric,as_of)
);
create table if not exists availability_scenarios (
 scope text not null, season integer not null, week integer not null, team_id text not null,
 scenario text not null, probability double precision not null check(probability between 0 and 1),
 as_of timestamptz not null, payload jsonb not null, primary key(scope,season,week,team_id,scenario,as_of)
);
create table if not exists player_projections (
 run_id text not null references core_runs(run_id), scope text not null, player_id text not null,
 season integer not null, week integer not null, scenario text not null,
 mean double precision, sd double precision check(sd>=0), p10 double precision, p50 double precision,
 p90 double precision, prob_play double precision check(prob_play between 0 and 1), confidence double precision check(confidence between 0 and 100),
 model_version text, created_at timestamptz not null, payload jsonb not null,
 primary key(run_id,player_id,scenario), check(p10 is null or p50 is null or p10<=p50), check(p50 is null or p90 is null or p50<=p90)
);
create index if not exists player_projections_lookup_idx on player_projections(scope,season,week,player_id,scenario,created_at desc);
create table if not exists defense_adjusted (
 scope text not null, season integer not null, week integer not null, team_id text not null,
 position text not null, alignment text not null, as_of timestamptz not null, payload jsonb not null,
 primary key(scope,season,week,team_id,position,alignment,as_of)
);
create table if not exists waiver_anomalies (
 run_id text not null references core_runs(run_id), player_id text not null, signal text not null,
 strength double precision not null check(strength between 0 and 100), payload jsonb not null,
 primary key(run_id,player_id,signal)
);
create table if not exists social_signals (
 scope text not null, signal_id text not null, ts timestamptz not null, payload jsonb not null,
 primary key(scope,signal_id)
);
create table if not exists source_policies (
 scope text not null, source_id text not null, version text not null, payload jsonb not null,
 primary key(scope,source_id,version)
);
create table if not exists backtest_results (
 model_version text not null references model_registry(version), scoring_hash text not null,
 season integer not null, week integer not null, position text not null, sample_size integer not null,
 mae double precision, rmse double precision, coverage double precision, payload jsonb not null,
 primary key(model_version,scoring_hash,season,week,position)
);
create table if not exists data_quality_log (
 run_id text not null references core_runs(run_id), issue_key text not null, payload jsonb not null,
 primary key(run_id,issue_key)
);
create table if not exists core_training_examples (id text primary key, payload jsonb not null);
