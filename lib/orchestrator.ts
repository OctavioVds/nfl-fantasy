import { randomUUID } from "node:crypto";
import { captureServerEvent } from "./analytics";
import { getLatestExternalIngest, getPlayerIdentityMap, saveExternalIngest, saveSnapshot } from "./db";
import { applyCoreProjections } from "./core/consumers";
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
import type { AgentRun, PlayerProjection, RosterChange, RosterPlayer, SyncSnapshot, TradePartner } from "./types";

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
  const identityMap = await getPlayerIdentityMap();
  const canonicalFor = (provider: string, id: string) => identityMap.get(providerPlayerId(provider, id)) ?? providerPlayerId(provider, id);
  // Usage metrics are scoring-independent. PPR actuals/DvP are not reconciled to
  // custom league scoring, so they must not become this league's projection.
  const recentById = new Map(recentBundle.players.map((player) => [canonicalFor("sportsdataio", player.providerId), player.games.map((game) => ({ ...game, fantasyPointsPpr: undefined }))]));
  const injuries = (firstWave.find((r) => r.name === "InjuryReport")?.data ?? []) as Awaited<ReturnType<typeof fetchSportsDataIoInjuries>>;
  const risksFor = (team: string, opponent?: string) => injuryContext(injuries, team, opponent);
  const sportsData = (firstWave.find((r) => r.name === "SportsDataIO")?.data ?? []) as Awaited<ReturnType<typeof fetchSportsDataIoProjections>>;
  const sportsById = new Map(sportsData.map((player) => [canonicalFor("sportsdataio", player.providerId), player]));
  const sourceProjectionsByKey = new Map<string, PlayerProjection>();
  const enrichLeaguePlayers = (players: ExternalSyncPayload["roster"], preserveActual = false): RosterPlayer[] => players.map((p) => {
    const id = canonicalFor(league.source, p.providerId);
    const sports = sportsById.get(id);
    const raw: PlayerProjection[] = p.projection == null ? [] : [{
      canonicalPlayerId: id, providerPlayerId: p.providerId, name: p.name, team: p.team, position: p.position,
      source: league.source, points: p.projection, sourceTimestamp: league.sourceTimestamp,
      fetchedAt: league.fetchedAt, scoring: league.league.scoring ?? null, scoringLabel: scoringLabel(league),
    }];
    // SportsDataIO's raw scoring is retained for audit, never blended into this
    // league's points until the complete scoring contract is reconciled.
    if (sports) sourceProjectionsByKey.set(`${id}|sportsdataio`, {
      canonicalPlayerId: id, providerPlayerId: sports.providerId, name: sports.name, team: sports.team, position: sports.position,
      source: "sportsdataio", points: sports.points, scoring: null, scoringLabel: sports.scoringLabel ?? "Provider scoring unreconciled",
      sourceTimestamp: sports.sourceTimestamp, fetchedAt: sports.fetchedAt ?? firstWave.find((item) => item.name === "SportsDataIO")?.run.fetchedAt,
      sourceTimestampReason: sports.sourceTimestamp ? undefined : "Provider payload did not supply a verified publication timestamp.",
    });
    for (const projection of raw) {
      const key = `${id}|${projection.source}`;
      if (!sourceProjectionsByKey.has(key)) sourceProjectionsByKey.set(key, projection);
    }
    const agg = preserveActual ? null : aggregateProjections(raw);
    const game = scheduleByTeam.get(p.team.toUpperCase());
    const kickoff = p.kickoff ?? sports?.kickoff ?? game?.kickoff;
    const player: RosterPlayer = {
      canonicalPlayerId: id, name: p.name, team: p.team, position: p.position, slot: p.slot,
      projection: preserveActual ? p.projection : agg?.median ?? p.projection,
      futureProjection: p.futureProjection, opportunityScore: p.opportunityScore, depthOrder: p.depthOrder,
      floor: agg?.floor, ceiling: agg?.ceiling, kickoff, opponent: game?.opponent,
      homeAway: game?.homeAway, venue: game?.venue, weather: game?.weather, windMph: game?.windMph,
      overUnder: game?.overUnder, spread: game?.spread, divisional: game?.divisional,
      shortWeek: game?.shortWeek, crossCountryTravel: game?.crossCountryTravel,
      locked: !kickoff || isPlayerLocked(kickoff), injury: mostSevereInjury(p.injury, sports?.injury),
      recentGames: recentById.get(id), ...risksFor(p.team, game?.opponent),
    };
    player.decisionProfile = buildDecisionProfile(player);
    if (!preserveActual && player.decisionProfile.projectionAvailable !== false) {
      player.projection = player.decisionProfile.median; player.floor = player.decisionProfile.floor; player.ceiling = player.decisionProfile.ceiling;
    }
    return player;
  });
  let roster = enrichLeaguePlayers(league.roster, showingCurrentActual);
  const occupiedIds = new Set([
    ...league.roster, ...(league.opponent?.roster ?? []), ...(league.nextOpponent?.roster ?? []),
    ...(league.tradePartners ?? []).flatMap((partner) => partner.roster),
  ].map((player) => canonicalFor(league.source, player.providerId)));
  let freeAgents = enrichLeaguePlayers(league.freeAgents.filter((player) => !occupiedIds.has(canonicalFor(league.source, player.providerId))).map((player) => ({ ...player, slot: "FA" })));
  const activeOpponent = useNextOpponent ? league.nextOpponent : league.opponent;
  let opponentRoster = enrichLeaguePlayers(activeOpponent?.roster ?? []);
  let tradePartners: TradePartner[] = (league.tradePartners ?? []).map((partner) => ({ ...partner, roster: enrichLeaguePlayers(partner.roster) }));
  const allPlayersById = new Map<string, RosterPlayer>();
  for (const player of [...roster, ...freeAgents, ...opponentRoster, ...tradePartners.flatMap((partner) => partner.roster)]) {
    if (!allPlayersById.has(player.canonicalPlayerId)) allPlayersById.set(player.canonicalPlayerId, player);
  }
  const allPlayers = [...allPlayersById.values()];
  const coreAgent = await runAgent("PredictiveCore", () => applyCoreProjections(allPlayers, {
    scope: `${league.source}:${league.league.leagueId ?? league.league.name}:${league.league.teamId ?? ""}:${league.league.season}`,
    season: period.season, week: period.week, dataAsOf: league.sourceTimestamp,
  }), "calculation");
  firstWave.push(coreAgent);
  if (Array.isArray(coreAgent.data)) {
    const applied = new Map((coreAgent.data as RosterPlayer[]).map((player) => [player.canonicalPlayerId, player]));
    const merge = (players: RosterPlayer[]) => players.map((player) => {
      const model = applied.get(player.canonicalPlayerId);
      if (!model?.coreProjection) return player;
      // Copy projection fields only: a repeated rival can appear in another
      // roster view with a different slot, name, context or raw baseline.
      return { ...player, projection: model.projection, floor: model.floor, ceiling: model.ceiling,
        futureProjection: model.futureProjection ?? player.futureProjection,
        coreProjection: model.coreProjection,
        coreAnomalies: model.coreAnomalies,
        decisionProfile: { ...player.decisionProfile!, floor: model.decisionProfile!.floor, median: model.decisionProfile!.median,
          ceiling: model.decisionProfile!.ceiling, confidence: model.decisionProfile!.confidence,
          projectionAvailable: true, estimated: true, method: model.decisionProfile!.method,
          hiddenFactor: model.decisionProfile!.hiddenFactor, missing: model.decisionProfile!.missing },
      };
    });
    // Current actual scores must never be replaced with a future model projection.
    if (!showingCurrentActual) roster = merge(roster);
    freeAgents = merge(freeAgents); opponentRoster = merge(opponentRoster);
    tradePartners = tradePartners.map((partner) => ({ ...partner, roster: merge(partner.roster) }));
  }
  const stale = !received || isStale(league.sourceTimestamp, 24 * 60 * 60_000, started) || leagueWeekMismatch;
  const computedOpponentScore = !stale ? completeLineupProjection(opponentRoster) : null;
  const pendingWaivers = (league.pendingMoves ?? []).filter((move) => move.kind === "waiver");
  const pendingWithoutIds = pendingWaivers.some((move) => !move.addProviderId);
  const pendingAddIds = new Set(pendingWaivers.flatMap((move) => move.addProviderId ? [canonicalFor(league.source, move.addProviderId)] : []));

  const secondWave = stale ? [] : await runAgentWave([
    { name: "LineupOptimization", fn: async () => topLineupRecommendations(roster), mode: "calculation" },
    { name: "WaiverRecommendations", fn: async () => pendingWithoutIds ? [] : waiverRecommendations(roster, freeAgents.filter((player) => !pendingAddIds.has(player.canonicalPlayerId))), mode: "calculation" },
    { name: "OpponentScout", fn: async () => computedOpponentScore ?? league.opponentProjection ?? null, mode: "calculation" },
    { name: "TradeFinder", fn: async () => tradeRecommendations(roster, tradePartners), mode: "calculation" },
    { name: "RosterManagement", fn: async () => rosterManagementRecommendations(roster), mode: "calculation" },
  ]);
  const lineupActions = (secondWave.find((r) => r.name === "LineupOptimization")?.data ?? []) as ReturnType<typeof topLineupRecommendations>;
  const waiverActions = (secondWave.find((r) => r.name === "WaiverRecommendations")?.data ?? []) as ReturnType<typeof waiverRecommendations>;
  const rosterActions = (secondWave.find((r) => r.name === "RosterManagement")?.data ?? []) as ReturnType<typeof rosterManagementRecommendations>;
  const tradeActions = (secondWave.find((r) => r.name === "TradeFinder")?.data ?? []) as ReturnType<typeof tradeRecommendations>;
  const lineupProjection = stale ? null : completeLineupProjection(roster);
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
    sourceProjections: stale ? [] : [...sourceProjectionsByKey.values()],
    warnings: [
      ...(!received ? ["Este Sync reutilizó el último snapshot; no consultó ESPN/Flaim y bloqueó recomendaciones."] : []),
      ...(leagueWeekMismatch ? [`El snapshot pertenece a ${league.league.season} semana ${league.league.week}; se esperaba ${period.season} semana ${period.week}.`] : []),
      ...(received && isStale(received.sourceTimestamp, 24 * 60 * 60_000, started) ? ["El dato de liga ya supera 24 horas; se bloquearon recomendaciones."] : []),
      ...(sourceChanged ? ["No se calculó diff de roster porque cambió el proveedor, la liga o el equipo analizado."] : []),
      ...(pendingWithoutIds ? ["Waivers bloqueados: un movimiento pendiente no incluye addProviderId; no se emparejan jugadores por nombre."] : []),
      ...(sportsData.length || recentBundle.players.length || recentBundle.defenseAllowed.length ? ["SportsDataIO: puntos y DvP con scoring propio conservados sin mezclar; solo uso/estado con mapeo explícito de IDs enriquece la liga."] : []),
      ...(failed.length ? [`DEGRADED DATA: ${failed.map((r) => r.name).join(", ")}.`] : []),
    ],
    pendingMoves: stale ? undefined : league.pendingMoves,
    rosterChanges: stale || sourceChanged ? undefined : rosterDiff,
  };
  await saveSnapshot(snapshot);
  await captureServerEvent("sync_completed", { ...period, degraded: failed.length > 0, latency_ms: Date.now() - started.getTime() });
  return snapshot;
}

function completeLineupProjection(players: RosterPlayer[]) {
  const lineup = optimizeLineup(players);
  if (!lineup.length || lineup.some((player) => player.projection == null || player.decisionProfile?.projectionAvailable === false)) return null;
  return lineup.reduce((sum, player) => sum + player.projection!, 0);
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
    && previous.league.teamId === current.league.teamId
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
