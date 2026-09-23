import { retry, withTimeout } from "../providers";
import type { RecentGameUsage } from "../types";

export interface SportsDataProjection {
  providerId: string;
  name: string;
  team: string;
  position: string;
  points: number;
  kickoff?: string;
  injury?: string;
  futureProjection?: number;
}

type SportsDataRow = {
  PlayerID?: number;
  Name?: string;
  Team?: string;
  Position?: string;
  FantasyPointsPPR?: number;
  FantasyPointsYahoo?: number;
  FantasyPoints?: number;
  GameDate?: string;
  InjuryStatus?: string;
};

type SportsDataGameRow = SportsDataRow & Record<string, unknown> & {
  Season?: number;
  Week?: number;
  OffensiveSnapsPlayed?: number;
  OffensiveTeamSnaps?: number;
  ReceivingTargets?: number;
  Receptions?: number;
  RushingAttempts?: number;
};

export interface SportsDataRecentUsage {
  providerId: string;
  name: string;
  team: string;
  position: string;
  games: RecentGameUsage[];
}

export interface SportsDataInjury {
  name: string;
  team: string;
  position?: string;
  status?: string;
  bodyPart?: string;
}

type SportsDataDefenseRow = {
  FantasyDefenseID?: number;
  Team?: string;
  FantasyPoints?: number;
  DateTime?: string;
};

export async function fetchSportsDataIoProjections(season: number, week: number): Promise<SportsDataProjection[]> {
  const key = process.env.SPORTSDATAIO_API_KEY;
  if (!key) throw new Error("SPORTSDATAIO_API_KEY no configurada");
  const url = `https://api.sportsdata.io/v3/nfl/projections/json/PlayerGameProjectionStatsByWeek/${season}REG/${week}`;
  const response = await retry(() => withTimeout(fetch(url, {
    headers: { "Ocp-Apim-Subscription-Key": key, Accept: "application/json" },
    cache: "no-store",
  }), 8_000));
  if (!response.ok) throw new Error(`SportsDataIO ${response.status}`);
  const rows = await response.json() as SportsDataRow[];
  const players = rows.flatMap((row) => {
    const points = row.FantasyPointsPPR ?? row.FantasyPointsYahoo ?? row.FantasyPoints;
    if (!row.Name || !row.Team || !row.Position || points == null) return [];
    return [{
      providerId: String(row.PlayerID ?? row.Name), name: row.Name, team: row.Team,
      position: row.Position, points, kickoff: row.GameDate ? new Date(row.GameDate).toISOString() : undefined,
      injury: row.InjuryStatus || undefined,
    }];
  });
  try {
    const defenseUrl = `https://api.sportsdata.io/v3/nfl/projections/json/FantasyDefenseProjectionsByGame/${season}REG/${week}`;
    const defenseResponse = await retry(() => withTimeout(fetch(defenseUrl, {
      headers: { "Ocp-Apim-Subscription-Key": key, Accept: "application/json" },
      cache: "no-store",
    }), 8_000));
    if (!defenseResponse.ok) return players;
    const defenses = await defenseResponse.json() as SportsDataDefenseRow[];
    return [...players, ...defenses.flatMap((row) => {
      if (!row.Team || row.FantasyPoints == null) return [];
      return [{
        providerId: String(row.FantasyDefenseID ?? row.Team), name: `${row.Team} D/ST`, team: row.Team,
        position: "DST", points: row.FantasyPoints,
        kickoff: row.DateTime ? new Date(row.DateTime).toISOString() : undefined,
      }];
    })];
  } catch {
    return players;
  }
}

const numberFrom = (row: SportsDataGameRow, ...keys: string[]) => {
  for (const key of keys) {
    const value = row[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
  }
  return undefined;
};

export function mapSportsDataRecentUsage(rows: SportsDataGameRow[]): SportsDataRecentUsage[] {
  const teamTargetsByWeek = new Map<string, number>();
  for (const row of rows) {
    if (!row.Team || row.Week == null) continue;
    const key = `${row.Team.toUpperCase()}|${row.Week}`;
    teamTargetsByWeek.set(key, (teamTargetsByWeek.get(key) ?? 0) + (row.ReceivingTargets ?? 0));
  }
  const players = new Map<string, SportsDataRecentUsage>();
  for (const row of rows) {
    if (!row.Name || !row.Team || !row.Position || row.Week == null) continue;
    const key = `${row.Name.toLowerCase()}|${row.Team.toUpperCase()}`;
    const teamTargets = teamTargetsByWeek.get(`${row.Team.toUpperCase()}|${row.Week}`);
    const carries = row.RushingAttempts;
    const receptions = row.Receptions;
    const redZoneTouches = sumDefined(
      numberFrom(row, "RushingAttemptsInsideTwenty", "RushingAttemptsInside20"),
      numberFrom(row, "ReceivingTargetsInsideTwenty", "ReceivingTargetsInside20"),
    );
    const insideFiveTouches = sumDefined(
      numberFrom(row, "RushingAttemptsInsideFive", "RushingAttemptsInside5"),
      numberFrom(row, "ReceivingTargetsInsideFive", "ReceivingTargetsInside5"),
    );
    const game: RecentGameUsage = {
      week: row.Week,
      fantasyPointsPpr: row.FantasyPointsPPR,
      snapShare: ratio(row.OffensiveSnapsPlayed, row.OffensiveTeamSnaps),
      targets: row.ReceivingTargets,
      targetShare: ratio(row.ReceivingTargets, teamTargets),
      routes: numberFrom(row, "RoutesRun", "ReceivingRoutesRun"),
      routeParticipation: ratio(numberFrom(row, "RoutesRun", "ReceivingRoutesRun"), numberFrom(row, "TeamPassPlays", "TeamPassingAttempts", "OffensivePassPlays")),
      carries,
      receptions,
      touches: carries != null || receptions != null ? (carries ?? 0) + (receptions ?? 0) : undefined,
      redZoneTouches,
      insideFiveTouches,
      touchdowns: sumDefined(numberFrom(row, "PassingTouchdowns"), numberFrom(row, "RushingTouchdowns"), numberFrom(row, "ReceivingTouchdowns")),
      yprr: numberFrom(row, "ReceivingYardsPerRouteRun", "YardsPerRouteRun"),
      ycoPerAttempt: numberFrom(row, "RushingYardsAfterContactPerAttempt", "YardsAfterContactPerAttempt"),
    };
    const existing = players.get(key) ?? { providerId: String(row.PlayerID ?? row.Name), name: row.Name, team: row.Team, position: row.Position, games: [] };
    existing.games.push(game);
    players.set(key, existing);
  }
  return [...players.values()].map((player) => ({ ...player, games: player.games.sort((a, b) => b.week - a.week).slice(0, 3) }));
}

export async function fetchSportsDataIoRecentUsage(season: number, week: number): Promise<SportsDataRecentUsage[]> {
  const key = process.env.SPORTSDATAIO_API_KEY;
  if (!key) throw new Error("SPORTSDATAIO_API_KEY no configurada");
  const completedWeeks = Array.from({ length: Math.min(3, Math.max(0, week - 1)) }, (_, index) => week - 1 - index);
  if (!completedWeeks.length) return [];
  const responses = await Promise.all(completedWeeks.map(async (completedWeek) => {
    const url = `https://api.sportsdata.io/v3/nfl/stats/json/PlayerGameStatsByWeek/${season}REG/${completedWeek}`;
    const response = await retry(() => withTimeout(fetch(url, {
      headers: { "Ocp-Apim-Subscription-Key": key, Accept: "application/json" },
      cache: "no-store",
    }), 8_000));
    if ([401, 403, 404].includes(response.status)) return [];
    if (!response.ok) throw new Error(`SportsDataIO recent usage ${response.status}`);
    return response.json() as Promise<SportsDataGameRow[]>;
  }));
  return mapSportsDataRecentUsage(responses.flat());
}

function ratio(numerator?: number, denominator?: number) {
  return numerator != null && denominator != null && denominator > 0 ? numerator / denominator : undefined;
}

function sumDefined(...values: Array<number | undefined>) {
  return values.some((value) => value != null) ? values.reduce<number>((sum, value) => sum + (value ?? 0), 0) : undefined;
}

export async function fetchSportsDataIoInjuries(season: number, week: number): Promise<SportsDataInjury[]> {
  const key = process.env.SPORTSDATAIO_API_KEY;
  if (!key) throw new Error("SPORTSDATAIO_API_KEY no configurada");
  const url = `https://api.sportsdata.io/v3/nfl/stats/json/Injuries/${season}REG/${week}`;
  const response = await retry(() => withTimeout(fetch(url, {
    headers: { "Ocp-Apim-Subscription-Key": key, Accept: "application/json" }, cache: "no-store",
  }), 8_000));
  if ([401, 403, 404].includes(response.status)) return [];
  if (!response.ok) throw new Error(`SportsDataIO injuries ${response.status}`);
  const rows = await response.json() as Array<Record<string, unknown>>;
  return rows.flatMap((row) => {
    const name = typeof row.Name === "string" ? row.Name : typeof row.PlayerName === "string" ? row.PlayerName : undefined;
    const team = typeof row.Team === "string" ? row.Team : undefined;
    if (!name || !team) return [];
    return [{ name, team, position: typeof row.Position === "string" ? row.Position : undefined, status: typeof row.Status === "string" ? row.Status : undefined, bodyPart: typeof row.BodyPart === "string" ? row.BodyPart : undefined }];
  });
}
