import { randomUUID } from "node:crypto";
import { captureServerEvent } from "./analytics";
import { getLatestExternalIngest, saveExternalIngest, saveSnapshot } from "./db";
import { aggregateProjections, canonicalPlayerId, optimizeLineup, rosterManagementRecommendations, simulateWin, topLineupRecommendations, tradeRecommendations, waiverRecommendations } from "./engine";
import { fallbackSnapshot } from "./fallback-data";
import { fetchEspnScoreboard, mapEspnTeamContexts } from "./providers/espn";
import { fetchSleeperTrending } from "./providers/sleeper";
import { fetchSportsDataIoProjections } from "./providers/sportsdataio";
import { fetchStatsHawkContext } from "./providers/statshawk";
import type { ExternalSyncPayload } from "./schemas";
import { externalSyncSchema } from "./schemas";
import { isPlayerLocked, isStale, nflPeriod } from "./time";
import type { AgentRun, RosterPlayer, SyncSnapshot, TradePartner } from "./types";

type AgentResult = { name: string; data: unknown; run: AgentRun };

async function runAgent(name: string, fn: () => Promise<unknown>): Promise<AgentResult> {
  const started = Date.now();
  try { return { name, data: await fn(), run: { name, status: "ok", latencyMs: Date.now() - started, cacheHit: false } }; }
  catch (error) { return { name, data: null, run: { name, status: "failed", latencyMs: Date.now() - started, cacheHit: false, message: error instanceof Error ? error.message : "Provider error" } }; }
}

export async function synchronize(external?: ExternalSyncPayload): Promise<SyncSnapshot> {
  const started = new Date();
  let league = external;
  if (external) await saveExternalIngest(external);
  else {
    const stored = externalSyncSchema.safeParse(await getLatestExternalIngest());
    if (stored.success) league = stored.data;
  }
  const period = league ? { season: league.league.season, week: league.league.week } : nflPeriod(started);
  await captureServerEvent("sync_started", period);

  const firstWave = await Promise.all([
    runAgent("LeagueIntelligence", async () => league ?? null),
    runAgent("Schedule", () => fetchEspnScoreboard(period.season, period.week)),
    runAgent("WaiverMarket", () => fetchSleeperTrending()),
    runAgent("Injuries", async () => []),
    runAgent("ProjectionEnsemble", async () => league?.roster ?? []),
    runAgent("SportsDataIO", () => fetchSportsDataIoProjections(period.season, period.week)),
    runAgent("StatsHawk", () => fetchStatsHawkContext(period.season)),
    runAgent("BreakingNews", async () => []),
  ]);
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

  const scheduleEvents = (firstWave.find((r) => r.name === "Schedule")?.data ?? []) as unknown[];
  const scheduleByTeam = mapEspnTeamContexts(scheduleEvents);
  const roster: RosterPlayer[] = league.roster.map((p) => {
    const game = scheduleByTeam.get(p.team.toUpperCase());
    const kickoff = p.kickoff ?? game?.kickoff;
    return ({
    canonicalPlayerId: canonicalPlayerId(p.name, p.team), name: p.name, team: p.team, position: p.position,
    slot: p.slot, projection: p.projection, futureProjection: p.futureProjection, opportunityScore: p.opportunityScore,
    depthOrder: p.depthOrder, kickoff, opponent: game?.opponent, homeAway: game?.homeAway, venue: game?.venue,
    weather: game?.weather, locked: isPlayerLocked(kickoff), injury: p.injury,
  }); });
  const sportsData = (firstWave.find((r) => r.name === "SportsDataIO")?.data ?? []) as Awaited<ReturnType<typeof fetchSportsDataIoProjections>>;
  const sportsById = new Map(sportsData.map((p) => [canonicalPlayerId(p.name, p.team), p]));
  const sportsDefenseByTeam = new Map(sportsData.filter((p) => p.position === "DST").map((p) => [p.team.toUpperCase(), p]));
  const projectionGroups = new Map<string, ReturnType<typeof aggregateProjections>>();
  for (const p of roster) {
    const projections = [];
    if (p.projection != null) projections.push({ canonicalPlayerId: p.canonicalPlayerId, name: p.name, team: p.team, position: p.position, source: league.source, points: p.projection, sourceTimestamp: league.sourceTimestamp });
    const sports = p.position === "DST" ? sportsDefenseByTeam.get(p.team.toUpperCase()) : sportsById.get(p.canonicalPlayerId);
    if (sports) projections.push({ canonicalPlayerId: p.canonicalPlayerId, name: p.name, team: p.team, position: p.position, source: "sportsdataio", points: sports.points, sourceTimestamp: started.toISOString() });
    if (projections.length) projectionGroups.set(p.canonicalPlayerId, aggregateProjections(projections));
  }
  for (const p of roster) {
    const agg = projectionGroups.get(p.canonicalPlayerId);
    const sports = p.position === "DST" ? sportsDefenseByTeam.get(p.team.toUpperCase()) : sportsById.get(p.canonicalPlayerId);
    if (agg) { p.projection = agg.median; p.floor = agg.floor; p.ceiling = agg.ceiling; }
    if (sports?.futureProjection != null) p.futureProjection = sports.futureProjection;
  }
  const freeAgents: RosterPlayer[] = league.freeAgents.map((p) => {
    const id = canonicalPlayerId(p.name, p.team);
    const sports = p.position === "DST" ? sportsDefenseByTeam.get(p.team.toUpperCase()) : sportsById.get(id);
    const projections = [
      ...(p.projection != null ? [{ canonicalPlayerId: id, name: p.name, team: p.team, position: p.position, source: league.source, points: p.projection, sourceTimestamp: league.sourceTimestamp }] : []),
      ...(sports ? [{ canonicalPlayerId: id, name: p.name, team: p.team, position: p.position, source: "sportsdataio", points: sports.points, sourceTimestamp: started.toISOString() }] : []),
    ];
    const agg = aggregateProjections(projections);
    const game = scheduleByTeam.get(p.team.toUpperCase());
    const kickoff = p.kickoff ?? sports?.kickoff ?? game?.kickoff;
    return { canonicalPlayerId: id, name: p.name, team: p.team, position: p.position, slot: "FA", projection: agg?.median ?? p.projection, futureProjection: sports?.futureProjection ?? p.futureProjection, opportunityScore: p.opportunityScore, depthOrder: p.depthOrder, floor: agg?.floor, ceiling: agg?.ceiling, kickoff, opponent: game?.opponent, homeAway: game?.homeAway, venue: game?.venue, weather: game?.weather, locked: isPlayerLocked(kickoff), injury: p.injury ?? sports?.injury };
  });

  const enrichLeaguePlayers = (players: ExternalSyncPayload["roster"]): RosterPlayer[] => players.map((p) => {
    const id = canonicalPlayerId(p.name, p.team);
    const sports = p.position === "DST" ? sportsDefenseByTeam.get(p.team.toUpperCase()) : sportsById.get(id);
    const projections = [
      ...(p.projection != null ? [{ canonicalPlayerId: id, name: p.name, team: p.team, position: p.position, source: league.source, points: p.projection, sourceTimestamp: league.sourceTimestamp }] : []),
      ...(sports ? [{ canonicalPlayerId: id, name: p.name, team: p.team, position: p.position, source: "sportsdataio", points: sports.points, sourceTimestamp: started.toISOString() }] : []),
    ];
    const agg = aggregateProjections(projections);
    const game = scheduleByTeam.get(p.team.toUpperCase());
    const kickoff = p.kickoff ?? sports?.kickoff ?? game?.kickoff;
    return { canonicalPlayerId: id, name: p.name, team: p.team, position: p.position, slot: p.slot, projection: agg?.median ?? p.projection, futureProjection: sports?.futureProjection ?? p.futureProjection, opportunityScore: p.opportunityScore, depthOrder: p.depthOrder, floor: agg?.floor, ceiling: agg?.ceiling, kickoff, opponent: game?.opponent, homeAway: game?.homeAway, venue: game?.venue, weather: game?.weather, locked: isPlayerLocked(kickoff), injury: p.injury ?? sports?.injury };
  });
  const opponentRoster = enrichLeaguePlayers(league.opponent?.roster ?? []);
  const tradePartners: TradePartner[] = (league.tradePartners ?? []).map((partner) => ({ ...partner, roster: enrichLeaguePlayers(partner.roster) }));
  const computedOpponentScore = opponentRoster.length ? optimizeLineup(opponentRoster).reduce((sum, p) => sum + (p.projection ?? 0), 0) : null;

  const secondWave = await Promise.all([
    runAgent("LineupOptimization", async () => topLineupRecommendations(roster)),
    runAgent("WaiverRecommendations", async () => waiverRecommendations(roster, freeAgents)),
    runAgent("OpponentScout", async () => computedOpponentScore ?? league.opponentProjection ?? null),
    runAgent("TradeFinder", async () => tradeRecommendations(roster, tradePartners)),
    runAgent("BreakoutDetection", async () => []),
    runAgent("RestOfSeason", async () => []),
    runAgent("DefenseStreaming", async () => []),
    runAgent("KickerStreaming", async () => []),
    runAgent("RosterManagement", async () => rosterManagementRecommendations(roster)),
  ]);
  const lineupActions = (secondWave.find((r) => r.name === "LineupOptimization")?.data ?? []) as ReturnType<typeof topLineupRecommendations>;
  const waiverActions = (secondWave.find((r) => r.name === "WaiverRecommendations")?.data ?? []) as ReturnType<typeof waiverRecommendations>;
  const rosterActions = (secondWave.find((r) => r.name === "RosterManagement")?.data ?? []) as ReturnType<typeof rosterManagementRecommendations>;
  const tradeActions = (secondWave.find((r) => r.name === "TradeFinder")?.data ?? []) as ReturnType<typeof tradeRecommendations>;
  const projectedScore = optimizeLineup(roster).reduce((sum, p) => sum + (p.projection ?? 0), 0);
  const opp = computedOpponentScore == null ? league.opponentProjection ?? null : Math.round(computedOpponentScore * 10) / 10;
  // League rosters change far less often than scores/projections, which are refreshed
  // independently on every sync. Avoid disabling valid advice after only 30 minutes.
  const stale = isStale(league.sourceTimestamp, 24 * 60 * 60_000, started);
  const failed = [...firstWave, ...secondWave].filter((r) => r.run.status === "failed");
  const snapshot: SyncSnapshot = {
    id: randomUUID(), season: period.season, week: period.week, leagueName: league.league.name,
    generatedAt: started.toISOString(), dataAsOf: league.sourceTimestamp,
    freshness: stale ? "STALE" : failed.length ? "DEGRADED" : "FRESH",
    health: failed.length ? "DEGRADED" : "HEALTHY",
    projectedScore: Math.round(projectedScore * 10) / 10, opponentScore: opp,
    winProbability: opp == null ? null : simulateWin(projectedScore, opp),
    teamRecord: league.teamRecord,
    opponentName: league.opponent?.name,
    roster,
    recommendations: [...lineupActions, ...waiverActions, ...tradeActions, ...rosterActions]
      .sort((a, b) => (a.priority ?? 99) - (b.priority ?? 99) || b.confidenceScore - a.confidenceScore)
      .map((r) => ({ ...r, actionable: !stale })),
    agents: [...firstWave, ...secondWave].map((r) => r.run),
    sources: [{ name: league.source, sourceTimestamp: league.sourceTimestamp, fetchedAt: started.toISOString(), season: period.season, week: period.week, gameStatus: "unknown" }, ...(scheduleEvents.length ? [{ name: "ESPN NFL Scoreboard", sourceTimestamp: started.toISOString(), fetchedAt: started.toISOString(), season: period.season, week: period.week, gameStatus: "unknown" as const }] : []), ...(sportsData.length ? [{ name: "SportsDataIO", sourceTimestamp: started.toISOString(), fetchedAt: started.toISOString(), season: period.season, week: period.week, gameStatus: "unknown" as const }] : []), ...((firstWave.find((r) => r.name === "StatsHawk")?.data) ? [{ name: "StatsHawk NFL", sourceTimestamp: started.toISOString(), fetchedAt: started.toISOString(), season: period.season, week: period.week, gameStatus: "unknown" as const }] : [])],
    warnings: [...(stale ? ["STALE DATA WARNING: la plantilla de liga supera 24 horas; vuelve a importar ESPN/Flaim."] : []), ...(failed.length ? [`DEGRADED DATA: ${failed.map((r) => r.name).join(", ")}.`] : [])],
  };
  await saveSnapshot(snapshot);
  await captureServerEvent("sync_completed", { ...period, degraded: failed.length > 0, latency_ms: Date.now() - started.getTime() });
  return snapshot;
}
