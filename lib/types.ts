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

export interface RecentGameUsage {
  week: number;
  fantasyPointsPpr?: number;
  snapShare?: number;
  targets?: number;
  targetShare?: number;
  routes?: number;
  routeParticipation?: number;
  carries?: number;
  receptions?: number;
  touches?: number;
  redZoneTouches?: number;
  insideFiveTouches?: number;
  touchdowns?: number;
  yprr?: number;
  ycoPerAttempt?: number;
}

export interface PlayerDecisionProfile {
  floor: number;
  median: number;
  ceiling: number;
  confidence: number;
  sampleGames: number;
  snapShare?: number;
  targetShare?: number;
  routeParticipation?: number;
  touchesPerGame?: number;
  redZoneTouchesPerGame?: number;
  insideFiveTouchesPerGame?: number;
  yprr?: number;
  ycoPerAttempt?: number;
  gameScript: string;
  hiddenFactor: string;
  missing: string[];
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
  windMph?: number;
  overUnder?: number;
  spread?: number;
  divisional?: boolean;
  shortWeek?: boolean;
  offensiveLineAbsences?: number;
  opponentCoverageAbsences?: number;
  opponentFrontSevenAbsences?: number;
  quarterbackRisk?: boolean;
  opponentPointsAllowedL3?: number;
  locked?: boolean;
  injury?: string;
  news?: string;
  newsTimestamp?: string;
  recentGames?: RecentGameUsage[];
  decisionProfile?: PlayerDecisionProfile;
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
  partner?: string;
}

export interface TeamRecord {
  wins: number;
  losses: number;
  ties: number;
  rank?: number;
  streak?: string;
  pointsFor?: number;
  pointsAgainst?: number;
}

export interface TradePartner {
  teamId: string;
  name: string;
  roster: RosterPlayer[];
}

export interface AgentRun {
  name: string;
  status: AgentStatus;
  latencyMs: number;
  cacheHit: boolean;
  message?: string;
  mode?: "external" | "calculation" | "snapshot" | "unavailable";
  records?: number;
}

export interface PendingMove {
  kind: "waiver" | "trade";
  status: "pending" | "unknown";
  add?: string;
  drop?: string;
  partner?: string;
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
  scoreMode?: "actual" | "projection";
  teamRecord?: TeamRecord;
  opponentName?: string;
  roster: RosterPlayer[];
  recommendations: Recommendation[];
  agents: AgentRun[];
  sources: SourceRef[];
  warnings: string[];
  pendingMoves?: PendingMove[];
}
