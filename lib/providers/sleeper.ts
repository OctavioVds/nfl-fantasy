import { retry, withTimeout } from "../providers";

export async function fetchSleeperTrending() {
  const response = await retry(() => withTimeout(fetch("https://api.sleeper.app/v1/players/nfl/trending/add?lookback_hours=24&limit=25", { next: { revalidate: 900 } }), 6000));
  if (!response.ok) throw new Error(`Sleeper trending ${response.status}`);
  const body = await response.json();
  return Array.isArray(body) ? body : [];
}
