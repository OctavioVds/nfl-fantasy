import type { ExternalSyncPayload } from "./schemas";

export interface ProviderResult<T> { data: T; fetchedAt: string; sourceTimestamp: string; source: string }
export interface LeagueProvider { name: string; getLeague(): Promise<ProviderResult<ExternalSyncPayload>> }
export interface NewsProvider { name: string; getNews(season: number, week: number): Promise<ProviderResult<unknown[]>> }
export interface SportsDataProvider { name: string; getSchedule(season: number, week: number): Promise<ProviderResult<unknown[]>> }
export interface ProjectionProvider { name: string; getProjections(season: number, week: number): Promise<ProviderResult<unknown[]>> }

export async function withTimeout<T>(promise: Promise<T>, ms = 6000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Provider timeout after ${ms}ms`)), ms); });
  try { return await Promise.race([promise, timeout]); } finally { clearTimeout(timer!); }
}

export async function retry<T>(fn: () => Promise<T>, attempts = 2) {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try { return await fn(); } catch (error) { last = error; if (i + 1 < attempts) await new Promise((resolve) => setTimeout(resolve, 150 * 2 ** i)); }
  }
  throw last;
}
