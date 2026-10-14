import { createHash } from "node:crypto";
import { externalSyncSchema, type ExternalSyncPayload } from "../schemas";
import { getLatestExternalIngest } from "../db";
import { providerPlayerId } from "../player-identity";
import { detectAnomalies } from "./anomalies";
import { getAvailability } from "./availability";
import { buildFeatureRows, validateFeatureRows, type QualityIssue } from "./features";
import { evaluateSignals, NFL_SOURCE_POLICIES } from "./signals";
import { coreInputSchema, type CoreInput, type Projection, type Scoring } from "./schema";
import { scoringHash } from "./scoring";
import { getCoreInput, getCoreRun, getFutureProjections, getModel, saveCoreRun } from "./store";
import { FEATURE_VERSION, mixScenarios, projectPlayer, validDistribution } from "./projection";
import { serverEnv } from "../env";
import { estimateAdjustedMatchup } from "./features/matchup";
import { horizonValue } from "./projection/horizon";

export interface CoreRun {
  run_id: string; scope: string; season: number; week: number; input_digest: string; model_version: string | null;
  status: "VERIFIED" | "PARTIAL" | "BLOCKED"; created_at: string; source_as_of: string; scoring_hash: string | null;
  players: CoreInput["players"]; projections: Projection[]; anomalies: ReturnType<typeof detectAnomalies>;
  availability: ReturnType<typeof getAvailability>[]; signals: ReturnType<typeof evaluateSignals>;
  matchups: (ReturnType<typeof estimateAdjustedMatchup> & {player_id: string})[];
  quality: QualityIssue[]; gate: { accepted: boolean; reason: string }; seed: number;
  persistence: "memory" | "neon"; sources_consulted: string[];
}

export function leagueScope(league: ExternalSyncPayload) {
  return `${league.source}:${league.league.leagueId ?? league.league.name}:${league.league.teamId ?? ""}:${league.league.season}`;
}

const knownScoring = new Set(["passYards", "passTd", "interceptions", "rushYards", "rushTd", "receptions", "reception", "recYards", "recTd", "fumblesLost"]);
export function scoringFromLeague(league: ExternalSyncPayload): Scoring | null {
  const weights = league.league.scoring;
  // Unknown keys may be bonuses or DST/K rules. Never silently drop them.
  if (!weights || !Object.keys(weights).length || Object.keys(weights).some((key) => !knownScoring.has(key)) || ["passYards", "passTd", "interceptions", "rushYards", "rushTd", "recYards", "recTd", "fumblesLost"].some((key) => weights[key] == null) || weights.receptions == null && weights.reception == null) return null;
  return { rules: Object.entries(weights).map(([stat, points]) => ({ stat: stat === "reception" ? "receptions" : stat, points, mode: "linear" as const })), source: league.source, as_of: league.sourceTimestamp, fetched_at: league.fetchedAt ?? league.sourceTimestamp };
}

export function inputFromLeague(league: ExternalSyncPayload): CoreInput {
  const all = [...league.roster, ...league.freeAgents, ...(league.opponent?.roster ?? []), ...(league.tradePartners ?? []).flatMap((team) => team.roster)];
  const unique = [...new Map(all.map((player) => [player.providerId, player])).values()];
  const available = new Set(league.freeAgents.map((player) => player.providerId));
  const scoring = scoringFromLeague(league);
  const hash = scoring ? scoringHash(scoring) : null;
  const { season, week } = league.league;
  return coreInputSchema.parse({
    scope: leagueScope(league), season, week, as_of: league.sourceTimestamp, scoring,
    scoring_reason: scoring ? undefined : "League scoring is absent or contains unsupported rules; import complete canonical scoring including bonuses/DST/K",
    players: unique.map((player) => ({ player_id: providerPlayerId(league.source, player.providerId), name: player.name, team_id: player.team, position: player.position, available: available.has(player.providerId), status: player.injury, kickoff: player.kickoff ?? null, bye: null, evidence: {source: league.source, as_of: league.sourceTimestamp, fetched_at: league.fetchedAt ?? league.sourceTimestamp, estimated: false} })),
    features: unique.flatMap((player) => buildFeatureRows({ player: { player_id: providerPlayerId(league.source, player.providerId) }, season, week, asOf: league.sourceTimestamp, fetchedAt: league.fetchedAt ?? league.sourceTimestamp, source: league.source, version: FEATURE_VERSION, values: {} })),
    projections: hash ? unique.flatMap((player) => player.projection == null ? [] : [{ player_id: providerPlayerId(league.source, player.providerId), season, week, scenario: "base", points: player.projection, scoring_hash: hash, source: league.source, as_of: league.sourceTimestamp, fetched_at: league.fetchedAt ?? league.sourceTimestamp, estimated: true, method: "Unmodified provider league projection" }]) : [],
  });
}

export async function runCore(supplied?: CoreInput, now = new Date()): Promise<CoreRun> {
  let input = supplied ? coreInputSchema.parse(supplied) : await getCoreInput();
  if (!supplied) {
    const league = externalSyncSchema.safeParse(await getLatestExternalIngest());
    if (league.success && (!input || Date.parse(league.data.sourceTimestamp) > Date.parse(input.as_of))) input = inputFromLeague(league.data);
  }
  if (!input) throw new Error("CORE_INPUT_MISSING");
  const clock = now.toISOString();
  const hash = input.scoring ? scoringHash(input.scoring) : null;
  // Reject critical missing/stale league state before building thousands of placeholder feature errors.
  const leagueIssues: QualityIssue[] = [];
  if (now.getTime() - Date.parse(input.as_of) > 86400000 || Date.parse(input.as_of) > now.getTime()) leagueIssues.push({entity_id:"league",name:"as_of",reason:"League snapshot stale or future"});
  if (!input.scoring) leagueIssues.push({entity_id:"league",name:"scoring",reason:input.scoring_reason ?? "Scoring missing"});
  if (leagueIssues.length) {
    const retained = {...input, features: input.features.filter((feature) => feature.value !== null)};
    const digest = createHash("sha256").update(JSON.stringify({input:retained,quality:leagueIssues,implementation:"core-run-v2-critical-gate"})).digest("hex");
    const prior = await getCoreRun(input.scope,digest); if (prior) return prior;
    const blocked: CoreRun = {run_id:digest,input_digest:digest,scope:input.scope,season:input.season,week:input.week,created_at:clock,source_as_of:input.as_of,scoring_hash:hash,model_version:null,status:"BLOCKED",players:[],projections:[],anomalies:[],availability:[],signals:[],matchups:[],quality:leagueIssues,gate:{accepted:false,reason:leagueIssues.map((issue)=>issue.reason).join("; ")},seed:42,persistence:serverEnv().DATABASE_URL?"neon":"memory",sources_consulted:[]};
    await saveCoreRun(retained,blocked,[]); return blocked;
  }
  const artifact = await getModel(hash);
  const validation = validateFeatureRows(input.features, { asOf: clock, season: input.season, week: input.week, maxAgeHours: 24 });
  const quality = [...validation.issues];
  if (now.getTime() - Date.parse(input.as_of) > 24 * 3600000 || Date.parse(input.as_of) > now.getTime()) quality.push({ entity_id: "league", name: "as_of", reason: "League snapshot stale or future" });
  if (!input.scoring) quality.push({ entity_id: "league", name: "scoring", reason: input.scoring_reason ?? "Scoring missing" });
  const teams = [...new Set(input.players.map((player) => player.team_id))];
  const availability = teams.map((team) => getAvailability(team, input!.players, input!.roles, input!.splits, input!.scenarios, { asOf: clock, maxAgeHours: 24 }));
  for (const row of availability) for (const reason of row.issues) quality.push({ entity_id: row.team_id, name: "availability", reason });
  const validInput = { ...input, features: validation.valid, as_of: clock };
  const matchups = input.players.flatMap((player) => {
    if (!player.opponent_team_id || !["QB", "RB", "WR", "TE"].includes(player.position)) return [];
    const ownVolume = validation.valid.find((feature) => feature.entity_id === player.player_id && feature.name === (player.position === "RB" ? "expected_carries" : player.position === "QB" ? "expected_dropbacks" : "expected_targets"));
    const baseline = input!.projections.find((row) => row.player_id === player.player_id && row.scoring_hash === hash && row.scenario === "base");
    const observations = input!.defense_observations.filter((row) => row.scoring_hash === hash);
    const alignments = [...new Set(["all" as const, ...observations.filter((row) => row.defense_team_id === player.opponent_team_id && row.position === player.position).map((row) => row.alignment)])];
    return alignments.map((alignment) => ({...estimateAdjustedMatchup({defense_team_id: player.opponent_team_id!, season: input!.season, week: input!.week, position: player.position, phase: player.position === "RB" ? "rush" : player.position === "QB" ? "passing" : "receiving", alignment, expected_opportunities: alignment === "all" ? ownVolume?.value ?? null : null, own_expected_points: alignment === "all" ? baseline?.points ?? null : null, own_volume_evidence: alignment === "all" ? ownVolume ?? null : null, observations, asOf: clock}), player_id: player.player_id}));
  });
  for (const player of input.players) {
    const matchup = matchups.find((row) => row.player_id === player.player_id && row.alignment === "all");
    if (!matchup || matchup.adjusted_ratio == null || matchup.sample_games < matchup.config.minSample || matchup.expected_opportunities == null || matchup.expected_opportunities < matchup.config.minVolume[player.position]) continue;
    const generated = {entity_id: player.player_id, season: input.season, week: input.week, name: "defense_adjusted_ratio", value: matchup.adjusted_ratio, source: "core:matchup", as_of: clock, fetched_at: clock, version: FEATURE_VERSION, estimated: true, method: matchup.method + "; computed from explicit historical observations at run time, not a newly fetched provider observation"};
    validInput.features = [...validInput.features.filter((row) => !(row.entity_id === player.player_id && row.name === generated.name && row.source === generated.source)), generated];
  }
  const projections: Projection[] = [];
  for (const player of input.players) {
    let base = projectPlayer(player, validInput, artifact);
    const scenarios = input.scenarios.filter((scenario) => scenario.team_id === player.team_id);
    const conditional = scenarios.map((scenario) => ({ probability: scenario.probability, projection: projectPlayer(player, validInput, artifact, scenario.id) }));
    const block = availability.find((row) => row.team_id === player.team_id)?.issues.length || quality.some((row) => row.entity_id === "league");
    if (block) for (const row of conditional) {row.projection.eligible=false; row.projection.reason=row.projection.reason ?? "Critical league/availability evidence missing";}
    if (conditional.length) base = mixScenarios(conditional, base);
    if (availability.find((row) => row.team_id === player.team_id)?.issues.length || quality.some((row) => row.entity_id === "league")) base = { ...base, eligible: false, reason: base.reason ?? "Critical league/availability evidence missing" };
    projections.push(base, ...conditional.map((row) => row.projection));
  }
  const invalid = projections.filter((row) => !validDistribution(row));
  if (invalid.length || new Set(projections.map((row) => `${row.player_id}|${row.season}|${row.week}|${row.scenario}`)).size !== projections.length) throw new Error("CORE_VERIFIER_REJECTED");
  const futureProjections = await getFutureProjections(input.scope, input.season, input.week, clock);
  if (hash && input.week < 18) for (const player of input.players) {
    const availableIds = new Set(input.players.filter((candidate) => candidate.available && candidate.position === player.position).map((candidate) => candidate.player_id));
    const horizon = horizonValue({playerId: player.player_id, season: input.season, fromWeek: input.week + 1, throughWeek: 18, playoffWeeks: input.playoff_weeks, projections: futureProjections, replacementProjections: futureProjections.filter((row) => availableIds.has(row.player_id)), starterCounts: input.starter_counts, position: player.position, scoringHash: hash});
    const base = projections.find((row) => row.player_id === player.player_id && row.scenario === "base");
    if (base) { base.ros_mean = horizon.ros_mean; base.ros_sd = horizon.ros_sd; base.playoff_mean = horizon.playoff_mean; base.war = horizon.war; base.missing = [...base.missing, ...horizon.reason]; }
  }
  const signals = evaluateSignals(input.signals, input.policies.length ? input.policies : NFL_SOURCE_POLICIES, { asOf: clock });
  // Signals have no calibrated point coefficient yet. They widen uncertainty only.
  for (const row of projections) {
    const rumors = signals.filter((signal) => signal.usable && signal.label === "RUMOR" && (signal.player_id === row.player_id || signal.team_id === input!.players.find((player) => player.player_id === row.player_id)?.team_id));
    if (rumors.length) {
      const uncertainty = Math.min(.25, rumors.reduce((sum, signal) => sum + (signal.uncertainty_score ?? 0) / 400, 0));
      if (row.sd != null) row.sd *= 1 + uncertainty;
      if (row.mean != null && row.p10 != null && row.p90 != null) { row.p10 -= Math.abs(row.mean - row.p10) * uncertainty; row.p90 += Math.abs(row.p90 - row.mean) * uncertainty; }
      row.drivers.push(...rumors.map((signal) => ({ block: "signal" as const, contribution: 0, text: `${signal.label}: ${signal.summary}`, evidence: [signal.evidence], estimated: true, method: "Rumor uncertainty only; mean unchanged" })));
      row.eligible = false; row.reason = "Unconfirmed signal requires review; interval inflation uncalibrated";
    }
  }
  const anomalies = detectAnomalies(input.players, validation.valid, { asOf: clock, season: input.season, week: input.week, maxAgeHours: 24 });
  const digest = createHash("sha256").update(JSON.stringify({ input, quality, futureProjections, artifact_version: artifact?.version ?? null, implementation: "core-run-v1" })).digest("hex");
  const existing = await getCoreRun(input.scope, digest);
  if (existing) return existing;
  const accepted = Boolean(artifact?.gate.accepted && artifact.gate.real_data && artifact.scoring_hash === hash && artifact.feature_version === FEATURE_VERSION && projections.some((row) => row.scenario === "base" && row.eligible && row.model_version === artifact.version));
  const run: CoreRun = {
    run_id: digest, input_digest: digest, scope: input.scope, season: input.season, week: input.week, created_at: clock,
    source_as_of: input.as_of, scoring_hash: hash, model_version: artifact?.version ?? null, players: input.players,
    status: quality.some((row) => row.entity_id === "league") ? "BLOCKED" : accepted ? "VERIFIED" : "PARTIAL",
    projections, availability, anomalies, signals, matchups, quality,
    gate: { accepted, reason: accepted ? "Verified trained artifact; individual projections can still be blocked" : artifact?.gate.reason ?? "No real temporal backtest/artifact; consumers keep existing implementation" },
    seed: artifact?.seed ?? 42, persistence: "memory", sources_consulted: [],
  };
  // No claim of a live refresh: this job consumes explicitly timestamped ingested records.
  const adapter = await saveCoreRun(input, { ...run, persistence: serverEnv().DATABASE_URL ? "neon" : "memory" }, validInput.features);
  return { ...run, persistence: adapter };
}
