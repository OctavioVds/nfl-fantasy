create table if not exists flaim_connections (
  id text primary key,
  encrypted_payload text not null,
  connected_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
