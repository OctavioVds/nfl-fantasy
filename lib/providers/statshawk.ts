import { retry, withTimeout } from "../providers";

export interface StatsHawkContext {
  competition: string;
  contests: number;
  fetchedAt: string;
}

export async function fetchStatsHawkContext(season: number): Promise<StatsHawkContext | null> {
  const key = process.env.STATSHAWK_API_KEY;
  if (!key) return null;
  const url = `https://api.statshawk.ai/v1/competitions/nfl/editions/${season}/contests`;
  const response = await retry(() => withTimeout(fetch(url, {
    headers: { "X-API-Key": key, Accept: "application/json" }, cache: "no-store",
  }), 8_000));
  if (!response.ok) throw new Error(`StatsHawk ${response.status}`);
  const body = await response.json() as { items?: unknown[]; meta?: { fetched_at?: string } };
  return { competition: "NFL", contests: body.items?.length ?? 0, fetchedAt: body.meta?.fetched_at ?? new Date().toISOString() };
}
