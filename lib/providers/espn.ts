import { retry, withTimeout } from "../providers";

export interface EspnTeamContext {
  team: string;
  opponent: string;
  homeAway: "home" | "away";
  kickoff?: string;
  venue?: string;
  weather?: string;
  windMph?: number;
  overUnder?: number;
  spread?: number;
  divisional?: boolean;
  shortWeek?: boolean;
  crossCountryTravel?: boolean;
}

type EspnEvent = {
  date?: string;
  competitions?: Array<{
    date?: string;
    venue?: { fullName?: string; indoor?: boolean };
    weather?: { displayValue?: string; temperature?: number; conditionId?: string; windSpeed?: number; windDirection?: string };
    odds?: Array<{ overUnder?: number; details?: string; homeTeamOdds?: { favorite?: boolean }; awayTeamOdds?: { favorite?: boolean } }>;
    competitors?: Array<{ homeAway?: string; team?: { abbreviation?: string } }>;
  }>;
};

export interface EspnNewsArticle {
  headline: string;
  description?: string;
  published?: string;
  athleteNames: string[];
}

const TEAM_ALIASES: Record<string, string> = { JAC: "JAX", WSH: "WAS", LA: "LAR" };
const DIVISIONS = [
  ["BUF", "MIA", "NE", "NYJ"], ["BAL", "CIN", "CLE", "PIT"], ["HOU", "IND", "JAX", "TEN"], ["DEN", "KC", "LV", "LAC"],
  ["DAL", "NYG", "PHI", "WAS"], ["CHI", "DET", "GB", "MIN"], ["ATL", "CAR", "NO", "TB"], ["ARI", "LAR", "SF", "SEA"],
];
const TIME_ZONE_BAND: Record<string, number> = {
  SEA: 0, SF: 0, LAR: 0, LAC: 0, LV: 0, ARI: 0,
  DEN: 1, KC: 1, DAL: 1, HOU: 1, CHI: 1, MIN: 1, GB: 1, NO: 1, TEN: 1,
  BUF: 2, MIA: 2, NE: 2, NYJ: 2, BAL: 2, CIN: 2, CLE: 2, PIT: 2, IND: 2, JAX: 2,
  PHI: 2, NYG: 2, WAS: 2, DET: 2, ATL: 2, CAR: 2, TB: 2,
};

function normalizeTeam(team: string | undefined) {
  const value = (team ?? "").toUpperCase();
  return TEAM_ALIASES[value] ?? value;
}

export function mapEspnTeamContexts(events: unknown[]): Map<string, EspnTeamContext> {
  const contexts = new Map<string, EspnTeamContext>();
  for (const raw of events as EspnEvent[]) {
    const competition = raw.competitions?.[0];
    const competitors = competition?.competitors ?? [];
    if (competitors.length < 2) continue;
    const venue = competition?.venue?.fullName;
    const weather = competition?.venue?.indoor
      ? "Estadio cerrado"
      : competition?.weather?.displayValue ?? (competition?.weather?.temperature != null ? `${competition.weather.temperature}°F` : undefined);
    const windMph = competition?.venue?.indoor ? 0 : competition?.weather?.windSpeed ?? parseWind(weather);
    const odds = competition?.odds?.[0];
    const kickoff = competition?.date ?? raw.date;
    const shortWeek = kickoff ? [4, 5].includes(new Date(kickoff).getUTCDay()) : false;
    for (const competitor of competitors) {
      const team = normalizeTeam(competitor.team?.abbreviation);
      const opponent = normalizeTeam(competitors.find((item) => item !== competitor)?.team?.abbreviation);
      const homeAway = competitor.homeAway === "home" ? "home" : competitor.homeAway === "away" ? "away" : undefined;
      if (!team || !opponent || !homeAway) continue;
      contexts.set(team, {
        team, opponent, homeAway, kickoff, venue, weather, windMph, overUnder: odds?.overUnder,
        spread: teamSpread(team, homeAway, odds),
        divisional: DIVISIONS.some((division) => division.includes(team) && division.includes(opponent)),
        shortWeek,
        crossCountryTravel: homeAway === "away" && TIME_ZONE_BAND[team] != null && TIME_ZONE_BAND[opponent] != null && Math.abs(TIME_ZONE_BAND[team] - TIME_ZONE_BAND[opponent]) >= 2,
      });
    }
  }
  return contexts;
}

function parseWind(weather?: string) {
  const match = weather?.match(/(?:wind|winds?)\D{0,12}(\d+(?:\.\d+)?)\s*(?:mph)?/i);
  return match ? Number(match[1]) : undefined;
}

function teamSpread(team: string, homeAway: "home" | "away", odds?: { details?: string; homeTeamOdds?: { favorite?: boolean }; awayTeamOdds?: { favorite?: boolean } }) {
  const match = odds?.details?.match(/^([A-Z]{2,3})\s+(-?\d+(?:\.\d+)?)$/i);
  if (match) {
    const favorite = normalizeTeam(match[1]);
    const magnitude = Math.abs(Number(match[2]));
    return team === favorite ? -magnitude : magnitude;
  }
  const favorite = homeAway === "home" ? odds?.homeTeamOdds?.favorite : odds?.awayTeamOdds?.favorite;
  return favorite === true ? -0.1 : favorite === false ? 0.1 : undefined;
}

export async function fetchEspnScoreboard(season: number, week: number) {
  const url = `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=${season}&seasontype=2&week=${week}`;
  const response = await retry(() => withTimeout(fetch(url, { headers: { Accept: "application/json" }, next: { revalidate: 300 } }), 6000));
  if (!response.ok) throw new Error(`ESPN schedule ${response.status}`);
  const body = await response.json();
  return Array.isArray(body.events) ? body.events : [];
}

export async function fetchEspnNews(limit = 100): Promise<EspnNewsArticle[]> {
  const url = `https://site.api.espn.com/apis/site/v2/sports/football/nfl/news?limit=${limit}`;
  const response = await retry(() => withTimeout(fetch(url, { headers: { Accept: "application/json" }, cache: "no-store" }), 8_000));
  if (!response.ok) throw new Error(`ESPN news ${response.status}`);
  const body = await response.json() as { articles?: Array<{ headline?: string; description?: string; published?: string; categories?: Array<{ type?: string; description?: string }> }> };
  return (body.articles ?? []).flatMap((article) => article.headline ? [{
    headline: article.headline,
    description: article.description,
    published: article.published,
    athleteNames: (article.categories ?? []).filter((category) => category.type === "athlete" && category.description).map((category) => category.description!),
  }] : []);
}
