import { retry, withTimeout } from "../providers";

export interface EspnTeamContext {
  team: string;
  opponent: string;
  homeAway: "home" | "away";
  kickoff?: string;
  venue?: string;
  weather?: string;
}

type EspnEvent = {
  date?: string;
  competitions?: Array<{
    date?: string;
    venue?: { fullName?: string; indoor?: boolean };
    weather?: { displayValue?: string; temperature?: number; conditionId?: string };
    competitors?: Array<{ homeAway?: string; team?: { abbreviation?: string } }>;
  }>;
};

const TEAM_ALIASES: Record<string, string> = { JAC: "JAX", WSH: "WAS", LA: "LAR" };

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
    for (const competitor of competitors) {
      const team = normalizeTeam(competitor.team?.abbreviation);
      const opponent = normalizeTeam(competitors.find((item) => item !== competitor)?.team?.abbreviation);
      const homeAway = competitor.homeAway === "home" ? "home" : competitor.homeAway === "away" ? "away" : undefined;
      if (!team || !opponent || !homeAway) continue;
      contexts.set(team, { team, opponent, homeAway, kickoff: competition?.date ?? raw.date, venue, weather });
    }
  }
  return contexts;
}

export async function fetchEspnScoreboard(season: number, week: number) {
  const url = `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=${season}&seasontype=2&week=${week}`;
  const response = await retry(() => withTimeout(fetch(url, { headers: { Accept: "application/json" }, next: { revalidate: 300 } }), 6000));
  if (!response.ok) throw new Error(`ESPN schedule ${response.status}`);
  const body = await response.json();
  return Array.isArray(body.events) ? body.events : [];
}
