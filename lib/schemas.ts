import { z } from "zod";

export const externalPlayerSchema = z.object({
  providerId: z.string().min(1),
  name: z.string().min(1),
  team: z.string().min(1).max(4),
  position: z.enum(["QB", "RB", "WR", "TE", "DST", "K"]),
  slot: z.string().min(1),
  projection: z.number().finite().nonnegative().optional(),
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
  opponentProjection: z.number().finite().nonnegative().optional(),
  freeAgents: z.array(externalPlayerSchema).default([]),
  source: z.enum(["flaim", "espn", "manual", "chatgpt"]),
  sourceTimestamp: z.string().datetime(),
});

export type ExternalSyncPayload = z.infer<typeof externalSyncSchema>;
