import { retry, withTimeout } from "../providers";

export async function fetchEspnScoreboard(season: number, week: number) {
  const url = `https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=${season}&seasontype=2&week=${week}`;
  const response = await retry(() => withTimeout(fetch(url, { headers: { Accept: "application/json" }, next: { revalidate: 300 } }), 6000));
  if (!response.ok) throw new Error(`ESPN schedule ${response.status}`);
  const body = await response.json();
  return Array.isArray(body.events) ? body.events : [];
}
