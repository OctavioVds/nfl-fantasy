const SEASON_STARTS: Record<number, string> = { 2026: "2026-09-10T00:00:00-04:00" };

export function nflPeriod(now = new Date()) {
  const year = now.getUTCFullYear();
  const season = now.getUTCMonth() < 7 ? year - 1 : year;
  const start = new Date(SEASON_STARTS[season] ?? `${season}-09-10T00:00:00-04:00`);
  const diff = Math.floor((now.getTime() - start.getTime()) / 604_800_000);
  return { season, week: Math.max(1, Math.min(18, diff + 1)) };
}

export function isPlayerLocked(kickoff: string | undefined, now = new Date()) {
  if (!kickoff) return false;
  const parsed = new Date(kickoff);
  return Number.isFinite(parsed.getTime()) && parsed.getTime() <= now.getTime();
}

export function isStale(fetchedAt: string, ttlMs: number, now = new Date()) {
  const parsed = new Date(fetchedAt).getTime();
  return !Number.isFinite(parsed) || now.getTime() - parsed > ttlMs;
}

export function formatMonterrey(iso: string) {
  return new Intl.DateTimeFormat("es-MX", {
    timeZone: "America/Monterrey",
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(iso));
}
