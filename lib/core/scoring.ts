import { createHash } from "node:crypto";
import type { Scoring } from "./schema";

export function scoringHash(scoring: Scoring) {
  const key = (rule: { stat: string; position?: string | null; mode: string; threshold?: number | null }) => `${rule.stat}|${rule.position ?? ""}|${rule.mode}|${rule.threshold ?? ""}`;
  const rules = scoring.rules.map((rule) => ({ stat: rule.stat, points: rule.points, position: rule.position ?? null, threshold: rule.threshold ?? null, mode: rule.mode })).sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0);
  return createHash("sha256").update(JSON.stringify(rules)).digest("hex");
}

export function fantasyPoints(stats: Record<string, number | null>, scoring: Scoring, position: string): { value: number | null; reason: string | null } {
  let value = 0;
  for (const rule of scoring.rules.filter((rule) => !rule.position || rule.position === position)) {
    const stat = stats[rule.stat];
    if (stat == null || !Number.isFinite(stat)) return { value: null, reason: `Missing stat ${rule.stat}` };
    value += rule.mode === "bonus" ? stat >= rule.threshold! ? rule.points : 0 : stat * rule.points;
  }
  return { value, reason: null };
}

/** Input probabilities/efficiencies must be observed or calibrated, never universal 2.5×. */
export function weightedOpportunity(kind: "target" | "carry", input: { catchProbability?: number; expectedYards: number; touchdownProbability: number }, scoring: Scoring, position: string) {
  const rules = scoring.rules.filter((rule) => !rule.position || rule.position === position);
  if (rules.some((rule) => rule.mode === "bonus")) return { value: null, reason: "Bonuses require the full yards distribution" };
  const reception = rules.find((rule) => rule.stat === "receptions")?.points;
  const yards = rules.find((rule) => rule.stat === (kind === "target" ? "recYards" : "rushYards"))?.points;
  const td = rules.find((rule) => rule.stat === (kind === "target" ? "recTd" : "rushTd"))?.points;
  if (yards == null || td == null || (kind === "target" && (reception == null || input.catchProbability == null))) return { value: null, reason: "Scoring or target efficiency unavailable" };
  const value = kind === "target" ? input.catchProbability! * (reception! + input.expectedYards * yards) + input.touchdownProbability * td : input.expectedYards * yards + input.touchdownProbability * td;
  return { value, reason: null };
}
