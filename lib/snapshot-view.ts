import { nflPeriod, isStale } from "./time";
import type { SyncSnapshot } from "./types";

const LEAGUE_DATA_TTL_MS = 24 * 60 * 60 * 1000;

export function snapshotForDisplay(snapshot: SyncSnapshot, now = new Date()): SyncSnapshot {
  const period = nflPeriod(now);
  const sourceTimestamp = snapshot.dataUpdatedAt ?? snapshot.dataAsOf;
  const outOfPeriod = snapshot.season !== period.season || snapshot.week !== period.week;
  const stale = snapshot.freshness === "STALE" || isStale(sourceTimestamp, LEAGUE_DATA_TTL_MS, now) || outOfPeriod;
  if (!stale) return snapshot;

  const reasons = [
    ...snapshot.warnings,
    ...(outOfPeriod ? [`El snapshot es de ${snapshot.season} semana ${snapshot.week}; el periodo actual es ${period.season} semana ${period.week}.`] : []),
    ...(!sourceTimestamp ? ["No existe timestamp de una fuente de liga actual."] : isStale(sourceTimestamp, LEAGUE_DATA_TTL_MS, now) ? ["La última consulta de liga supera 24 horas o tiene un timestamp inválido."] : []),
    "Se conservaron los datos reales del último snapshot como históricos; las recomendaciones y acciones actuales están bloqueadas.",
  ];

  return {
    ...snapshot,
    season: period.season,
    week: period.week,
    leagueName: snapshot.leagueName || "Liga no conectada",
    freshness: "STALE",
    health: "DEGRADED",
    projectedScore: null,
    opponentScore: null,
    winProbability: null,
    scoreMode: undefined,
    teamRecord: undefined,
    opponentName: undefined,
    roster: snapshot.roster,
    recommendations: [],
    pendingMoves: undefined,
    rosterChanges: undefined,
    warnings: [...new Set(reasons)],
  };
}
