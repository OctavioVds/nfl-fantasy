import { z } from "zod";

export const externalPlayerSchema = z.object({
  providerId: z.string().min(1),
  name: z.string().min(1),
  team: z.string().min(1).max(4),
  position: z.enum(["QB", "RB", "WR", "TE", "DST", "K"]),
  slot: z.string().min(1),
  projection: z.number().finite().nonnegative().optional(),
  futureProjection: z.number().finite().nonnegative().optional(),
  opportunityScore: z.number().finite().min(0).max(100).optional(),
  depthOrder: z.number().int().min(1).max(20).optional(),
  kickoff: z.string().datetime().optional(),
  injury: z.string().max(32).optional(),
});

export const externalSyncSchema = z.object({
  league: z.object({
    name: z.string().min(1),
    season: z.number().int().min(2020).max(2100),
    week: z.number().int().min(1).max(18),
    scoring: z.record(z.string(), z.number()).default({ reception: 1 }),
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
  source: z.enum(["flaim", "espn", "manual", "chatgpt"]),
  sourceTimestamp: z.string().datetime(),
});

export type ExternalSyncPayload = z.infer<typeof externalSyncSchema>;
