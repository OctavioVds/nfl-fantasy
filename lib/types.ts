export type Confidence = "HIGH" | "MEDIUM" | "LOW";
export type AgentStatus = "ok" | "degraded" | "failed" | "cached";
export type ActionKind = "START" | "SIT" | "ADD" | "DROP" | "HOLD" | "TRADE" | "WATCH" | "STREAM";

export interface SourceRef {
  name: string;
  url?: string;
  sourceTimestamp: string;
  fetchedAt: string;
  season: number;
  week: number;
  gameStatus: "pre" | "in" | "post" | "unknown";
}

export interface PlayerProjection {
  canonicalPlayerId: string;
  name: string;
  team: string;
  position: string;
  source: string;
  points: number;
  floor?: number;
  ceiling?: number;
  sourceTimestamp: string;
}

export interface RosterPlayer {
  canonicalPlayerId: string;
  name: string;
  team: string;
  position: "QB" | "RB" | "WR" | "TE" | "DST" | "K";
  slot: string;
  projection?: number;
  futureProjection?: number;
  opportunityScore?: number;
  depthOrder?: number;
  floor?: number;
  ceiling?: number;
  kickoff?: string;
  opponent?: string;
  homeAway?: "home" | "away";
  venue?: string;
  weather?: string;
  locked?: boolean;
  injury?: string;
}

export interface Recommendation {
  id: string;
  kind: ActionKind;
  headline: string;
  target?: string;
  alternative?: string;
  confidence: Confidence;
  confidenceScore: number;
  risk: string;
  why: { type: "FACT" | "INFERENCE" | "MODEL"; text: string }[];
  actionable: boolean;
  priority?: number;
}

export interface AgentRun {
  name: string;
  status: AgentStatus;
  latencyMs: number;
  cacheHit: boolean;
  message?: string;
}

export interface SyncSnapshot {
  id: string;
  season: number;
  week: number;
  leagueName: string;
  generatedAt: string;
  dataAsOf: string;
  freshness: "FRESH" | "STALE" | "DEGRADED";
  health: "HEALTHY" | "DEGRADED" | "ERROR";
  projectedScore: number | null;
  opponentScore: number | null;
  winProbability: number | null;
  roster: RosterPlayer[];
  recommendations: Recommendation[];
  agents: AgentRun[];
  sources: SourceRef[];
  warnings: string[];
}
