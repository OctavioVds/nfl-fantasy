import type { Evidence } from "../schema";

export interface DefenseObservation {
  defense_team_id: string; season: number; week: number; position: string;
  phase: "rush" | "receiving" | "passing"; alignment: "all" | "slot" | "outside" | "inline" | "backfield";
  allowed_points: number; opportunities: number;
  opponent_expected_points: number; opponent_expected_opportunities: number;
  evidence: Evidence;
}
export interface MatchupInput {
  defense_team_id: string; season: number; week: number; position: string;
  phase: DefenseObservation["phase"]; alignment: DefenseObservation["alignment"];
  expected_opportunities: number | null; own_expected_points: number | null;
  observations: readonly DefenseObservation[]; asOf: string;
  own_volume_evidence: Evidence | null;
  defensive_absences?: readonly string[];
}
export interface MatchupConfig {
  priorStrength?: number; minSample?: number; maxFraction?: number;
  minVolume?: Record<string, number>; recentWeeks?: number; calibrated?: boolean;
}

export const DEFAULT_MATCHUP_CONFIG = {
  priorStrength: 8, minSample: 3, maxFraction: 0.15,
  minVolume: { QB: 15, RB: 5, WR: 3, TE: 2, K: 2, DST: 1 }, recentWeeks: 4,
  calibrated: false,
} as const;

/** Schedule-adjusted efficiency ratios separate the opponent's quality from opportunities actually faced. */
export function estimateAdjustedMatchup(input: MatchupInput, supplied: MatchupConfig = {}) {
  const config = { ...DEFAULT_MATCHUP_CONFIG, ...supplied, minVolume: { ...DEFAULT_MATCHUP_CONFIG.minVolume, ...supplied.minVolume } };
  if (!(config.priorStrength > 0) || !(config.minSample >= 1) || !(config.maxFraction >= 0 && config.maxFraction <= 1) || !(config.recentWeeks >= 1)) throw new Error("Invalid matchup configuration");
  const asOf = Date.parse(input.asOf);
  if (!Number.isFinite(asOf)) throw new Error("Invalid matchup asOf");
  const observations = input.observations.filter((row) => row.defense_team_id === input.defense_team_id && row.season === input.season && row.week < input.week && row.position === input.position && row.phase === input.phase && row.alignment === input.alignment
    && Number.isFinite(row.allowed_points) && Number.isFinite(row.opportunities) && row.opportunities > 0
    && Number.isFinite(row.opponent_expected_points) && row.opponent_expected_points > 0
    && Number.isFinite(row.opponent_expected_opportunities) && row.opponent_expected_opportunities > 0
    && !!row.evidence.source && Number.isFinite(Date.parse(row.evidence.as_of)) && Number.isFinite(Date.parse(row.evidence.fetched_at))
    && Date.parse(row.evidence.as_of) <= asOf && Date.parse(row.evidence.fetched_at) <= asOf);
  const byWeek = new Map<number, DefenseObservation[]>();
  for (const observation of observations) byWeek.set(observation.week, [...(byWeek.get(observation.week) ?? []), observation]);
  const rates = [...byWeek.entries()].map(([week, rows]) => {
    const received = rows.reduce((sum, row) => sum + row.opportunities, 0);
    const allowed = rows.reduce((sum, row) => sum + row.allowed_points, 0);
    const quality = rows.reduce((sum, row) => sum + row.opponent_expected_points / row.opponent_expected_opportunities * row.opportunities, 0);
    return { week, opportunities: received, ratio: allowed / quality };
  });
  const opportunities = rates.reduce((sum, row) => sum + row.opportunities, 0);
  const rawRatio = opportunities > 0 ? rates.reduce((sum, row) => sum + row.ratio * row.opportunities, 0) / opportunities : null;
  const n = rates.length;
  const weight = n / (n + config.priorStrength);
  const adjustedRatio = rawRatio === null ? null : 1 + weight * (rawRatio - 1);
  const recent = rates.filter((row) => row.week >= input.week - config.recentWeeks);
  const recentOpportunities = recent.reduce((sum, row) => sum + row.opportunities, 0);
  const recentRaw = recentOpportunities > 0 ? recent.reduce((sum, row) => sum + row.ratio * row.opportunities, 0) / recentOpportunities : null;
  const recentRatio = recentRaw === null ? null : 1 + recent.length / (recent.length + config.priorStrength) * (recentRaw - 1);
  const ownPoints = input.own_expected_points;
  const volume = input.expected_opportunities;
  const minimum = config.minVolume[input.position as keyof typeof config.minVolume];
  const provenanceOk = input.own_volume_evidence && !!input.own_volume_evidence.source && Number.isFinite(Date.parse(input.own_volume_evidence.as_of)) && Number.isFinite(Date.parse(input.own_volume_evidence.fetched_at))
    && Date.parse(input.own_volume_evidence.as_of) <= asOf && Date.parse(input.own_volume_evidence.fetched_at) <= asOf;
  let reason: string | null = null;
  if (ownPoints === null || !Number.isFinite(ownPoints) || volume === null || !Number.isFinite(volume) || volume < 0 || !provenanceOk) reason = "Own volume/points or eligible provenance unavailable";
  else if (minimum === undefined) reason = "No configured volume threshold for this position";
  else if (volume < minimum) reason = "Own volume is below the configured matchup threshold";
  else if (n < config.minSample || adjustedRatio === null) reason = "Insufficient schedule-adjusted defense sample";
  else if (input.defensive_absences?.length) reason = "Current defensive absences invalidate an unconditional historical DvP; conditional adjustment unavailable";
  else if (!config.calibrated) reason = "Defense efficiency feature is estimated; mean contribution disabled until parameters are calibrated";
  const fraction = adjustedRatio === null ? null : Math.max(-config.maxFraction, Math.min(config.maxFraction, adjustedRatio - 1));
  const matchupPoints = reason === null ? ownPoints! * fraction! : null;
  return {
    defense_team_id: input.defense_team_id, position: input.position, phase: input.phase, alignment: input.alignment,
    raw_ratio: rawRatio, adjusted_ratio: adjustedRatio, sample_games: n, sample_opportunities: opportunities,
    recent_ratio: recentRatio, trend: adjustedRatio !== null && recentRatio !== null ? recentRatio - adjustedRatio : null,
    own_volume_points: ownPoints, matchup_contribution: matchupPoints,
    adjusted_points: matchupPoints === null ? null : ownPoints! + matchupPoints,
    expected_opportunities: volume, evidence: [...observations.map((row) => row.evidence), ...(input.own_volume_evidence ? [input.own_volume_evidence] : [])],
    estimated: true, calibrated: config.calibrated,
    method: "Opponent-quality-adjusted points per opportunity, opportunity-weighted by game, shrunk toward neutral league ratio 1; own volume multiplies efficiency; configured cap and minimum volume",
    config, reason,
  };
}
