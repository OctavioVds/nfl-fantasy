import { nflPeriod } from "./time";
import type { SyncSnapshot } from "./types";

export function fallbackSnapshot(): SyncSnapshot {
  const { season, week } = nflPeriod();
  return {
    id: "fallback",
    season,
    week,
    leagueName: "Liga no conectada",
    generatedAt: new Date().toISOString(),
    freshness: "STALE",
    health: "DEGRADED",
    projectedScore: null,
    opponentScore: null,
    winProbability: null,
    roster: [],
    recommendations: [],
    agents: [{ name: "LeagueIntelligence", status: "degraded", latencyMs: 0, cacheHit: true, message: "Esperando ingesta actual de la liga." }],
    sources: [],
    warnings: ["No existe una consulta actual de la liga.", "Envía un snapshot fresco mediante /api/external-sync."],
  };
}
