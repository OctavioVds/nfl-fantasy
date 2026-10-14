import type { CorePlayer, Evidence, Roles, Scenario, TeammateSplit } from "../schema";

export const VACANCY_METRICS = ["targets", "routes", "carries", "red_zone", "snaps", "third_down", "two_minute", "goal_line", "goal_line_one"] as const;
export type VacancyMetric = typeof VACANCY_METRICS[number];
export interface ShrunkSplit {
  a_id: string; b_id: string; metric: string; observed_delta: number | null; shrunk_delta: number | null;
  effective_sample: number; posterior_data_weight: number; evidence: Evidence; estimated: true; method: string; reason?: string;
}
export interface VacancyAllocation {
  scenario_id: string; team_id: string; metric: VacancyMetric; absent_player_ids: string[];
  vacant_share: number | null; unallocated_share: number | null;
  beneficiaries: { player_id: string; baseline_share: number; inherited_share: number; conditional_share: number; evidence: Evidence[] }[];
  estimated: true; method: string; reason?: string;
}

export function validateScenarios(scenarios: readonly Scenario[], players: readonly CorePlayer[], teamId?: string): string[] {
  const errors: string[] = [];
  const byId = new Map(players.map((player) => [player.player_id, player]));
  if (byId.size !== players.length) errors.push("Duplicate player IDs");
  const ids = new Set<string>();
  const totals = new Map<string, number>();
  for (const scenario of scenarios) {
    if (!scenario.id || ids.has(scenario.id)) errors.push(`Duplicate or empty scenario ID ${scenario.id}`);
    ids.add(scenario.id);
    if (teamId !== undefined && scenario.team_id !== teamId) errors.push(`Scenario ${scenario.id} belongs to another team`);
    if (!Number.isFinite(scenario.probability) || scenario.probability < 0 || scenario.probability > 1) errors.push(`Invalid probability for ${scenario.id}`);
    totals.set(scenario.team_id, (totals.get(scenario.team_id) ?? 0) + scenario.probability);
    if (new Set(scenario.absent_player_ids).size !== scenario.absent_player_ids.length) errors.push(`Duplicate absent IDs in ${scenario.id}`);
    for (const id of scenario.absent_player_ids) {
      const player = byId.get(id);
      if (!player || player.team_id !== scenario.team_id) errors.push(`Unknown or cross-team teammate ${id}`);
    }
    for (const player of players) if (player.team_id === scenario.team_id && scenario.probability > 0 && (/^(OUT|IR|PUP|SUSPENDED|SUSP)$/i.test(player.status ?? "") || player.bye === true) && !scenario.absent_player_ids.includes(player.player_id)) errors.push(`Unavailable teammate ${player.player_id} is not absent from ${scenario.id}`);
    if (scenario.qb_id !== null) {
      const qb = byId.get(scenario.qb_id);
      if (!qb || qb.team_id !== scenario.team_id || qb.position !== "QB" || scenario.absent_player_ids.includes(qb.player_id)) errors.push(`Invalid active QB ${scenario.qb_id}`);
    }
  }
  if (scenarios.length === 0) errors.push("Availability scenarios are missing");
  for (const [team, probability] of totals) if (Math.abs(probability - 1) > 1e-8) errors.push(`Scenario probabilities for ${team} do not sum to 1`);
  return errors;
}

/** Precision-weighted shrinkage of a difference of two sample means, using an explicit supplied prior. */
export function shrinkTeammateSplit(split: TeammateSplit): ShrunkSplit {
  const nWith = split.n_with;
  const nWithout = split.n_without;
  const validCounts = Number.isInteger(nWith) && Number.isInteger(nWithout) && nWith >= 0 && nWithout >= 0;
  const effectiveSample = validCounts && nWith > 0 && nWithout > 0 ? 1 / (1 / nWith + 1 / nWithout) : 0;
  const validPrior = Number.isFinite(split.prior_strength) && split.prior_strength > 0 && Number.isFinite(split.prior_delta);
  const validMeans = split.with_value !== null && split.without_value !== null && Number.isFinite(split.with_value) && Number.isFinite(split.without_value);
  const observedDelta = validMeans && effectiveSample > 0 ? split.without_value! - split.with_value! : null;
  const dataWeight = validPrior ? effectiveSample / (effectiveSample + split.prior_strength) : 0;
  return {
    a_id: split.a_id, b_id: split.b_id, metric: split.metric, observed_delta: observedDelta,
    shrunk_delta: validPrior ? observedDelta === null ? split.prior_delta : dataWeight * observedDelta + (1 - dataWeight) * split.prior_delta : null,
    effective_sample: effectiveSample, posterior_data_weight: dataWeight, evidence: split.evidence, estimated: true,
    method: "Difference of with/without means shrunk to supplied prior; effective n is harmonic precision of both samples",
    ...(!validCounts || !validPrior ? { reason: "Invalid sample counts or unavailable calibrated prior" } : observedDelta === null ? { reason: "No usable paired sample; supplied prior only" } : {}),
  };
}

function share(role: Roles, metric: string): number | null {
  const value = role.shares[metric];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}

function alignmentWeight(candidate: Roles, absent: readonly Roles[]): number | null {
  const alignments = ["outside", "slot", "in_line", "backfield"];
  const matched = alignments.filter((alignment) => share(candidate, alignment) !== null && absent.every((role) => share(role, alignment) !== null));
  if (matched.length !== alignments.length) return null;
  const score = matched.reduce((sum, alignment) => sum + share(candidate, alignment)! * absent.reduce((total, role) => total + share(role, alignment)!, 0), 0);
  return score > 0 ? score : 0;
}

/** Returns share-point changes, never fantasy-point deltas or assumed universal inheritance percentages. */
export function redistributeVacancies(roles: readonly Roles[], scenarios: readonly Scenario[], metric: VacancyMetric): VacancyAllocation[] {
  return scenarios.map((scenario) => {
    const team = roles.filter((role) => role.team_id === scenario.team_id);
    const absent = team.filter((role) => scenario.absent_player_ids.includes(role.player_id));
    const missingAbsent = scenario.absent_player_ids.some((id) => !team.some((role) => role.player_id === id));
    const absentValues = absent.map((role) => share(role, metric));
    const validVacancy = !missingAbsent && absentValues.every((value) => value !== null);
    const vacantShare = validVacancy ? absentValues.reduce<number>((sum, value) => sum + value!, 0) : null;
    const candidates = team.filter((role) => !scenario.absent_player_ids.includes(role.player_id) && share(role, metric) !== null);
    const alignmentValues = candidates.map((role) => metric === "targets" ? alignmentWeight(role, absent) : null);
    const useAlignment = alignmentValues.length > 0 && alignmentValues.every((value) => value !== null);
    const weighted = candidates.map((role, index) => {
      const metricShare = share(role, metric)!;
      const routes = share(role, "routes");
      const alignment = useAlignment ? alignmentValues[index] : null;
      const weight = metric === "targets" ? routes === null ? null : routes * (alignment ?? 1) : metricShare;
      return { role, metricShare, weight, alignment };
    });
    const totalWeight = weighted.reduce((sum, item) => sum + (item.weight ?? 0), 0);
    const baselineTotal = team.reduce((sum, role) => sum + (share(role, metric) ?? 0), 0);
    const usable = vacantShare !== null && vacantShare <= 100 && baselineTotal <= 100 + 1e-8 && totalWeight > 0;
    const beneficiaries = usable ? weighted.filter((item) => item.weight !== null && item.weight > 0).map((item) => {
      const inherited = vacantShare! * item.weight! / totalWeight;
      return { player_id: item.role.player_id, baseline_share: item.metricShare, inherited_share: inherited, conditional_share: item.metricShare + inherited, evidence: [item.role.evidence, ...absent.map((role) => role.evidence), scenario.evidence] };
    }) : [];
    const validConditional = beneficiaries.every((beneficiary) => beneficiary.conditional_share <= 100 + 1e-8);
    const result: VacancyAllocation = {
      scenario_id: scenario.id, team_id: scenario.team_id, metric, absent_player_ids: scenario.absent_player_ids,
      vacant_share: vacantShare, unallocated_share: validConditional && usable ? 0 : vacantShare,
      beneficiaries: validConditional ? beneficiaries : [], estimated: true,
      method: metric === "targets" ? "Vacant target share weighted by observed recipient routes and complete alignment overlap when available; no fantasy-point effect without calibration" : `Vacant ${metric} share allocated only to recipients with an observed ${metric} role`,
    };
    if (vacantShare === null) result.reason = "Missing absent-player role or share";
    else if (vacantShare > 100 || baselineTotal > 100 + 1e-8 || !validConditional) result.reason = "Shares conflict; conditional allocation exceeds 100 percent";
    else if (!usable && vacantShare > 0) result.reason = "No evidenced recipient weight; vacancy remains unallocated";
    return result;
  });
}

export function getAvailability(teamId: string, players: readonly CorePlayer[], roles: readonly Roles[], splits: readonly TeammateSplit[], scenarios: readonly Scenario[], context?: { asOf: string; maxAgeHours?: number }) {
  const teamPlayers = players.filter((player) => player.team_id === teamId);
  const teamRoles = roles.filter((role) => role.team_id === teamId);
  const teamScenarios = scenarios.filter((scenario) => scenario.team_id === teamId);
  const issues = validateScenarios(teamScenarios, teamPlayers, teamId);
  const ids = new Set(teamPlayers.map((player) => player.player_id));
  if (new Set(teamRoles.map((role) => role.player_id)).size !== teamRoles.length) issues.push("Duplicate player roles");
  for (const role of teamRoles) if (!ids.has(role.player_id)) issues.push(`Role references unknown teammate ${role.player_id}`);
  for (const split of splits) if ((ids.has(split.a_id) || ids.has(split.b_id)) && (!ids.has(split.a_id) || !ids.has(split.b_id) || split.a_id === split.b_id)) issues.push("WOWY split references a different team or self");
  const splitKeys = splits.filter((split) => ids.has(split.a_id) && ids.has(split.b_id)).map((split) => JSON.stringify([split.a_id, split.b_id, split.metric]));
  if (new Set(splitKeys).size !== splitKeys.length) issues.push("Duplicate WOWY natural key");
  const cutoff = context ? Date.parse(context.asOf) : null;
  if (!context) issues.push("Availability validation requires an explicit prediction timestamp");
  if (context && (cutoff === null || !Number.isFinite(cutoff))) issues.push("Invalid availability asOf");
  if (context && cutoff !== null && Number.isFinite(cutoff)) {
    for (const player of teamPlayers) {
      const evidence = player.evidence;
      if (!evidence || !evidence.source || !Number.isFinite(Date.parse(evidence.as_of)) || !Number.isFinite(Date.parse(evidence.fetched_at)) || Date.parse(evidence.as_of) > cutoff || Date.parse(evidence.fetched_at) > cutoff || Date.parse(evidence.fetched_at) < Date.parse(evidence.as_of) || cutoff - Date.parse(evidence.as_of) > (context.maxAgeHours ?? 72) * 3_600_000) issues.push(`Missing, stale or future player availability evidence: ${player.player_id}`);
    }
    for (const evidence of [...teamRoles.map((role) => role.evidence), ...teamScenarios.map((scenario) => scenario.evidence), ...splits.filter((split) => ids.has(split.a_id) && ids.has(split.b_id)).map((split) => split.evidence)]) {
      const sourceTime = Date.parse(evidence.as_of);
      const fetchedTime = Date.parse(evidence.fetched_at);
      if (!Number.isFinite(sourceTime) || !Number.isFinite(fetchedTime) || sourceTime > cutoff || fetchedTime > cutoff || fetchedTime < sourceTime || cutoff - sourceTime > (context.maxAgeHours ?? 72) * 3_600_000) issues.push("Stale, future or invalid availability provenance");
    }
  }
  const teamSplits = splits.filter((split) => ids.has(split.a_id) && ids.has(split.b_id) && split.a_id !== split.b_id);
  const receivers = teamPlayers.filter((player) => player.position === "WR").map((player) => ({ player, role: teamRoles.find((role) => role.player_id === player.player_id) }))
    .filter((item) => item.role && share(item.role, "targets") !== null).sort((a, b) => share(b.role!, "targets")! - share(a.role!, "targets")!);
  const explicitTop = ["WR1", "WR2"].map((rank) => receivers.find((item) => item.role?.role?.toUpperCase() === rank));
  const usesExplicitRank = explicitTop.every((item) => !!item);
  const ranked = usesExplicitRank ? explicitTop as typeof receivers : receivers;
  const concentration = ranked.length >= 2 ? {
    value: share(ranked[0].role!, "targets")! + share(ranked[1].role!, "targets")!,
    player_ids: ranked.slice(0, 2).map((item) => item.player.player_id), evidence: ranked.slice(0, 2).map((item) => item.role!.evidence),
    estimated: !usesExplicitRank, method: usesExplicitRank ? "Combined observed target share of explicit WR1 and WR2 roles" : "Combined target share of two leading observed WR target shares; role rank inferred from usage",
  } : { value: null, player_ids: [], evidence: [], estimated: false, reason: "Two WR target shares are unavailable" };
  if (concentration.value !== null && concentration.value > 100) issues.push("WR concentration exceeds 100 percent");
  return {
    team_id: teamId, scenarios: teamScenarios, issues,
    redistribution: issues.length ? [] : VACANCY_METRICS.flatMap((metric) => redistributeVacancies(teamRoles, teamScenarios, metric)),
    splits: issues.length ? [] : teamSplits.map(shrinkTeammateSplit), concentration,
    qb_context: teamScenarios.map((scenario) => ({ scenario_id: scenario.id, qb_id: scenario.qb_id, reason: "QB-specific aDOT/completion/short-target effects require historical calibrated parameters; no automatic mean boost" })),
  };
}
