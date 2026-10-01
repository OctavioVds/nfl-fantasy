import { z } from "zod";

export const matchupSignalKinds = [
  "pass-defense",
  "run-defense",
  "coverage",
  "front-seven",
  "pass-rush",
  "opponent-qb",
  "opponent-line",
  "turnover",
  "game-environment",
] as const;

export const matchupSignalSchema = z.object({
  kind: z.enum(matchupSignalKinds),
  // Normalized signal from verified provider data: -1 is strongly unfavorable, +1 strongly favorable.
  edge: z.number().finite().min(-1).max(1),
  sampleSize: z.number().finite().min(0).max(100_000),
  sourceConfidence: z.number().finite().min(0).max(1),
  source: z.object({
    name: z.string().min(1),
    url: z.string().url().optional(),
    sourceTimestamp: z.string().datetime(),
    fetchedAt: z.string().datetime(),
    season: z.number().int().min(2020).max(2100),
    week: z.number().int().min(1).max(18),
    gameStatus: z.enum(["pre", "in", "post", "unknown"]),
  }).strict(),
}).strict();

export const matchupSignalsSchema = z.array(matchupSignalSchema).max(100);

export type MatchupSignal = z.infer<typeof matchupSignalSchema>;

export function parseMatchupSignals(input: unknown) {
  if (!Array.isArray(input)) return { signals: [] as MatchupSignal[], rejectedCount: 1 };
  const signals: MatchupSignal[] = [];
  let rejectedCount = Math.max(0, input.length - 100);
  for (const candidate of input.slice(0, 100)) {
    const parsed = matchupSignalSchema.safeParse(candidate);
    if (parsed.success) signals.push(parsed.data);
    else rejectedCount++;
  }
  return { signals, rejectedCount };
}
