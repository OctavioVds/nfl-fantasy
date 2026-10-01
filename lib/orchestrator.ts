import { randomUUID } from "node:crypto";
import { captureServerEvent } from "./analytics";
import { getLatestExternalIngest, saveExternalIngest, saveSnapshot } from "./db";
import { aggregateProjections, buildDecisionProfile, optimizeLineup, rosterManagementRecommendations, simulateWin, topLineupRecommendations, tradeRecommendations, waiverRecommendations } from "./engine";
import { providerPlayerId } from "./player-identity";
import { leagueDataVersion } from "./data-version";
import { fallbackSnapshot } from "./fallback-data";
import { fetchEspnNews, fetchEspnScoreboard, mapEspnTeamContexts } from "./providers/espn";
import { fetchSleeperTrending } from "./providers/sleeper";
import { fetchSportsDataIoInjuries, fetchSportsDataIoProjections, fetchSportsDataIoRecentUsage } from "./providers/sportsdataio";
import { fetchStatsHawkContext } from "./providers/statshawk";
import { MissingProviderCredentialsError } from "./providers";
import type { ExternalSyncPayload } from "./schemas";
import { externalSyncSchema } from "./schemas";
import { isPlayerLocked, isStale, nflPeriod } from "./time";
import type { AgentRun, RosterChange, RosterPlayer, SyncSnapshot, TradePartner } from "./types";

type AgentResult = { name: string; data: unknown; run: AgentRun };
type AgentTask = { name: string; fn: () => Promise<unknown>; mode?: AgentRun["mode"] };

async function runAgent(name: string, fn: () => Promise<unknown>, mode: AgentRun["mode"] = "external"): Promise<AgentResult> {
  const started = Date.now();
  try {
    const data = await fn();
    const records = Array.isArray(data) ? data.length : data && typeof data === "object" && "players" in data && Array.isArray(data.players) ? data.players.length : data == null ? 0 : 1;
    const emptyExternal = mode === "external" && records === 0;
    return { name, data, run: { name, status: emptyExternal ? "degraded" : mode === "external" ? "ok" : "cached", latencyMs: Date.now() - started, fetchedAt: new Date().toISOString(), cacheHit: mode !== "external", mode, records, message: emptyExternal ? "La fuente respondió sin registros." : mode === "external" ? `${records} registro(s) recibidos de la fuente.` : mode === "snapshot" ? "Se reutilizó el último snapshot; no consultó la liga." : "Cálculo local sobre los datos recibidos." } };
  }
  catch (error) {
    const missingCredentials = error instanceof MissingProviderCredentialsError;
    return { name, data: null, run: { name, status: missingCredentials ? "missing_credentials" : "failed", latencyMs: Date.now() - started, fetchedAt: new Date().toISOString(), cacheHit: false, mode, records: 0, message: missingCredentials && error instanceof Error ? error.message : "La consulta al proveedor falló." } };
  }
}

async function runAgentWave(tasks: AgentTask[]): Promise<AgentResult[]> {
  const results = await Promise.allSettled(tasks.map((task) => runAgent(task.name, task.fn, task.mode)));
  return results.map((result, index) => {
    if (result.status === "fulfilled") return result.value;
    const task = tasks[index];
    const message = result.reason instanceof Error ? `${result.reason.name}: fallo de proveedor.` : "Fallo de proveedor.";
    return { name: task.name, data: null, run: { name: task.name, status: "failed", latencyMs: 0, fetchedAt: new Date().toISOString(), cacheHit: false, mode: task.mode ?? "external", records: 0, message } };
  });
}

export async function synchronize(external?: ExternalSyncPayload): Promise<SyncSnapshot> {
  const started = new Date();
  const runId = randomUUID();
  const latestIngest = externalSyncSchema.safeParse(await getLatestExternalIngest());
  const previousLeague = latestIngest.success ? latestIngest.data : undefined;
  const received = external ? { ...external, fetchedAt: external.fetchedAt ?? started.toISOString() } : undefined;
  const league = received ?? previousLeague;
  if (received) await saveExternalIngest(received, runId);
  const calendarPeriod = nflPeriod(started);
  const period = calendarPeriod;
  const leagueWeekMismatch = Boolean(league && (league.league.season !== period.season || league.league.week !== period.week));
  const useNextOpponent = Boolean(league?.nextOpponent && period.week >= league.nextOpponent.week);
  const showingCurrentActual = Boolean(league && !useNextOpponent && league.currentScore != null);
  await captureServerEvent("sync_started", period);

  const firstWave = await runAgentWave([
    { name: "LeagueSnapshot", fn: async () => league ?? null, mode: received ? "external" : "snapshot" },
    { name: "Schedule", fn: () => fetchEspnScoreboard(period.season, period.week) },
    { name: "WaiverMarket", fn: () => fetchSleeperTrending() },
    { name: "SportsDataIO", fn: () => fetchSportsDataIoProjections(period.season, period.week) },
    { name: "RecentUsage", fn: () => fetchSportsDataIoRecentUsage(period.season, period.week) },
    { name: "InjuryReport", fn: () => fetchSportsDataIoInjuries(period.season, period.week) },
    { name: "StatsHawk", fn: () => fetchStatsHawkContext(period.season) },
    { name: "BreakingNews", fn: () => fetchEspnNews(100) },
  ]);
  if (!league) {
    const base = fallbackSnapshot();
    base.id = runId;
    base.syncRunId = runId;
    base.generatedAt = started.toISOString();
    base.agents = firstWave.map((r) => r.run);
    base.health = "DEGRADED";
    base.freshness = "STALE";
    base.warnings.unshift("Este Sync no consultó una fuente actual de liga. Los movimientos están bloqueados hasta recibir un snapshot fresco de ESPN/Flaim.");
    await saveSnapshot(base);
    await captureServerEvent("sync_completed", { ...period, degraded: true });
    return base;
  }

  const scheduleEvents = (firstWave.find((r) => r.name === "Schedule")?.data ?? []) as unknown[];
  const scheduleByTeam = mapEspnTeamContexts(scheduleEvents);
  const recentBundle = (firstWave.find((r) => r.name === "RecentUsage")?.data ?? { players: [], defenseAllowed: [] }) as Awaited<ReturnType<typeof fetchSportsDataIoRecentUsage>>;
  const recentUsage = recentBundle.players;
  const recentById = new Map(recentUsage.map((player) => [providerPlayerId("sportsdataio", player.providerId), player.games]));
  const defenseAllowed = new Map(recentBundle.defenseAllowed.map((row) => [`${row.team.toUpperCase()}|${row.position}`, row.pointsPerGame]));
  const injuries = (firstWave.find((r) => r.name === "InjuryReport")?.data ?? []) as Awaited<ReturnType<typeof fetchSportsDataIoInjuries>>;
  const risksFor = (team: string, opponent?: string) => injuryContext(injuries, team, opponent);
  const roster: RosterPlayer[] = league.roster.map((p) => {
    const game = scheduleByTeam.get(p.team.toUpperCase());
    const kickoff = p.kickoff ?? game?.kickoff;
    const risks = risksFor(p.team, game?.opponent);
    // News payloads have no stable athlete ID, so do not attach headlines by name alone.
    return ({
    canonicalPlayerId: providerPlayerId(league.source, p.providerId), name: p.name, team: p.team, position: p.position,
    slot: p.slot, projection: p.projection, futureProjection: p.futureProjection, opportunityScore: p.opportunityScore,
    depthOrder: p.depthOrder, kickoff, opponent: game?.opponent, homeAway: game?.homeAway, venue: game?.venue,
    weather: game?.weather, windMph: game?.windMph, overUnder: game?.overUnder, spread: game?.spread,
    divisional: game?.divisional, shortWeek: game?.shortWeek, crossCountryTravel: game?.crossCountryTravel,
    opponentPointsAllowedL3: game?.opponent ? defenseAllowed.get(`${game.opponent}|${p.position}`) : undefined,
    locked: !kickoff || isPlayerLocked(kickoff), injury: p.injury,
    ...risks,
    recentGames: recentById.get(providerPlayerId(league.source, p.providerId)),
  }); });
  const sportsData = (firstWave.find((r) => r.name === "SportsDataIO")?.data ?? []) as Awaited<ReturnType<typeof fetchSportsDataIoProjections>>;
  const sportsById = new Map(sportsData.map((p) => [providerPlayerId("sportsdataio", p.providerId), p]));
  const sportsDefenseByTeam = new Map(sportsData.filter((p) => p.position === "DST").map((p) => [p.team.toUpperCase(), p]));
  const projectionGroups = new Map<string, ReturnType<typeof aggregateProjections>>();
  for (const p of roster) {
    const projections = [];
    if (p.projection != null) projections.push({ canonicalPlayerId: p.canonicalPlayerId, name: p.name, team: p.team, position: p.position, source: league.source, points: p.projection, sourceTimestamp: league.sourceTimestamp });
    const sports = p.position === "DST" ? sportsDefenseByTeam.get(p.team.toUpperCase()) : sportsById.get(p.canonicalPlayerId);
    p.injury = mostSevereInjury(p.injury, sports?.injury);
    if (sports) projections.push({ canonicalPlayerId: p.canonicalPlayerId, name: p.name, team: p.team, position: p.position, source: "sportsdataio", points: sports.points, sourceTimestamp: started.toISOString() });
    if (projections.length) projectionGroups.set(p.canonicalPlayerId, aggregateProjections(projections));
  }
  for (const p of roster) {
    const agg = projectionGroups.get(p.canonicalPlayerId);
    const sports = p.position === "DST" ? sportsDefenseByTeam.get(p.team.toUpperCase()) : sportsById.get(p.canonicalPlayerId);
    if (showingCurrentActual) {
      p.floor = undefined; p.ceiling = undefined;
    } else {
      if (agg) { p.projection = agg.median; p.floor = agg.floor; p.ceiling = agg.ceiling; }
      if (sports?.futureProjection != null) p.futureProjection = sports.futureProjection;
    }
    p.decisionProfile = buildDecisionProfile(p);
    if (!showingCurrentActual) {
      p.projection = p.decisionProfile.median; p.floor = p.decisionProfile.floor; p.ceiling = p.decisionProfile.ceiling;
    }
  }
  const rosterProviderIds = new Set(league.roster.map((player) => player.providerId));
  const freeAgents: RosterPlayer[] = league.freeAgents.filter((player) => !rosterProviderIds.has(player.providerId)).map((p) => {
    const id = providerPlayerId(league.source, p.providerId);
    const sports = p.position === "DST" ? sportsDefenseByTeam.get(p.team.toUpperCase()) : sportsById.get(id);
    const projections = [
      ...(p.projection != null ? [{ canonicalPlayerId: id, name: p.name, team: p.team, position: p.position, source: league.source, points: p.projection, sourceTimestamp: league.sourceTimestamp }] : []),
      ...(!showingCurrentActual && sports ? [{ canonicalPlayerId: id, name: p.name, team: p.team, position: p.position, source: "sportsdataio", points: sports.points, sourceTimestamp: started.toISOString() }] : []),
    ];
    const agg = aggregateProjections(projections);
    const game = scheduleByTeam.get(p.team.toUpperCase());
    const kickoff = p.kickoff ?? sports?.kickoff ?? game?.kickoff;
    const player: RosterPlayer = { canonicalPlayerId: id, name: p.name, team: p.team, position: p.position, slot: "FA", projection: agg?.median ?? p.projection, futureProjection: p.futureProjection, opportunityScore: p.opportunityScore, depthOrder: p.depthOrder, floor: agg?.floor, ceiling: agg?.ceiling, kickoff, opponent: game?.opponent, homeAway: game?.homeAway, venue: game?.venue, weather: game?.weather, windMph: game?.windMph, overUnder: game?.overUnder, spread: game?.spread, divisional: game?.divisional, shortWeek: game?.shortWeek, crossCountryTravel: game?.crossCountryTravel, opponentPointsAllowedL3: game?.opponent ? defenseAllowed.get(`${game.opponent}|${p.position}`) : undefined, locked: !kickoff || isPlayerLocked(kickoff), injury: p.injury ?? sports?.injury, recentGames: recentById.get(id), ...risksFor(p.team, game?.opponent) };
    player.decisionProfile = buildDecisionProfile(player);
    player.projection = player.decisionProfile.median; player.floor = player.decisionProfile.floor; player.ceiling = player.decisionProfile.ceiling;
    return player;
  });

  const enrichLeaguePlayers = (players: ExternalSyncPayload["roster"]): RosterPlayer[] => players.map((p) => {
    const id = providerPlayerId(league.source, p.providerId);
    const sports = p.position === "DST" ? sportsDefenseByTeam.get(p.team.toUpperCase()) : sportsById.get(id);
    const projections = [
      ...(p.projection != null ? [{ canonicalPlayerId: id, name: p.name, team: p.team, position: p.position, source: league.source, points: p.projection, sourceTimestamp: league.sourceTimestamp }] : []),
      ...(sports ? [{ canonicalPlayerId: id, name: p.name, team: p.team, position: p.position, source: "sportsdataio", points: sports.points, sourceTimestamp: started.toISOString() }] : []),
    ];
    const agg = aggregateProjections(projections);
    const game = scheduleByTeam.get(p.team.toUpperCase());
    const kickoff = p.kickoff ?? sports?.kickoff ?? game?.kickoff;
    const player: RosterPlayer = { canonicalPlayerId: id, name: p.name, team: p.team, position: p.position, slot: p.slot, projection: agg?.median ?? p.projection, futureProjection: p.futureProjection, opportunityScore: p.opportunityScore, depthOrder: p.depthOrder, floor: agg?.floor, ceiling: agg?.ceiling, kickoff, opponent: game?.opponent, homeAway: game?.homeAway, venue: game?.venue, weather: game?.weather, windMph: game?.windMph, overUnder: game?.overUnder, spread: game?.spread, divisional: game?.divisional, shortWeek: game?.shortWeek, crossCountryTravel: game?.crossCountryTravel, opponentPointsAllowedL3: game?.opponent ? defenseAllowed.get(`${game.opponent}|${p.position}`) : undefined, locked: !kickoff || isPlayerLocked(kickoff), injury: p.injury ?? sports?.injury, recentGames: recentById.get(id), ...risksFor(p.team, game?.opponent) };
    player.decisionProfile = buildDecisionProfile(player);
    player.projection = player.decisionProfile.median; player.floor = player.decisionProfile.floor; player.ceiling = player.decisionProfile.ceiling;
    return player;
  });
  const activeOpponent = useNextOpponent ? league.nextOpponent : league.opponent;
  const opponentRoster = enrichLeaguePlayers(activeOpponent?.roster ?? []);
  const tradePartners: TradePartner[] = (league.tradePartners ?? []).map((partner) => ({ ...partner, roster: enrichLeaguePlayers(partner.roster) }));
  const stale = !received || isStale(league.sourceTimestamp, 24 * 60 * 60_000, started) || leagueWeekMismatch;
  const computedOpponentScore = !stale && opponentRoster.length ? optimizeLineup(opponentRoster).reduce((sum, p) => sum + (p.projection ?? 0), 0) : null;

  const secondWave = stale ? [] : await runAgentWave([
    { name: "LineupOptimization", fn: async () => topLineupRecommendations(roster), mode: "calculation" },
    { name: "WaiverRecommendations", fn: async () => waiverRecommendations(roster, freeAgents.filter((player) => !(league.pendingMoves ?? []).some((move) => move.kind === "waiver" && move.add === player.name))), mode: "calculation" },
    { name: "OpponentScout", fn: async () => computedOpponentScore ?? league.opponentProjection ?? null, mode: "calculation" },
    { name: "TradeFinder", fn: async () => tradeRecommendations(roster, tradePartners), mode: "calculation" },
    { name: "RosterManagement", fn: async () => rosterManagementRecommendations(roster), mode: "calculation" },
  ]);
  const lineupActions = (secondWave.find((r) => r.name === "LineupOptimization")?.data ?? []) as ReturnType<typeof topLineupRecommendations>;
  const waiverActions = (secondWave.find((r) => r.name === "WaiverRecommendations")?.data ?? []) as ReturnType<typeof waiverRecommendations>;
  const rosterActions = (secondWave.find((r) => r.name === "RosterManagement")?.data ?? []) as ReturnType<typeof rosterManagementRecommendations>;
  const tradeActions = (secondWave.find((r) => r.name === "TradeFinder")?.data ?? []) as ReturnType<typeof tradeRecommendations>;
  const lineupProjection = stale ? null : optimizeLineup(roster).reduce((sum, p) => sum + (p.projection ?? 0), 0);
  const showingActual = showingCurrentActual;
  const projectedScore = stale ? null : showingActual ? league.currentScore! : lineupProjection!;
  const opp = showingActual ? league.opponentProjection ?? null : computedOpponentScore == null ? league.opponentProjection ?? null : Math.round(computedOpponentScore * 10) / 10;
  const failed = [...firstWave, ...secondWave].filter((r) => ["failed", "missing_credentials", "degraded"].includes(r.run.status));
  const rosterDiff = received && previousLeague ? diffRoster(previousLeague, received) : [];
  const sourceChanged = Boolean(received && previousLeague && !sameRosterScope(previousLeague, received));
  const sources = buildSourceRefs(league, period, firstWave);
  const recommendationRows = [...waiverActions, ...lineupActions, ...tradeActions, ...rosterActions];
  const snapshot: SyncSnapshot = {
    id: runId, syncRunId: runId, season: period.season, week: period.week,
    leagueName: stale ? "Liga no conectada" : league.league.name,
    generatedAt: started.toISOString(), dataAsOf: league.sourceTimestamp,
    dataUpdatedAt: league.sourceTimestamp, dataFetchedAt: league.fetchedAt,
    dataReceivedAt: started.toISOString(),
    dataVersion: leagueDataVersion(league), teamCount: stale ? undefined : league.league.teamCount,
    scoringLabel: stale ? undefined : scoringLabel(league),
    freshness: stale ? "STALE" : failed.length ? "DEGRADED" : "FRESH",
    health: stale || failed.length ? "DEGRADED" : "HEALTHY",
    projectedScore: stale || projectedScore == null ? null : Math.round(projectedScore * 10) / 10,
    opponentScore: stale ? null : opp,
    winProbability: stale || projectedScore == null || opp == null ? null : showingActual && league.matchupComplete ? (projectedScore > opp ? 100 : projectedScore < opp ? 0 : 50) : simulateWin(projectedScore, opp),
    scoreMode: stale ? undefined : showingActual ? "actual" : "projection",
    teamRecord: stale ? undefined : league.teamRecord,
    opponentName: stale ? undefined : activeOpponent?.name,
    roster: stale ? [] : roster,
    recommendations: stale ? [] : recommendationRows
      .sort((a, b) => {
        const category = (kind: string) => ["ADD", "DROP", "STREAM"].includes(kind) ? 1 : ["START", "SIT"].includes(kind) ? 2 : kind === "TRADE" ? 3 : 4;
        return category(a.kind) - category(b.kind) || b.confidenceScore - a.confidenceScore || (a.priority ?? 99) - (b.priority ?? 99);
      })
      .map((r) => ({ ...r, actionable: failed.length === 0 })),
    agents: [...firstWave, ...secondWave].map((r) => r.run),
    sources,
    warnings: [
      ...(!received ? ["Este Sync reutilizó el último snapshot; no consultó ESPN/Flaim y bloqueó recomendaciones."] : []),
      ...(leagueWeekMismatch ? [`El snapshot pertenece a ${league.league.season} semana ${league.league.week}; se esperaba ${period.season} semana ${period.week}.`] : []),
      ...(received && isStale(received.sourceTimestamp, 24 * 60 * 60_000, started) ? ["El dato de liga ya supera 24 horas; se bloquearon recomendaciones."] : []),
      ...(sourceChanged ? ["No se calculó diff de roster porque cambió el proveedor y falta un mapeo estable entre IDs."] : []),
      ...(failed.length ? [`DEGRADED DATA: ${failed.map((r) => r.name).join(", ")}.`] : []),
    ],
    pendingMoves: stale ? undefined : league.pendingMoves,
    rosterChanges: stale || sourceChanged ? undefined : rosterDiff,
  };
  await saveSnapshot(snapshot);
  await captureServerEvent("sync_completed", { ...period, degraded: failed.length > 0, latency_ms: Date.now() - started.getTime() });
  return snapshot;
}

function scoringLabel(payload: ExternalSyncPayload) {
  const reception = payload.league.scoring?.reception;
  if (reception == null) return undefined;
  if (reception === 1) return "PPR";
  if (reception === 0.5) return "Half PPR";
  if (reception === 0) return "No PPR";
  return `${reception} pts/rec`;
}

function sameRosterScope(previous: ExternalSyncPayload, current: ExternalSyncPayload) {
  return previous.source === current.source
    && (previous.league.leagueId ?? previous.league.name) === (current.league.leagueId ?? current.league.name)
    && previous.league.season === current.league.season;
}

function diffRoster(previous: ExternalSyncPayload, current: ExternalSyncPayload): RosterChange[] {
  if (!sameRosterScope(previous, current)) return [];
  const before = new Map(previous.roster.map((player) => [player.providerId, player]));
  const after = new Map(current.roster.map((player) => [player.providerId, player]));
  const changes: RosterChange[] = [];
  for (const [providerId, player] of before) {
    const next = after.get(providerId);
    if (!next) {
      changes.push({ providerId, playerName: player.name, kind: "DROPPED", fromSlot: player.slot });
      continue;
    }
    if (player.slot === next.slot) continue;
    let kind: RosterChange["kind"] | undefined;
    if (player.slot === "IR" && next.slot !== "IR") kind = "ACTIVATED_FROM_IR";
    else if (player.slot !== "IR" && next.slot === "IR") kind = "MOVED_TO_IR";
    else if (player.slot === "Bench" && next.slot !== "Bench") kind = "MOVED_TO_STARTER";
    else if (player.slot !== "Bench" && next.slot === "Bench") kind = "MOVED_TO_BENCH";
    if (kind) changes.push({ providerId, playerName: next.name, kind, fromSlot: player.slot, toSlot: next.slot });
  }
  for (const [providerId, player] of after) {
    if (!before.has(providerId)) changes.push({ providerId, playerName: player.name, kind: "ADDED", toSlot: player.slot });
  }
  return changes;
}

function buildSourceRefs(
  league: ExternalSyncPayload,
  period: { season: number; week: number },
  agents: AgentResult[],
): SyncSnapshot["sources"] {
  const sources: SyncSnapshot["sources"] = [{
    name: league.source,
    sourceTimestamp: league.sourceTimestamp,
    fetchedAt: league.fetchedAt,
    season: period.season,
    week: period.week,
    gameStatus: "unknown",
  }];
  const add = (agentName: string, sourceName: string, gameStatus: "pre" | "in" | "post" | "unknown", sourceTimestamp?: string) => {
    const agent = agents.find((item) => item.name === agentName);
    if (!agent || agent.run.status !== "ok") return;
    sources.push({ name: sourceName, sourceTimestamp, fetchedAt: agent.run.fetchedAt, season: period.season, week: period.week, gameStatus });
  };
  if ((agents.find((item) => item.name === "Schedule")?.data as unknown[] | undefined)?.length) add("Schedule", "ESPN NFL Schedule", "unknown");
  const news = agents.find((item) => item.name === "BreakingNews")?.data as Awaited<ReturnType<typeof fetchEspnNews>> | undefined;
  if (news?.length) add("BreakingNews", "ESPN NFL News", "unknown", news.map((item) => item.published).filter((value): value is string => Boolean(value)).sort().at(-1));
  if ((agents.find((item) => item.name === "SportsDataIO")?.data as unknown[] | undefined)?.length) add("SportsDataIO", "SportsDataIO projections", "pre");
  const usage = agents.find((item) => item.name === "RecentUsage")?.data as Awaited<ReturnType<typeof fetchSportsDataIoRecentUsage>> | undefined;
  if (usage?.players.length) add("RecentUsage", "SportsDataIO recent usage", "post");
  if ((agents.find((item) => item.name === "InjuryReport")?.data as unknown[] | undefined)?.length) add("InjuryReport", "SportsDataIO injuries", "pre");
  const stats = agents.find((item) => item.name === "StatsHawk")?.data as Awaited<ReturnType<typeof fetchStatsHawkContext>> | undefined;
  if (stats) add("StatsHawk", "StatsHawk NFL", "unknown", stats.fetchedAt);
  return sources;
}

function mostSevereInjury(...statuses: Array<string | undefined>) {
  const severity = (status?: string) => /^(IR|O|OUT|INACTIVE)$/i.test(status ?? "") ? 4 : /^(D|DOUBTFUL)$/i.test(status ?? "") ? 3 : /^(Q|QUESTIONABLE)$/i.test(status ?? "") ? 2 : /^(P|PROBABLE|ACTIVE)$/i.test(status ?? "") ? 1 : 0;
  return statuses.filter(Boolean).sort((a, b) => severity(b) - severity(a))[0];
}

function injuryContext(injuries: Awaited<ReturnType<typeof fetchSportsDataIoInjuries>>, team: string, opponent?: string) {
  if (!injuries.length) return {
    offensiveLineAbsences: undefined, opponentCoverageAbsences: undefined,
    opponentFrontSevenAbsences: undefined, quarterbackRisk: undefined,
  };
  const weight = (status?: string) => /(?:IR|OUT|INACTIVE|DOUBTFUL)/i.test(status ?? "") ? 1 : /QUESTIONABLE/i.test(status ?? "") ? 0.35 : 0;
  const sumPositions = (targetTeam: string | undefined, positions: string[]) => injuries
    .filter((injury) => injury.team.toUpperCase() === targetTeam?.toUpperCase() && positions.includes((injury.position ?? "").toUpperCase()))
    .reduce((sum, injury) => sum + weight(injury.status), 0);
  return {
    offensiveLineAbsences: sumPositions(team, ["C", "G", "OG", "T", "OT", "OL"]),
    opponentCoverageAbsences: sumPositions(opponent, ["CB", "DB", "S", "FS", "SS"]),
    opponentFrontSevenAbsences: sumPositions(opponent, ["DE", "DL", "DT", "LB", "ILB", "OLB"]),
    quarterbackRisk: sumPositions(team, ["QB"]) >= 0.35,
  };
}
