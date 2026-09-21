import { neon } from "@neondatabase/serverless";
import type { ExternalSyncPayload } from "./schemas";
import type { SyncSnapshot } from "./types";

let memorySnapshot: SyncSnapshot | null = null;

export async function saveSnapshot(snapshot: SyncSnapshot) {
  memorySnapshot = snapshot;
  if (!process.env.DATABASE_URL) return { persisted: false, adapter: "memory" };
  const sql = neon(process.env.DATABASE_URL);
  await sql`insert into sync_snapshots (id, season, week, status, payload, created_at)
    values (${snapshot.id}, ${snapshot.season}, ${snapshot.week}, ${snapshot.health}, ${JSON.stringify(snapshot)}::jsonb, ${snapshot.generatedAt})
    on conflict (id) do update set payload = excluded.payload, status = excluded.status`;
  return { persisted: true, adapter: "neon" };
}

export async function getLatestSnapshot(): Promise<SyncSnapshot | null> {
  if (!process.env.DATABASE_URL) return memorySnapshot;
  try {
    const sql = neon(process.env.DATABASE_URL);
    const rows = await sql`select payload from sync_snapshots order by created_at desc limit 1`;
    return (rows[0]?.payload as SyncSnapshot | undefined) ?? null;
  } catch { return memorySnapshot; }
}

export async function saveExternalIngest(payload: ExternalSyncPayload) {
  if (!process.env.DATABASE_URL) return { persisted: false, adapter: "memory" };
  const sql = neon(process.env.DATABASE_URL);
  await sql`insert into external_ingest_events (source, season, week, payload, source_timestamp)
    values (${payload.source}, ${payload.league.season}, ${payload.league.week}, ${JSON.stringify(payload)}::jsonb, ${payload.sourceTimestamp})`;
  return { persisted: true, adapter: "neon" };
}

export async function getLatestExternalIngest(): Promise<unknown | null> {
  if (!process.env.DATABASE_URL) return null;
  try {
    const sql = neon(process.env.DATABASE_URL);
    const rows = await sql`select payload from external_ingest_events order by fetched_at desc limit 1`;
    return rows[0]?.payload ?? null;
  } catch { return null; }
}
