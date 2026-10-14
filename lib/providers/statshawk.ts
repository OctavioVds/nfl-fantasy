import { MissingProviderCredentialsError, retry, withTimeout } from "../providers";
import { serverEnv } from "../env";
import { z } from "zod";

export interface StatsHawkContext {
  competition: string;
  contests: number;
  fetchedAt: string;
}

export async function fetchStatsHawkContext(season: number): Promise<StatsHawkContext | null> {
  const key = serverEnv().STATSHAWK_API_KEY;
  if (!key) throw new MissingProviderCredentialsError("StatsHawk", "STATSHAWK_API_KEY");
  const url = `https://api.statshawk.ai/v1/competitions/nfl/editions/${season}/contests`;
  const response = await retry(() => withTimeout(fetch(url, {
    headers: { "X-API-Key": key, Accept: "application/json" }, cache: "no-store",
  }), 8_000));
  if (!response.ok) throw new Error(`StatsHawk ${response.status}`);
  const body = z.object({data:z.object({items:z.array(z.unknown())}),meta:z.object({fetched_at:z.string().datetime(),version:z.literal("v1")})}).parse(await response.json());
  return { competition: "NFL", contests: body.data.items.length, fetchedAt: body.meta.fetched_at };
}
