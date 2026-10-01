import { z } from "zod";

export const externalPlayerSchema = z.object({
  providerId: z.string().min(1),
  name: z.string().min(1),
  team: z.string().min(1).max(4),
  position: z.enum(["QB", "RB", "WR", "TE", "DST", "K"]),
  slot: z.string().min(1),
  projection: z.number().finite().optional(),
  futureProjection: z.number().finite().nonnegative().optional(),
  opportunityScore: z.number().finite().min(0).max(100).optional(),
  depthOrder: z.number().int().min(1).max(20).optional(),
  kickoff: z.string().datetime().optional(),
  injury: z.string().max(32).optional(),
});

export const externalSyncSchema = z.object({
  league: z.object({
    name: z.string().min(1),
    leagueId: z.string().min(1).optional(),
    teamId: z.string().min(1).optional(),
    season: z.number().int().min(2020).max(2100),
    week: z.number().int().min(1).max(18),
    teamCount: z.number().int().min(1).max(32).optional(),
    scoring: z.record(z.string(), z.number()).optional(),
  }),
  roster: z.array(externalPlayerSchema).min(1),
  teamRecord: z.object({
    wins: z.number().int().nonnegative(),
    losses: z.number().int().nonnegative(),
    ties: z.number().int().nonnegative().default(0),
    rank: z.number().int().positive().optional(),
    streak: z.string().max(12).optional(),
    pointsFor: z.number().finite().nonnegative().optional(),
    pointsAgainst: z.number().finite().nonnegative().optional(),
  }).optional(),
  opponent: z.object({
    teamId: z.string().min(1),
    name: z.string().min(1),
    record: z.object({
      wins: z.number().int().nonnegative(), losses: z.number().int().nonnegative(), ties: z.number().int().nonnegative().default(0),
    }).optional(),
    roster: z.array(externalPlayerSchema).default([]),
  }).optional(),
  nextOpponent: z.object({
    week: z.number().int().min(1).max(18), teamId: z.string().min(1), name: z.string().min(1),
    roster: z.array(externalPlayerSchema).default([]),
  }).optional(),
  currentScore: z.number().finite().optional(),
  matchupComplete: z.boolean().optional(),
  tradePartners: z.array(z.object({
    teamId: z.string().min(1), name: z.string().min(1), roster: z.array(externalPlayerSchema),
  })).optional(),
  opponentProjection: z.number().finite().nonnegative().optional(),
  freeAgents: z.array(externalPlayerSchema).default([]),
  pendingMoves: z.array(z.object({
    kind: z.enum(["waiver", "trade"]),
    status: z.enum(["pending", "unknown"]),
    add: z.string().min(1).optional(),
    drop: z.string().min(1).optional(),
    partner: z.string().min(1).optional(),
  })).optional(),
  source: z.enum(["flaim", "espn", "manual", "chatgpt"]),
  sourceTimestamp: z.string().datetime(),
  fetchedAt: z.string().datetime().optional(),
}).superRefine((payload, context) => {
  const rosterIds = new Set(payload.roster.map((player) => player.providerId));
  const occupiedAvailableIds = payload.freeAgents.filter((player) => rosterIds.has(player.providerId)).map((player) => player.providerId);
  if (occupiedAvailableIds.length) context.addIssue({ code: "custom", path: ["freeAgents"], message: "Un jugador del roster aparece también como disponible." });
});

export type ExternalSyncPayload = z.infer<typeof externalSyncSchema>;
