import { randomUUID } from "node:crypto";
import { captureServerEvent } from "./analytics";
import { saveSnapshot } from "./db";
import { aggregateProjections, canonicalPlayerId, simulateWin, topLineupRecommendations } from "./engine";
import { fallbackSnapshot } from "./fallback-data";
import { fetchEspnScoreboard } from "./providers/espn";
import { fetchSleeperTrending } from "./providers/sleeper";
import type { ExternalSyncPayload } from "./schemas";
import { isPlayerLocked, isStale, nflPeriod } from "./time";
import type { AgentRun, RosterPlayer, SyncSnapshot } from "./types";

type AgentResult = { name: string; data: unknown; run: AgentRun };

async function runAgent(name: string, fn: () => Promise<unknown>): Promise<AgentResult> {
  const started = Date.now();
  try { return { name, data: await fn(), run: { name, status: "ok", latencyMs: Date.now() - started, cacheHit: false } }; }
  catch (error) { return { name, data: null, run: { name, status: "failed", latencyMs: Date.now() - started, cacheHit: false, message: error instanceof Error ? error.message : "Provider error" } }; }
}

export async function synchronize(external?: ExternalSyncPayload): Promise<SyncSnapshot> {
  const started = new Date();
  const period = external ? { season: external.league.season, week: external.league.week } : nflPeriod(started);
  await captureServerEvent("sync_started", period);

  const firstWave = await Promise.all([
    runAgent("LeagueIntelligence", async () => external ?? null),
    runAgent("Schedule", () => fetchEspnScoreboard(period.season, period.week)),
    runAgent("WaiverMarket", () => fetchSleeperTrending()),
    runAgent("Injuries", async () => []),
    runAgent("ProjectionEnsemble", async () => external?.roster ?? []),
    runAgent("BreakingNews", async () => []),
  ]);
  const league = external;
  if (!league) {
    const base = fallbackSnapshot();
    base.id = randomUUID();
    base.generatedAt = started.toISOString();
    base.agents = firstWave.map((r) => r.run);
    base.health = "DEGRADED";
    base.freshness = "STALE";
    base.warnings.unshift("Sin fuente de liga actual: Sync conservó el último contexto conocido y bloqueó recomendaciones accionables.");
    await saveSnapshot(base);
    await captureServerEvent("sync_completed", { ...period, degraded: true });
    return base;
  }

  const roster: RosterPlayer[] = league.roster.map((p) => ({
    canonicalPlayerId: canonicalPlayerId(p.name, p.team), name: p.name, team: p.team, position: p.position,
    slot: p.slot, projection: p.projection, kickoff: p.kickoff, locked: isPlayerLocked(p.kickoff), injury: p.injury,
  }));
  const projectionGroups = new Map<string, ReturnType<typeof aggregateProjections>>();
  for (const p of roster) if (p.projection != null) projectionGroups.set(p.canonicalPlayerId, aggregateProjections([{ canonicalPlayerId: p.canonicalPlayerId, name: p.name, team: p.team, position: p.position, source: league.source, points: p.projection, sourceTimestamp: league.sourceTimestamp }]));
  for (const p of roster) { const agg = projectionGroups.get(p.canonicalPlayerId); if (agg) { p.projection = agg.median; p.floor = agg.floor; p.ceiling = agg.ceiling; } }

  const secondWave = await Promise.all([
    runAgent("LineupOptimization", async () => topLineupRecommendations(roster)),
    runAgent("OpponentScout", async () => league.opponentProjection ?? null),
    runAgent("TradeFinder", async () => []),
    runAgent("BreakoutDetection", async () => []),
    runAgent("RestOfSeason", async () => []),
    runAgent("DefenseStreaming", async () => []),
    runAgent("KickerStreaming", async () => []),
  ]);
  const lineupActions = (secondWave.find((r) => r.name === "LineupOptimization")?.data ?? []) as ReturnType<typeof topLineupRecommendations>;
  const projectedScore = roster.filter((p) => !["Bench", "IR"].includes(p.slot)).reduce((sum, p) => sum + (p.projection ?? 0), 0);
  const opp = league.opponentProjection ?? null;
  const stale = isStale(league.sourceTimestamp, 30 * 60_000, started);
  const failed = [...firstWave, ...secondWave].filter((r) => r.run.status === "failed");
  const snapshot: SyncSnapshot = {
    id: randomUUID(), season: period.season, week: period.week, leagueName: league.league.name,
    generatedAt: started.toISOString(), dataAsOf: league.sourceTimestamp,
    freshness: stale ? "STALE" : failed.length ? "DEGRADED" : "FRESH",
    health: failed.length ? "DEGRADED" : "HEALTHY",
    projectedScore: Math.round(projectedScore * 10) / 10, opponentScore: opp,
    winProbability: opp == null ? null : simulateWin(projectedScore, opp),
    roster, recommendations: lineupActions, agents: [...firstWave, ...secondWave].map((r) => r.run),
    sources: [{ name: league.source, sourceTimestamp: league.sourceTimestamp, fetchedAt: started.toISOString(), season: period.season, week: period.week, gameStatus: "unknown" }],
    warnings: [...(stale ? ["STALE DATA WARNING: la fuente de liga supera 30 minutos."] : []), ...(failed.length ? [`DEGRADED DATA: ${failed.map((r) => r.name).join(", ")}.`] : [])],
  };
  await saveSnapshot(snapshot);
  await captureServerEvent("sync_completed", { ...period, degraded: failed.length > 0, latency_ms: Date.now() - started.getTime() });
  return snapshot;
}
