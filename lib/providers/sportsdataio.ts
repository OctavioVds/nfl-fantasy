import { retry, withTimeout } from "../providers";

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
  let seasonByPlayer = new Map<string, number>();
  try {
    const seasonUrl = `https://api.sportsdata.io/v3/nfl/projections/json/PlayerSeasonProjectionStats/${season}`;
    const seasonResponse = await retry(() => withTimeout(fetch(seasonUrl, { headers: { "Ocp-Apim-Subscription-Key": key, Accept: "application/json" }, cache: "no-store" }), 8_000));
    if (seasonResponse.ok) {
      const seasonRows = await seasonResponse.json() as SportsDataRow[];
      seasonByPlayer = new Map(seasonRows.flatMap((row) => {
        const total = row.FantasyPointsPPR ?? row.FantasyPointsYahoo ?? row.FantasyPoints;
        return row.Name && row.Team && total != null ? [[`${row.Name.toLowerCase()}|${row.Team.toUpperCase()}`, total / 17] as const] : [];
      }));
    }
  } catch { /* weekly projections remain usable */ }
  const players = rows.flatMap((row) => {
    const points = row.FantasyPointsPPR ?? row.FantasyPointsYahoo ?? row.FantasyPoints;
    if (!row.Name || !row.Team || !row.Position || points == null) return [];
    return [{
      providerId: String(row.PlayerID ?? row.Name), name: row.Name, team: row.Team,
      position: row.Position, points, kickoff: row.GameDate ? new Date(row.GameDate).toISOString() : undefined,
      injury: row.InjuryStatus || undefined,
      futureProjection: seasonByPlayer.get(`${row.Name.toLowerCase()}|${row.Team.toUpperCase()}`),
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
