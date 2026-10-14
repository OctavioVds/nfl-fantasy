import { z } from "zod";

const finite = z.number().finite();
const stamp = z.string().datetime();
const id = z.string().min(1).max(180);
export const positionSchema = z.enum(["QB", "RB", "WR", "TE", "DST", "K"]);
export const evidenceSchema = z.object({ source: id, as_of: stamp, fetched_at: stamp, estimated: z.boolean(), method: z.string().optional(), reason: z.string().optional() }).superRefine((value, ctx) => {
  if (value.estimated && !value.method) ctx.addIssue({ code: "custom", message: "Estimated evidence requires method" });
});
export type Evidence = z.infer<typeof evidenceSchema>;
export const featureSchema = z.object({ entity_id: id, season: z.number().int().min(2020).max(2100), week: z.number().int().min(1).max(18), name: id, value: finite.nullable(), version: id, ...evidenceSchema.shape }).superRefine((value, ctx) => {
  if (value.value === null && !value.reason) ctx.addIssue({ code: "custom", message: "Null requires reason" });
  if (value.estimated && !value.method) ctx.addIssue({ code: "custom", message: "Estimate requires method" });
});
export type Feature = z.infer<typeof featureSchema>;
export const playerSchema = z.object({ player_id: id, name: id, team_id: id, position: positionSchema, available: z.boolean(), status: z.string().optional(), kickoff: stamp.nullable(), bye: z.boolean().nullable(), evidence: evidenceSchema.optional(), opponent_team_id: id.optional() });
export type CorePlayer = z.infer<typeof playerSchema>;
export const rolesSchema = z.object({ player_id: id, team_id: id, role: z.string().optional(), shares: z.record(z.string(), finite.min(0).max(100).nullable()), evidence: evidenceSchema });
export type Roles = z.infer<typeof rolesSchema>;
export const splitSchema = z.object({ a_id: id, b_id: id, metric: id, with_value: finite, without_value: finite, n_with: z.number().int().nonnegative(), n_without: z.number().int().nonnegative(), prior_strength: finite.positive(), prior_delta: finite, evidence: evidenceSchema });
export type TeammateSplit = z.infer<typeof splitSchema>;
export const scenarioSchema = z.object({ id: id.refine((value) => value.toLowerCase() !== "base", "base is reserved for the unconditional projection"), team_id: id, probability: finite.min(0).max(1), absent_player_ids: z.array(id).max(20), qb_id: id.nullable(), evidence: evidenceSchema });
export type Scenario = z.infer<typeof scenarioSchema>;
export const sourcePolicySchema = z.object({ id, url: z.string().url(), tier: z.enum(["official", "beat", "media"]), reliability: finite.min(0).max(100).nullable(), version: id, permitted: z.boolean() });
export type SourcePolicy = z.infer<typeof sourcePolicySchema>;
export const signalSchema = z.object({ id, source_id: id, player_id: id.nullable(), team_id: id.nullable(), kind: id, summary: z.string().min(1).max(500), confirmed: z.boolean(), second_source_id: id.nullable(), ts: stamp, evidence: evidenceSchema });
export type SocialSignal = z.infer<typeof signalSchema>;
export interface Anomaly { player_id: string; signal: string; evidence: Feature[]; strength: number; duration: string; risk: string; estimated: true; method: string }
export const scoringSchema = z.object({ rules: z.array(z.object({ stat: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/), points: finite, position: positionSchema.optional(), threshold: finite.optional(), mode: z.enum(["linear", "bonus"]) })).min(1).max(150), source: id, as_of: stamp, fetched_at: stamp }).superRefine((scoring, ctx) => {
  if (scoring.rules.some((rule) => rule.mode === "bonus" && rule.threshold == null)) ctx.addIssue({ code: "custom", message: "Bonus threshold missing" });
  const keys = scoring.rules.map((rule) => `${rule.stat}|${rule.position ?? ""}|${rule.mode}|${rule.threshold ?? ""}`);
  if (new Set(keys).size !== keys.length) ctx.addIssue({ code: "custom", message: "Duplicate scoring rule" });
});
export type Scoring = z.infer<typeof scoringSchema>;
export const externalProjectionSchema = z.object({ player_id: id, season: z.number().int(), week: z.number().int().min(1).max(18), scenario: id.default("base"), points: finite, scoring_hash: id, ...evidenceSchema.shape });
export type ExternalProjection = z.infer<typeof externalProjectionSchema>;
export const defenseObservationSchema = z.object({ defense_team_id: id, season: z.number().int(), week: z.number().int().min(1).max(18), position: positionSchema, phase: z.enum(["rush", "receiving", "passing"]), alignment: z.enum(["all", "slot", "outside", "inline", "backfield"]), allowed_points: finite, opportunities: finite.positive(), opponent_expected_points: finite.positive(), opponent_expected_opportunities: finite.positive(), scoring_hash: id, evidence: evidenceSchema });
const ridgeSchema = z.object({ features: z.array(id).min(1), coefficients: z.array(finite), intercept: finite, means: z.array(finite), residuals: z.array(finite).min(20), ensemble_weight: finite.min(0).max(1), bias: finite, conformal_radius: finite.nonnegative(), sd: finite.nonnegative(), prob_play: finite.min(0).max(1).nullable(), availability_reason: z.string(), accepted: z.boolean(), training_cutoff: stamp, ensemble_calibration_cutoff: stamp, calibration_cutoff: stamp, train_samples: z.number().int().positive(), ensemble_calibration_samples: z.number().int().min(20), calibration_samples: z.number().int().min(20) }).superRefine((model, ctx) => {
  if (model.features.length !== model.coefficients.length || model.features.length !== model.means.length || new Set(model.features).size !== model.features.length) ctx.addIssue({ code: "custom", message: "Invalid coefficient dimensions" });
});
export const artifactSchema = z.object({ version: id, format_version: id.optional(), training: z.record(z.string(), z.unknown()).optional(), scoring_hash: id, feature_version: id, trained_at: stamp, training_cutoff: stamp, seed: z.number().int(), data_digest: id, models: z.record(z.string(), ridgeSchema), metrics: z.record(z.string(), z.unknown()), gate: z.object({ accepted: z.boolean(), reason: z.string(), real_data: z.boolean(), positions: z.record(z.string(), z.unknown()).optional() }) });
export type ModelArtifact = z.infer<typeof artifactSchema>;
const baseCoreInputSchema = z.object({ scope: id, season: z.number().int().min(2020).max(2100), week: z.number().int().min(1).max(18), as_of: stamp, scoring: scoringSchema.nullable(), scoring_reason: z.string().optional(), players: z.array(playerSchema).max(2500), features: z.array(featureSchema).max(300000).default([]), roles: z.array(rolesSchema).max(2500).default([]), splits: z.array(splitSchema).max(20000).default([]), scenarios: z.array(scenarioSchema).max(300).default([]), signals: z.array(signalSchema).max(1000).default([]), policies: z.array(sourcePolicySchema).max(1000).default([]), projections: z.array(externalProjectionSchema).max(20000).default([]) }).superRefine((data, ctx) => {
  if (!data.scoring && !data.scoring_reason) ctx.addIssue({ code: "custom", message: "Missing scoring reason" });
  const ids = new Set(data.players.map((player) => player.player_id));
  if (ids.size !== data.players.length) ctx.addIssue({ code: "custom", message: "Duplicate player ID" });
  if (new Set(data.signals.map((signal) => signal.id)).size !== data.signals.length) ctx.addIssue({ code: "custom", message: "Duplicate social signal ID" });
  if ([...data.roles.map((role) => role.player_id), ...data.splits.flatMap((split) => [split.a_id, split.b_id]), ...data.scenarios.flatMap((scenario) => [...scenario.absent_player_ids, ...(scenario.qb_id ? [scenario.qb_id] : [])]), ...data.projections.map((p) => p.player_id)].some((pid) => !ids.has(pid))) ctx.addIssue({ code: "custom", message: "Unknown player ID" });
  for (const team of new Set(data.scenarios.map((scenario) => scenario.team_id))) {
    const scenarios = data.scenarios.filter((scenario) => scenario.team_id === team);
    if (Math.abs(scenarios.reduce((sum, scenario) => sum + scenario.probability, 0) - 1) > 1e-8 || new Set(scenarios.map((scenario) => scenario.id)).size !== scenarios.length) ctx.addIssue({ code: "custom", message: "Scenarios must be unique and sum to one" });
    if (scenarios.some((scenario) => [...scenario.absent_player_ids, ...(scenario.qb_id ? [scenario.qb_id] : [])].some((pid) => data.players.find((player) => player.player_id === pid)?.team_id !== team))) ctx.addIssue({ code: "custom", message: "Teammate belongs to different team" });
  }
});
export const coreInputSchema = baseCoreInputSchema.safeExtend({ defense_observations: z.array(defenseObservationSchema).max(20000).default([]), playoff_weeks: z.array(z.number().int().min(1).max(18)).nullable().default(null), starter_counts: z.record(z.string(),z.number().int().positive()).nullable().default(null) });
export type CoreInput = z.infer<typeof coreInputSchema>;
export interface Driver { block: "volume" | "matchup" | "context" | "baseline" | "availability" | "signal"; contribution: number | null; text: string; evidence: Evidence[]; estimated: boolean; method: string }
export interface Projection { player_id: string; season: number; week: number; scenario: string; mean: number | null; sd: number | null; p10: number | null; p50: number | null; p90: number | null; prob_play: number | null; confidence: number; drivers: Driver[]; model_version: string | null; scoring_hash: string | null; as_of: string; fetched_at: string; estimated: boolean; method: string; reason: string | null; missing: string[]; eligible: boolean; ros_mean: number | null; ros_sd: number | null; playoff_mean: number | null; war: number | null; residual_support?: { value: number; probability: number }[] }
