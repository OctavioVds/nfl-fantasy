const NFL_TIME_ZONE = "America/Monterrey";
const DAY_MS = 86_400_000;
const WEEK_MS = 7 * DAY_MS;

function localCalendar(now: Date) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: NFL_TIME_ZONE,
    weekday: "short",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "0";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    hour: Number(get("hour")),
    weekday: get("weekday"),
  };
}

function firstMondayOfSeptember(year: number) {
  const firstDay = new Date(Date.UTC(year, 8, 1));
  const daysUntilMonday = (8 - firstDay.getUTCDay()) % 7;
  return new Date(Date.UTC(year, 8, 1 + daysUntilMonday));
}

export function nflPeriod(now = new Date()) {
  const local = localCalendar(now);
  const season = local.month >= 8 ? local.year : local.year - 1;

  // NFL Week 1 starts on the Tuesday after Labor Day. ESPN's matchup week
  // advances after Monday Night Football, so keep Tuesday's early hours in
  // the prior week until 06:00 Monterrey time.
  const laborDay = firstMondayOfSeptember(season);
  const weekOneStart = Date.UTC(season, 8, laborDay.getUTCDate() + 1);
  let localDay = Date.UTC(local.year, local.month - 1, local.day);
  if (local.weekday === "Tue" && local.hour < 6) localDay -= DAY_MS;
  const week = Math.floor((localDay - weekOneStart) / WEEK_MS) + 1;
  return { season, week: Math.max(1, Math.min(18, week)) };
}

export function isPlayerLocked(kickoff: string | undefined, now = new Date()) {
  if (!kickoff) return false;
  const parsed = new Date(kickoff);
  return Number.isFinite(parsed.getTime()) && parsed.getTime() <= now.getTime();
}

export function isStale(fetchedAt: string | undefined, ttlMs: number, now = new Date()) {
  if (!fetchedAt) return true;
  const parsed = new Date(fetchedAt).getTime();
  const age = now.getTime() - parsed;
  return !Number.isFinite(parsed) || age < -5 * 60_000 || age > ttlMs;
}

export function formatMonterrey(iso: string) {
  return new Intl.DateTimeFormat("es-MX", {
    timeZone: NFL_TIME_ZONE,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(iso));
}
