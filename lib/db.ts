import { createHash } from "node:crypto";
import { neon } from "@neondatabase/serverless";
import type { ExternalSyncPayload } from "./schemas";
import type { SyncSnapshot } from "./types";
import { isStale, nflPeriod } from "./time";
import { leagueDataVersion } from "./data-version";

let memorySnapshot: SyncSnapshot | null = null;
let memoryExternalIngest: ExternalSyncPayload | null = null;

export async function saveSnapshot(snapshot: SyncSnapshot) {
  memorySnapshot = snapshot;
  if (!process.env.DATABASE_URL) return { persisted: false, adapter: "memory" };
  const sql = neon(process.env.DATABASE_URL);
  await sql`insert into sync_snapshots (id, season, week, status, payload, created_at)
    values (${snapshot.id}, ${snapshot.season}, ${snapshot.week}, ${snapshot.health}, ${JSON.stringify(snapshot)}::jsonb, ${snapshot.generatedAt})
    on conflict (id) do update set payload = excluded.payload, status = excluded.status`;
  let extendedPersistence = false;
  try {
    await sql`insert into sync_runs (id, season, week, status, data_updated_at, data_version, payload, started_at, completed_at)
      values (${snapshot.syncRunId ?? snapshot.id}, ${snapshot.season}, ${snapshot.week}, ${snapshot.health}, ${snapshot.dataUpdatedAt ?? null}, ${snapshot.dataVersion ?? null}, ${JSON.stringify(snapshot)}::jsonb, ${snapshot.generatedAt}, ${snapshot.generatedAt})
      on conflict (id) do update set status = excluded.status, data_updated_at = excluded.data_updated_at, data_version = excluded.data_version, payload = excluded.payload, completed_at = excluded.completed_at`;
    for (const agent of snapshot.agents) {
      const providerStatus = agent.status === "ok" ? "LIVE" : agent.status === "cached" ? "STALE" : agent.status === "missing_credentials" ? "MISSING CREDENTIALS" : agent.status === "failed" ? "FAILED" : "DEGRADED";
      await sql`insert into agent_runs (sync_run_id, provider, status, latency_ms, fetched_at, payload)
        values (${snapshot.syncRunId ?? snapshot.id}, ${agent.name}, ${agent.status}, ${agent.latencyMs}, ${agent.fetchedAt ?? null}, ${JSON.stringify(agent)}::jsonb)
        on conflict (sync_run_id, provider) do update set status = excluded.status, latency_ms = excluded.latency_ms, fetched_at = excluded.fetched_at, payload = excluded.payload`;
      await sql`insert into provider_health (provider, status, last_success, last_failure, latency_ms, freshness)
        values (${agent.name}, ${providerStatus}, ${agent.status === "ok" ? agent.fetchedAt ?? null : null}, ${["failed", "missing_credentials", "degraded"].includes(agent.status) ? agent.fetchedAt ?? null : null}, ${agent.latencyMs}, ${JSON.stringify({ mode: agent.mode, records: agent.records, fetchedAt: agent.fetchedAt })}::jsonb)
        on conflict (provider) do update set status = excluded.status, last_success = coalesce(excluded.last_success, provider_health.last_success), last_failure = coalesce(excluded.last_failure, provider_health.last_failure), latency_ms = excluded.latency_ms, freshness = excluded.freshness`;
    }
    await sql`insert into roster_snapshots (sync_run_id, source, season, week, payload, data_version, source_timestamp, fetched_at)
    values (${snapshot.syncRunId ?? snapshot.id}, ${snapshot.sources[0]?.name ?? "unknown"}, ${snapshot.season}, ${snapshot.week}, ${JSON.stringify(snapshot.roster)}::jsonb, ${snapshot.dataVersion ?? null}, ${snapshot.dataUpdatedAt ?? null}, ${snapshot.dataFetchedAt ?? snapshot.generatedAt})
    on conflict (sync_run_id) do update set payload = excluded.payload, data_version = excluded.data_version, source_timestamp = excluded.source_timestamp, fetched_at = excluded.fetched_at`;
    for (const recommendation of snapshot.recommendations) {
      await sql`insert into recommendations (sync_run_id, recommendation_id, kind, payload)
        values (${snapshot.syncRunId ?? snapshot.id}, ${recommendation.id}, ${recommendation.kind}, ${JSON.stringify(recommendation)}::jsonb)
        on conflict (sync_run_id, recommendation_id) do update set payload = excluded.payload`;
    }
    await sql`insert into decision_snapshots (sync_run_id, payload, created_at)
      values (${snapshot.syncRunId ?? snapshot.id}, ${JSON.stringify(snapshot)}::jsonb, ${snapshot.generatedAt})
      on conflict (sync_run_id) do update set payload = excluded.payload, created_at = excluded.created_at`;
    const projectionSource = snapshot.sources[0]?.name ?? "unknown";
    for (const player of snapshot.roster) {
      await sql`insert into players (canonical_player_id, display_name, team, position)
      values (${player.canonicalPlayerId}, ${player.name}, ${player.team}, ${player.position})
      on conflict (canonical_player_id) do update set display_name = excluded.display_name, team = excluded.team, position = excluded.position, updated_at = now()`;
      const identitySeparator = player.canonicalPlayerId.indexOf(":");
      if (identitySeparator > 0) {
        await sql`insert into player_id_map (provider, provider_player_id, canonical_player_id, confidence)
          values (${player.canonicalPlayerId.slice(0, identitySeparator)}, ${player.canonicalPlayerId.slice(identitySeparator + 1)}, ${player.canonicalPlayerId}, 1)
          on conflict (provider, provider_player_id) do update set canonical_player_id = excluded.canonical_player_id, confidence = excluded.confidence, updated_at = now()`;
      }
      if (player.projection != null) {
        await sql`insert into projections_by_source (sync_run_id, canonical_player_id, provider, season, week, scoring, projection, source_timestamp, fetched_at)
        values (${snapshot.syncRunId ?? snapshot.id}, ${player.canonicalPlayerId}, ${projectionSource}, ${snapshot.season}, ${snapshot.week}, ${JSON.stringify({ label: snapshot.scoringLabel ?? null })}::jsonb, ${player.projection}, ${snapshot.dataUpdatedAt ?? null}, ${snapshot.dataFetchedAt ?? snapshot.generatedAt})
        on conflict (sync_run_id, canonical_player_id, provider) do update set projection = excluded.projection, source_timestamp = excluded.source_timestamp, fetched_at = excluded.fetched_at`;
      }
      if (player.decisionProfile) {
        await sql`insert into projection_snapshots (sync_run_id, canonical_player_id, season, week, floor, median, ceiling, confidence, payload)
        values (${snapshot.syncRunId ?? snapshot.id}, ${player.canonicalPlayerId}, ${snapshot.season}, ${snapshot.week}, ${player.decisionProfile.floor}, ${player.decisionProfile.median}, ${player.decisionProfile.ceiling}, ${player.decisionProfile.confidence / 100}, ${JSON.stringify(player.decisionProfile)}::jsonb)
        on conflict (sync_run_id, canonical_player_id) do update set floor = excluded.floor, median = excluded.median, ceiling = excluded.ceiling, confidence = excluded.confidence, payload = excluded.payload`;
      }
    }
    await sql`insert into league_snapshots (sync_run_id, source, season, week, data_version, payload, source_timestamp, fetched_at)
      values (${snapshot.syncRunId ?? snapshot.id}, ${projectionSource}, ${snapshot.season}, ${snapshot.week}, ${snapshot.dataVersion ?? null}, ${JSON.stringify({ leagueName: snapshot.leagueName, teamRecord: snapshot.teamRecord, opponentName: snapshot.opponentName, pendingMoves: snapshot.pendingMoves })}::jsonb, ${snapshot.dataUpdatedAt ?? null}, ${snapshot.dataFetchedAt ?? snapshot.generatedAt})
      on conflict (sync_run_id) do update set data_version = excluded.data_version, payload = excluded.payload, source_timestamp = excluded.source_timestamp, fetched_at = excluded.fetched_at`;
    extendedPersistence = true;
  } catch (error) {
    console.error(JSON.stringify({ event: "decision_schema_not_ready", errorName: error instanceof Error ? error.name : "UnknownError" }));
  }
  return { persisted: true, adapter: "neon", extendedPersistence };
}

export async function getLatestSnapshot(): Promise<SyncSnapshot | null> {
  if (!process.env.DATABASE_URL) return memorySnapshot;
  try {
    const sql = neon(process.env.DATABASE_URL);
    const rows = await sql`select payload from sync_snapshots order by created_at desc limit 1`;
    return (rows[0]?.payload as SyncSnapshot | undefined) ?? null;
  } catch { return memorySnapshot; }
}

export async function saveExternalIngest(payload: ExternalSyncPayload, syncRunId?: string) {
  const { season, week } = nflPeriod(new Date());
  const current = payload.league.season === season && payload.league.week === week && !isStale(payload.sourceTimestamp, 24 * 60 * 60 * 1000);
  if (current) memoryExternalIngest = payload;
  if (!process.env.DATABASE_URL) return { persisted: false, adapter: "memory", currentState: current };
  const sql = neon(process.env.DATABASE_URL);
  try {
    await sql`insert into external_ingest_events (source, season, week, payload, source_timestamp, sync_run_id)
      values (${payload.source}, ${payload.league.season}, ${payload.league.week}, ${JSON.stringify(payload)}::jsonb, ${payload.sourceTimestamp}, ${syncRunId ?? null})`;
  } catch {
    await sql`insert into external_ingest_events (source, season, week, payload, source_timestamp)
      values (${payload.source}, ${payload.league.season}, ${payload.league.week}, ${JSON.stringify(payload)}::jsonb, ${payload.sourceTimestamp})`;
  }
  const version = leagueDataVersion(payload);
  const scopeKey = createHash("sha256").update(`${payload.source}|${payload.league.leagueId ?? payload.league.name}|${payload.league.season}`).digest("hex");
  if (current) {
    try {
      await sql`insert into current_league_state (scope_key, source, league_id, season, week, data_version, source_timestamp, fetched_at, payload)
      values (${scopeKey}, ${payload.source}, ${payload.league.leagueId ?? null}, ${payload.league.season}, ${payload.league.week}, ${version}, ${payload.sourceTimestamp}, ${payload.fetchedAt ?? new Date().toISOString()}, ${JSON.stringify(payload)}::jsonb)
      on conflict (scope_key) do update set week = excluded.week, data_version = excluded.data_version, source_timestamp = excluded.source_timestamp, fetched_at = excluded.fetched_at, payload = excluded.payload
      where excluded.fetched_at >= current_league_state.fetched_at`;
    } catch (error) {
      console.error(JSON.stringify({ event: "current_league_state_not_ready", errorName: error instanceof Error ? error.name : "UnknownError" }));
    }
  }
  return { persisted: true, adapter: "neon", currentState: current };
}

export async function getLatestExternalIngest(): Promise<unknown | null> {
  if (!process.env.DATABASE_URL) return memoryExternalIngest;
  try {
    const sql = neon(process.env.DATABASE_URL);
    const rows = await sql`select payload from current_league_state order by fetched_at desc limit 1`;
    if (rows[0]?.payload) return rows[0].payload;
  } catch { /* Use the pre-002 event table during a rolling migration. */ }
  try {
    const sql = neon(process.env.DATABASE_URL);
    const rows = await sql`select payload from external_ingest_events order by fetched_at desc limit 1`;
    return rows[0]?.payload ?? null;
  } catch { return memoryExternalIngest; }
}
