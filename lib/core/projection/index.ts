import type { CoreInput, CorePlayer, Driver, ModelArtifact, Projection } from "../schema";
import { artifactSchema } from "../schema";
import { scoringHash } from "../scoring";
import { shrinkTeammateSplit, validateScenarios } from "../availability";
import { DEFAULT_SOURCE_PRIORITY, FEATURE_CATALOG, validateFeatureRows } from "../features";

export const FEATURE_VERSION = "core-features-v1";
export interface ProjectionConfig { maxAgeHours?: number; maxMissingFraction?: number; maxSourceAbsoluteDivergence?: number; maxSourceRelativeDivergence?: number; sourcePriority?: Record<string, number> }
const DEFAULT_CONFIG = { maxAgeHours: 24, maxMissingFraction: .5, maxSourceAbsoluteDivergence: 5, maxSourceRelativeDivergence: .3 };
const catalogBlocks = new Map(FEATURE_CATALOG.map((feature) => [feature.name, feature.block]));
const unavailableStatus = /^(OUT|O|IR|INACTIVE|PUP|SUSPENDED|SUSP)$/i;
const fresh = (row: { as_of: string; fetched_at: string }, now: string, kickoff: string | null, maxAgeHours = 24) => {
  const cutoff = Date.parse(now), sourceTime = Date.parse(row.as_of), fetchedTime = Date.parse(row.fetched_at), kick = kickoff ? Date.parse(kickoff) : Infinity;
  return [cutoff, sourceTime, fetchedTime].every(Number.isFinite) && (kick === Infinity || Number.isFinite(kick)) && sourceTime <= cutoff && fetchedTime <= cutoff && fetchedTime >= sourceTime && cutoff - sourceTime <= maxAgeHours * 3_600_000 && sourceTime < kick && fetchedTime < kick;
};
const average = (values: readonly number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
const sampleVariance = (values: readonly number[], mean = average(values)) => values.length < 2 ? 0 : values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
const median = (ordered: readonly number[]) => ordered.length % 2 ? ordered[Math.floor(ordered.length / 2)] : (ordered[ordered.length / 2 - 1] + ordered[ordered.length / 2]) / 2;
export function calibrationOffsets(residuals: readonly number[]) {
  if (residuals.length < 20 || residuals.some((value) => !Number.isFinite(value))) throw new Error("At least twenty finite chronological calibration residuals are required");
  const ordered = [...residuals].sort((a, b) => a - b);
  return { p10: ordered[Math.max(0, Math.floor((ordered.length + 1) * .1) - 1)], p50: median(ordered), p90: ordered[Math.min(ordered.length - 1, Math.ceil((ordered.length + 1) * .9) - 1)] };
}

export function nullProjection(player: CorePlayer, input: CoreInput, scenario: string, reason: string): Projection {
  return { player_id: player.player_id, season: input.season, week: input.week, scenario, mean: null, sd: null, p10: null, p50: null, p90: null, prob_play: null, confidence: 0, drivers: [], model_version: null, scoring_hash: input.scoring ? scoringHash(input.scoring) : null, as_of: input.as_of, fetched_at: input.as_of, estimated: false, method: "unavailable", reason, missing: [reason], eligible: false, ros_mean: null, ros_sd: null, playoff_mean: null, war: null };
}

/** Pure inference uses raw-unit coefficients and chronological calibration exported offline. */
export function projectPlayer(player: CorePlayer, input: CoreInput, supplied: ModelArtifact | null, scenario = "base", suppliedConfig: ProjectionConfig = {}): Projection {
  const config = { ...DEFAULT_CONFIG, ...suppliedConfig };
  if (!(config.maxAgeHours > 0) || config.maxMissingFraction < 0 || config.maxMissingFraction > 1 || config.maxSourceAbsoluteDivergence < 0 || config.maxSourceRelativeDivergence < 0) throw new Error("Invalid projection configuration");
  const empty = nullProjection(player, input, scenario, "No calibrated model available");
  if (!input.players.some((row) => row.player_id === player.player_id && row.team_id === player.team_id && row.position === player.position)) return { ...empty, reason: "Unknown or inconsistent canonical player ID" };
  if (!input.scoring) return { ...empty, reason: input.scoring_reason ?? "League scoring unavailable" };
  if (!fresh(input.scoring, input.as_of, player.kickoff, config.maxAgeHours)) return { ...empty, reason: "League scoring provenance is stale, future or post-kickoff" };
  if (!player.evidence || !player.evidence.source || !fresh(player.evidence, input.as_of, player.kickoff, config.maxAgeHours)) return { ...empty, reason: "Availability and schedule provenance is missing, stale, future or post-kickoff" };
  const teamScenarios = input.scenarios.filter((row) => row.team_id === player.team_id);
  const conditional = scenario === "base" ? null : teamScenarios.find((row) => row.id === scenario);
  if (scenario !== "base" && !conditional) return { ...empty, reason: "Unknown availability scenario" };
  if (conditional && (validateScenarios(teamScenarios, input.players.filter((row) => row.team_id === player.team_id), player.team_id).length || !fresh(conditional.evidence, input.as_of, player.kickoff, config.maxAgeHours))) return { ...empty, reason: "Invalid or stale availability scenario" };
  if (player.bye === true) return zeroProjection(empty, "Bye confirmed");
  if (!player.kickoff || !Number.isFinite(Date.parse(player.kickoff)) || player.bye === null) return { ...empty, reason: "Kickoff/bye not confirmed" };
  if (Date.parse(player.kickoff) <= Date.parse(input.as_of)) return { ...empty, reason: "Game locked: pregame projection cannot be regenerated after kickoff" };
  if (conditional?.absent_player_ids.includes(player.player_id) || unavailableStatus.test(player.status ?? "")) return zeroProjection(empty, "Unavailable in this verified scenario");
  const hash = scoringHash(input.scoring);
  const raw = input.projections.filter((row) => row.player_id === player.player_id && row.season === input.season && row.week === input.week && row.scoring_hash === hash && row.scenario === scenario && Number.isFinite(row.points) && fresh(row, input.as_of, player.kickoff, config.maxAgeHours));
  const bySource = new Map<string, typeof raw>();
  for (const row of raw) bySource.set(row.source.toLowerCase(), [...(bySource.get(row.source.toLowerCase()) ?? []), row]);
  const latest = [...bySource.values()].flatMap((rows) => {
    const newest = Math.max(...rows.map((row) => Date.parse(row.as_of)));
    const observations = rows.filter((row) => Date.parse(row.as_of) === newest);
    return new Set(observations.map((row) => row.points)).size > 1 ? [] : [observations.sort((a, b) => Date.parse(b.fetched_at) - Date.parse(a.fetched_at))[0]];
  });
  const conflictingSources = bySource.size !== latest.length;
  const baseline = latest.find((row) => /^espn$/i.test(row.source)) ?? latest.find((row) => /^flaim:espn$/i.test(row.source));
  // A provider's point forecast has neither a known median nor known uncertainty.
  const fallback: Projection = baseline ? { ...empty, mean: baseline.points, method: "external-league-baseline", reason: "Baseline only; calibrated distribution unavailable", missing: ["Calibrated distribution unavailable"], drivers: [{ block: "baseline", contribution: baseline.points, text: "Original " + baseline.source + " league point projection", evidence: [baseline], estimated: true, method: "Unmodified provider point estimate; no assumed quantiles" }] } : empty;
  const parsed = artifactSchema.safeParse(supplied);
  if (!parsed.success) return fallback;
  const artifact = parsed.data;
  if (artifact.scoring_hash !== hash || artifact.feature_version !== FEATURE_VERSION || !artifact.gate.accepted || !artifact.gate.real_data) return fallback;
  const trainedAt = Date.parse(artifact.trained_at), globalCutoff = Date.parse(artifact.training_cutoff), now = Date.parse(input.as_of), kickoff = Date.parse(player.kickoff);
  if (!Number.isFinite(trainedAt) || !Number.isFinite(globalCutoff) || trainedAt > now || globalCutoff > trainedAt || globalCutoff >= kickoff) return { ...fallback, reason: "Model temporal cutoff invalid" };
  const model = artifact.models[player.position];
  if (!model || !model.accepted) return { ...fallback, reason: "No accepted position model" };
  if (model.features.some((name) => !catalogBlocks.has(name))) return { ...fallback, reason: "Model feature is not supported by this feature version" };
  if (model.train_samples < 50 || model.ensemble_calibration_samples < 20 || model.calibration_samples < 20 || model.calibration_samples !== model.residuals.length) return { ...fallback, reason: "Model sample metadata is insufficient or inconsistent" };
  const positionGate = artifact.gate.positions?.[player.position];
  if (positionGate !== undefined && (typeof positionGate !== "object" || positionGate === null || !("accepted" in positionGate) || positionGate.accepted !== true)) return { ...fallback, reason: "Position gate contradicts model acceptance" };
  if (artifact.format_version && artifact.format_version !== "core-ridge-v1") return { ...fallback, reason: "Unknown artifact format" };
  if (artifact.training && artifact.training.interval_method !== "split-conformal-equal-tail") return { ...fallback, reason: "Unsupported calibration method" };
  const modelTimes = [model.training_cutoff, model.ensemble_calibration_cutoff, model.calibration_cutoff].map(Date.parse);
  if (modelTimes.some((time) => !Number.isFinite(time) || time >= kickoff || time > trainedAt) || modelTimes[0] > modelTimes[1] || modelTimes[1] > modelTimes[2]) return { ...fallback, reason: "Position model chronology invalid" };
  if (model.ensemble_weight < 1 && !baseline) return { ...empty, reason: "Calibrated ensemble requires an ESPN baseline for this exact scenario" };
  const validated = validateFeatureRows(input.features, { asOf: input.as_of, season: input.season, week: input.week, cutoff: input.as_of, maxAgeHours: config.maxAgeHours });
  const priorities = { ...DEFAULT_SOURCE_PRIORITY, ...config.sourcePriority };
  const ordered = validated.valid.filter((row) => row.entity_id === player.player_id && row.version === FEATURE_VERSION && fresh(row, input.as_of, player.kickoff, config.maxAgeHours))
    .sort((a, b) => (priorities[a.source.toLowerCase()] ?? 100) - (priorities[b.source.toLowerCase()] ?? 100) || Date.parse(b.as_of) - Date.parse(a.as_of) || a.source.localeCompare(b.source));
  const features = new Map<string, typeof ordered[number]>();
  for (const row of ordered) if (!features.has(row.name) && row.value !== null) features.set(row.name, row);
  let modelMean = model.intercept;
  const drivers: Driver[] = [{ block: "context", contribution: model.intercept * model.ensemble_weight, text: "Position Ridge intercept", evidence: [], estimated: true, method: artifact.version }];
  const missing: string[] = [];
  const weatherNames = new Set(["wind_mph", "rain_mm", "snow_mm", "temperature_f"]);
  const dome = features.get("dome");
  for (let index = 0; index < model.features.length; index++) {
    const name = model.features[index], row = features.get(name), coefficient = model.coefficients[index];
    if (weatherNames.has(name) && dome?.value !== 0 && dome?.value !== 1) return {...fallback,eligible:false,reason:"Weather contribution requires verified open/covered stadium"};
    const indoor = weatherNames.has(name) && dome?.value === 1;
    const original = indoor ? 0 : row?.value ?? model.means[index];
    let value = original;
    if (row?.value == null && !indoor) missing.push(name);
    const relevantSplits = input.splits.filter((split) => split.a_id === player.player_id && split.metric === name && conditional?.absent_player_ids.includes(split.b_id));
    for (const split of relevantSplits) {
      const teammate = input.players.find((candidate) => candidate.player_id === split.b_id);
      if (!teammate || teammate.team_id !== player.team_id || !fresh(split.evidence, input.as_of, player.kickoff, config.maxAgeHours)) return { ...fallback, reason: "Conditional WOWY evidence is stale or references a different team" };
      const shrunk = shrinkTeammateSplit(split);
      if (shrunk.shrunk_delta === null) return { ...fallback, reason: "Conditional WOWY prior or sample unavailable" };
      value += shrunk.shrunk_delta;
      drivers.push({ block: "availability", contribution: shrunk.shrunk_delta * coefficient * model.ensemble_weight, text: name + ": WOWY teammate " + split.b_id + ", effective sample " + shrunk.effective_sample, evidence: [split.evidence], estimated: true, method: shrunk.method + "; learned coefficient " + artifact.version });
    }
    modelMean += value * coefficient;
    const block = catalogBlocks.get(name);
    drivers.push({ block: block === "matchup" ? "matchup" : block === "volume" || block === "anomaly" ? "volume" : "context", contribution: indoor ? 0 : original * coefficient * model.ensemble_weight, text: indoor ? name + ": weather coefficient disabled in confirmed covered venue" : row?.value == null ? name + ": train-only mean imputation" : name, evidence: indoor && dome ? [dome] : row ? [row] : [], estimated: true, method: artifact.version });
  }
  if (missing.length / model.features.length > config.maxMissingFraction) return { ...fallback, reason: "More than the configured fraction of model features is unavailable", missing };
  const calibrationBias = average(model.residuals);
  const calibrationSd = Math.sqrt(sampleVariance(model.residuals, calibrationBias));
  if (Math.abs(calibrationBias - model.bias) > 1e-7 || Math.abs(calibrationSd - model.sd) > 1e-7) return { ...fallback, reason: "Model calibration moments disagree with archived residuals" };
  const rawMean = modelMean * model.ensemble_weight + (baseline?.points ?? 0) * (1 - model.ensemble_weight);
  const mean = rawMean + calibrationBias;
  drivers.push({ block: "context", contribution: calibrationBias, text: "Bias correction learned from preceding interval-calibration window", evidence: [], estimated: true, method: artifact.version });
  if (baseline) drivers.push({ block: "baseline", contribution: baseline.points * (1 - model.ensemble_weight), text: "Learned ESPN ensemble weight for this scenario", evidence: [baseline], estimated: true, method: artifact.version });
  const providerValues = latest.map((row) => row.points);
  const spread = providerValues.length > 1 ? Math.max(...providerValues) - Math.min(...providerValues) : 0;
  const offsets = calibrationOffsets(model.residuals.map((residual) => residual - calibrationBias));
  const probability = features.get("prob_play")?.value;
  const ownAvailabilityModeled = conditional !== null && teamScenarios.some((row) => row.absent_player_ids.includes(player.player_id));
  const probPlay = ownAvailabilityModeled ? 1 : probability === undefined || probability === null ? /^ACTIVE$/i.test(player.status ?? "") ? 1 : model.prob_play : probability / 100;
  if (ownAvailabilityModeled) drivers.push({ block: "availability", contribution: 0, text: "This conditional scenario explicitly includes the player; absence probability is applied once when mixing scenarios", evidence: conditional ? [conditional.evidence] : [], estimated: true, method: "Conditional availability event; no second probability multiplier" });
  const criticalMissing: string[] = [];
  if (probPlay === null) criticalMissing.push("Calibrated probability of playing unavailable");
  if (conflictingSources) criticalMissing.push("Contradictory duplicate provider forecasts require review");
  const diverged = spread > Math.max(config.maxSourceAbsoluteDivergence, Math.abs(mean) * config.maxSourceRelativeDivergence);
  if (diverged) criticalMissing.push("Strong source divergence: manual review required");
  // Extra uncertainty is actual empirical provider dispersion, explicitly uncalibrated.
  const sourceCenter = providerValues.length ? average(providerValues) : 0;
  const sourceOffsets = diverged ? providerValues.map((points) => points - sourceCenter) : [0];
  const residualSupport = model.residuals.flatMap((residual) => sourceOffsets.map((sourceOffset) => ({ value: mean + residual - calibrationBias + sourceOffset, probability: 1 / (model.residuals.length * sourceOffsets.length) })));
  const sd = Math.sqrt(calibrationSd ** 2 + (diverged ? sampleVariance(providerValues, sourceCenter) : 0));
  const p10 = diverged ? weightedQuantile(residualSupport, .1) : mean + offsets.p10;
  const p50 = diverged ? weightedQuantile(residualSupport, .5) : mean + offsets.p50;
  const p90 = diverged ? weightedQuantile(residualSupport, .9) : mean + offsets.p90;
  if (diverged) drivers.push({ block: "baseline", contribution: 0, text: "Observed source disagreement broadens uncertainty; mean unchanged and consumption blocked", evidence: latest, estimated: true, method: "Empirical provider-dispersion uncertainty; uncalibrated, manual review required" });
  return { ...empty, mean, sd, p10, p50, p90, prob_play: probPlay, confidence: Math.round(100 * (1 - missing.length / model.features.length) / (1 + spread / Math.max(1, Math.abs(mean)))), drivers, model_version: artifact.version, estimated: true, method: diverged ? "Ridge + learned ensemble + previous calibration bias/residuals; uncalibrated observed-source dispersion" : "Ridge + learned ensemble + previous calibration bias + equal-tail chronological residuals", reason: criticalMissing.join("; ") || null, missing: [...missing, ...criticalMissing], eligible: !criticalMissing.length, residual_support: residualSupport };
}

function zeroProjection(empty: Projection, reason: string): Projection {
  return { ...empty, mean: 0, sd: 0, p10: 0, p50: 0, p90: 0, prob_play: 0, confidence: 100, residual_support: [{ value: 0, probability: 1 }], reason, missing: [], method: "Verified schedule or availability determines zero opportunity", eligible: true };
}

function validSupport(support: Projection["residual_support"]): support is NonNullable<Projection["residual_support"]> {
  return !!support?.length && support.every((point) => Number.isFinite(point.value) && Number.isFinite(point.probability) && point.probability >= 0 && point.probability <= 1) && Math.abs(support.reduce((sum, point) => sum + point.probability, 0) - 1) <= 1e-8;
}
export function weightedQuantile(support: NonNullable<Projection["residual_support"]>, probability: number): number {
  if (!validSupport(support) || !Number.isFinite(probability) || probability < 0 || probability > 1) throw new Error("Invalid probability distribution support");
  const sorted = [...support].filter((point) => point.probability > 0).sort((a, b) => a.value - b.value);
  let cumulative = 0;
  for (const point of sorted) {
    cumulative += point.probability;
    if (cumulative + 1e-12 >= probability) return point.value;
  }
  return sorted[sorted.length - 1].value;
}

/** Full mixture CDF and total variance; unavailable components are never renormalized away. */
export function mixScenarios(rows: { probability: number; projection: Projection }[], base: Projection): Projection {
  if (!rows.length) return base;
  const fail = (reason: string): Projection => ({ ...base, eligible: false, reason });
  if (rows.some((row) => !Number.isFinite(row.probability) || row.probability < 0 || row.probability > 1) || Math.abs(rows.reduce((sum, row) => sum + row.probability, 0) - 1) > 1e-8) return fail("Scenario probabilities are invalid or do not sum to one");
  const components = rows.filter((row) => row.probability > 0);
  if (new Set(components.map((row) => row.projection.scenario)).size !== components.length) return fail("Duplicate conditional projection IDs");
  if (components.some(({ projection }) => projection.player_id !== base.player_id || projection.week !== base.week || projection.season !== base.season || projection.scoring_hash !== base.scoring_hash || !projection.eligible || !validDistribution(projection) || projection.mean === null || projection.sd === null || projection.prob_play === null || !validSupport(projection.residual_support))) return fail("Incomplete, mismatched or uncalibrated scenario mixture");
  const versions = new Set(components.map((row) => row.projection.model_version).filter((version) => version !== null));
  if (versions.size > 1) return fail("Conditional projections use different model versions");
  // An identity mixture must retain the same conformal order statistics validated offline.
  if (components.length === 1) return { ...components[0].projection, scenario: base.scenario, method: "Single probability-one availability scenario; " + components[0].projection.method };
  const mean = components.reduce((sum, row) => sum + row.probability * row.projection.mean!, 0);
  const variance = components.reduce((sum, row) => sum + row.probability * (row.projection.sd! ** 2 + (row.projection.mean! - mean) ** 2), 0);
  const support = components.flatMap((row) => row.projection.residual_support!.map((point) => ({ value: point.value, probability: point.probability * row.probability })));
  const missing = [...new Set(components.flatMap((row) => row.projection.missing))];
  return { ...base, mean, sd: Math.sqrt(Math.max(0, variance)), p10: weightedQuantile(support, .1), p50: weightedQuantile(support, .5), p90: weightedQuantile(support, .9), prob_play: components.reduce((sum, row) => sum + row.probability * row.projection.prob_play!, 0), confidence: Math.round(components.reduce((sum, row) => sum + row.probability * row.projection.confidence, 0)), residual_support: support, model_version: [...versions][0] ?? null, estimated: true, method: "Availability-weighted empirical conditional CDF with total variance; availability is not multiplied twice", eligible: true, reason: null, missing, drivers: components.flatMap((row) => row.projection.drivers.map((driver) => ({ ...driver, contribution: driver.contribution === null ? null : driver.contribution * row.probability, text: row.projection.scenario + " (P=" + row.probability + "): " + driver.text }))) };
}

export function validDistribution(row: Projection) {
  const values = [row.mean, row.sd, row.p10, row.p50, row.p90, row.prob_play];
  if (values.some((value) => value !== null && !Number.isFinite(value))) return false;
  if (row.residual_support !== undefined && !validSupport(row.residual_support)) return false;
  const ordered = [row.p10, row.p50, row.p90].filter((value): value is number => value !== null);
  if (ordered.some((value, index) => index > 0 && value < ordered[index - 1])) return false;
  if (row.eligible && values.some((value) => value === null)) return false;
  return (row.sd === null || row.sd >= 0) && (row.prob_play === null || row.prob_play >= 0 && row.prob_play <= 1) && Number.isFinite(row.confidence) && row.confidence >= 0 && row.confidence <= 100;
}
