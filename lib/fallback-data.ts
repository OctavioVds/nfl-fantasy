import { canonicalPlayerId, topLineupRecommendations } from "./engine";
import { nflPeriod } from "./time";
import type { RosterPlayer, SyncSnapshot } from "./types";

const historicalRoster: Omit<RosterPlayer, "canonicalPlayerId">[] = [
  { name: "Patrick Mahomes", team: "KC", position: "QB", slot: "QB", projection: 18.2 },
  { name: "Travis Etienne Jr.", team: "NO", position: "RB", slot: "RB", projection: 12.2 },
  { name: "Derrick Henry", team: "BAL", position: "RB", slot: "RB", projection: 17.1 },
  { name: "Chuba Hubbard", team: "CAR", position: "RB", slot: "FLEX", projection: 14.5 },
  { name: "Amon-Ra St. Brown", team: "DET", position: "WR", slot: "WR", projection: 20.4 },
  { name: "Chris Olave", team: "NO", position: "WR", slot: "WR", projection: 15.8, injury: "Q" },
  { name: "George Kittle", team: "SF", position: "TE", slot: "TE", projection: 10.5, injury: "Q" },
  { name: "Lions D/ST", team: "DET", position: "DST", slot: "DST", projection: 3.5 },
  { name: "Eddy Piñeiro", team: "SF", position: "K", slot: "K", projection: 9.9, injury: "Q" },
  { name: "Davante Adams", team: "LAR", position: "WR", slot: "Bench", projection: 13.7 },
  { name: "Jameson Williams", team: "DET", position: "WR", slot: "Bench", projection: 12.3 },
  { name: "Brock Purdy", team: "SF", position: "QB", slot: "Bench", projection: 20.7 },
  { name: "Caleb Douglas", team: "MIA", position: "WR", slot: "Bench", projection: 8.9 },
  { name: "Michael Mayer", team: "LV", position: "TE", slot: "Bench", projection: 6.1 },
  { name: "Wan'Dale Robinson", team: "TEN", position: "WR", slot: "Bench", projection: 9.5 },
];

export function fallbackSnapshot(): SyncSnapshot {
  const { season, week } = nflPeriod();
  const roster = historicalRoster.map((p) => ({ ...p, canonicalPlayerId: canonicalPlayerId(p.name, p.team) }));
  return {
    id: "fallback",
    season,
    week,
    leagueName: "FANTASY VALDES",
    generatedAt: new Date().toISOString(),
    dataAsOf: "2026-09-18T15:30:00.000Z",
    freshness: "STALE",
    health: "DEGRADED",
    projectedScore: null,
    opponentScore: null,
    winProbability: null,
    roster,
    recommendations: topLineupRecommendations(roster).map((r) => ({ ...r, actionable: false })),
    agents: [{ name: "LeagueIntelligence", status: "degraded", latencyMs: 0, cacheHit: true, message: "Esperando ingesta actual de la liga." }],
    sources: [],
    warnings: ["Snapshot histórico: no usar para movimientos actuales.", "Conecta una fuente de liga mediante /api/external-sync."],
  };
}
