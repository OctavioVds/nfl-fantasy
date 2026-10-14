import type { CorePlayer, Projection } from "../schema";

export type HorizonPosition = CorePlayer["position"];
export interface HorizonInput {
  playerId: string;
  season: number;
  fromWeek: number;
  throughWeek: number;
  playoffWeeks: number[] | null;
  projections: Projection[];
  /** Caller must prefilter verified league availability AND this position. */
  replacementProjections: Projection[];
  /** Actual starter demand validates position legality; it does not rank free agents. */
  starterCounts: Partial<Record<HorizonPosition, number>> | null;
  position: HorizonPosition;
  scoringHash: string;
}
export interface HorizonValue {
  ros_mean: number | null;
  ros_sd: null;
  playoff_mean: number | null;
  war: number | null;
  reason: string[];
  estimated: true;
  method: string;
}

const positions = new Set<string>(["QB", "RB", "WR", "TE", "DST", "K"]);
const average = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
const validWeek = (week: number) => Number.isInteger(week) && week >= 1 && week <= 18;
const stamp = (value: string) => typeof value === "string" && value.includes("T") ? Date.parse(value) : NaN;

function validForecast(row: Projection) {
  if (!row.eligible || [row.mean, row.sd, row.p10, row.p50, row.p90, row.prob_play].some((value) => value === null || !Number.isFinite(value))) return false;
  if (row.sd! < 0 || row.p10! > row.p50! || row.p50! > row.p90! || row.prob_play! < 0 || row.prob_play! > 1 || !Number.isFinite(row.confidence) || row.confidence < 0 || row.confidence > 100) return false;
  const asOf = stamp(row.as_of), fetched = stamp(row.fetched_at);
  if (!Number.isFinite(asOf) || !Number.isFinite(fetched) || fetched < asOf) return false;
  if (row.residual_support !== undefined && (!row.residual_support.length || row.residual_support.some((point) => !Number.isFinite(point.value) || !Number.isFinite(point.probability) || point.probability < 0 || point.probability > 1) || Math.abs(row.residual_support.reduce((sum, point) => sum + point.probability, 0) - 1) > 1e-8)) return false;
  if (typeof row.model_version === "string" && row.model_version.length > 0) return true;
  // An official future bye determines zero opportunity without a trained model.
  // A current injury must not be extrapolated to zero over the rest of the season.
  return row.reason === "Bye confirmed" && row.method === "Verified schedule or availability determines zero opportunity"
    && [row.mean, row.sd, row.p10, row.p50, row.p90, row.prob_play].every((value) => value === 0);
}

function forecastIdentity(row: Projection) {
  return JSON.stringify([row.mean, row.sd, row.p10, row.p50, row.p90, row.prob_play, row.confidence, row.eligible, row.model_version, row.method, row.reason, row.residual_support ?? null]);
}

function latestBase(rows: Projection[], scoringHash: string): { row: Projection | null; reason: string | null } {
  const candidates = rows.filter((row) => row.scenario === "base" && row.scoring_hash === scoringHash);
  if (!candidates.length) return { row: null, reason: "No unconditional forecast with this league scoring" };
  if (candidates.some((row) => !Number.isFinite(stamp(row.as_of)))) return { row: null, reason: "Forecast timestamp invalid; latest version cannot be established" };
  const newest = Math.max(...candidates.map((row) => stamp(row.as_of)));
  const latest = candidates.filter((row) => stamp(row.as_of) === newest);
  if (new Set(latest.map(forecastIdentity)).size > 1) return { row: null, reason: "Contradictory forecasts share the latest as_of" };
  if (latest.some((row) => !validForecast(row))) return { row: null, reason: "Latest forecast is unaccepted, incomplete or lacks a calibrated model" };
  return { row: [...latest].sort((a, b) => stamp(b.fetched_at) - stamp(a.fetched_at))[0], reason: null };
}

/**
 * Weekly units preserve the legacy futureProjection contract. No current-week
 * extrapolation, fabricated playoff calendar, availability inference or assumed
 * independence across games. Each eligible input has already passed Core checks.
 */
export function horizonValue(input: HorizonInput): HorizonValue {
  const result: HorizonValue = {
    ros_mean: null, ros_sd: null, playoff_mean: null, war: null, estimated: true,
    reason: ["ROS standard deviation unavailable: weekly covariance/correlation data was not supplied"],
    method: "Mean of complete verified future weekly base forecasts; playoff weeks from league rules; expected weekly points above best verified available same-position replacement; no independence assumption",
  };
  if (!input.playerId || !input.scoringHash || !positions.has(input.position) || !Number.isInteger(input.season) || input.season < 2020 || input.season > 2100 || !validWeek(input.fromWeek) || !validWeek(input.throughWeek) || input.fromWeek > input.throughWeek) {
    result.reason.push("Invalid player, season, scoring or remaining-week boundaries");
    return result;
  }
  const weeks = Array.from({ length: input.throughWeek - input.fromWeek + 1 }, (_, index) => input.fromWeek + index);
  const target = new Map<number, Projection>();
  for (const week of weeks) {
    const chosen = latestBase(input.projections.filter((row) => row.player_id === input.playerId && row.season === input.season && row.week === week), input.scoringHash);
    if (chosen.row) target.set(week, chosen.row);
    else result.reason.push(`ROS week ${week}: ${chosen.reason}`);
  }
  if (target.size === weeks.length) result.ros_mean = average(weeks.map((week) => target.get(week)!.mean!));

  if (input.playoffWeeks === null) result.reason.push("Playoff schedule unavailable from league rules");
  else if (input.playoffWeeks.some((week) => !validWeek(week) || week > input.throughWeek)) result.reason.push("Playoff schedule has invalid weeks or extends beyond the supplied horizon");
  else {
    const playoffWeeks = [...new Set(input.playoffWeeks)].filter((week) => week >= input.fromWeek);
    if (!playoffWeeks.length) result.reason.push("No remaining playoff weeks supplied");
    else if (playoffWeeks.some((week) => !target.has(week))) result.reason.push("Playoff projections incomplete; no weekly extrapolation applied");
    else result.playoff_mean = average(playoffWeeks.map((week) => target.get(week)!.mean!));
  }

  const demand = input.starterCounts?.[input.position];
  if (demand === undefined || !Number.isInteger(demand) || demand <= 0) {
    result.reason.push("WAR unavailable: actual total league starter demand for this position is missing or invalid");
    return result;
  }
  if (target.size !== weeks.length) {
    result.reason.push("WAR unavailable: the player's remaining weekly forecasts are incomplete");
    return result;
  }
  const weeklyWar: number[] = [];
  for (const week of weeks) {
    const available = input.replacementProjections.filter((row) => row.season === input.season && row.week === week && row.player_id !== input.playerId);
    const byPlayer = new Map<string, Projection[]>();
    for (const row of available) byPlayer.set(row.player_id, [...(byPlayer.get(row.player_id) ?? []), row]);
    const replacement: Projection[] = [];
    let incomplete = false;
    for (const rows of byPlayer.values()) {
      const chosen = latestBase(rows, input.scoringHash);
      if (chosen.row) replacement.push(chosen.row);
      else incomplete = true;
    }
    if (incomplete) {
      result.reason.push(`WAR week ${week}: an available player's base forecast is incomplete or conflicting; the best replacement is unknown`);
      continue;
    }
    if (!replacement.length) {
      result.reason.push(`WAR week ${week}: no verified available same-position replacement forecast`);
      continue;
    }
    replacement.sort((a, b) => b.mean! - a.mean! || (a.player_id < b.player_id ? -1 : a.player_id > b.player_id ? 1 : 0));
    weeklyWar.push(target.get(week)!.mean! - replacement[0].mean!);
  }
  if (weeklyWar.length === weeks.length) result.war = average(weeklyWar);
  return result;
}
