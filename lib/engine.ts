import type { PlayerProjection, Recommendation, RosterPlayer } from "./types";

export function pprPoints(input: {
  passYards?: number; passTd?: number; interceptions?: number;
  rushYards?: number; rushTd?: number; receptions?: number;
  recYards?: number; recTd?: number; fumblesLost?: number;
}) {
  return (input.passYards ?? 0) / 25 + (input.passTd ?? 0) * 4 - (input.interceptions ?? 0) * 2 +
    (input.rushYards ?? 0) / 10 + (input.rushTd ?? 0) * 6 + (input.receptions ?? 0) +
    (input.recYards ?? 0) / 10 + (input.recTd ?? 0) * 6 - (input.fumblesLost ?? 0) * 2;
}

export function canonicalPlayerId(name: string, team?: string) {
  return `${name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")}${team ? `-${team.toLowerCase()}` : ""}`;
}

export function aggregateProjections(projections: PlayerProjection[]) {
  if (!projections.length) return null;
  const unique = new Map(projections.map((p) => [p.source, p]));
  const values = [...unique.values()].map((p) => p.points).sort((a, b) => a - b);
  const median = values.length % 2 ? values[(values.length - 1) / 2] : (values[values.length / 2 - 1] + values[values.length / 2]) / 2;
  const floor = Math.min(...values.map((v) => v * 0.7));
  const ceiling = Math.max(...values.map((v) => v * 1.3));
  return { median: round(median), floor: round(floor), ceiling: round(ceiling), sources: values.length };
}

export function optimizeLineup(players: RosterPlayer[]) {
  const unlocked = players.filter((p) => !p.locked);
  const sort = (pos: string) => unlocked.filter((p) => p.position === pos).sort((a, b) => (b.projection ?? -1) - (a.projection ?? -1));
  const used = new Set<string>();
  const take = (list: RosterPlayer[], count: number) => list.filter((p) => !used.has(p.canonicalPlayerId)).slice(0, count).map((p) => (used.add(p.canonicalPlayerId), p));
  const starters = [...take(sort("QB"), 1), ...take(sort("RB"), 2), ...take(sort("WR"), 2), ...take(sort("TE"), 1)];
  const flex = take(unlocked.filter((p) => ["RB", "WR"].includes(p.position)).sort((a, b) => (b.projection ?? -1) - (a.projection ?? -1)), 1);
  const fixed = players.filter((p) => p.locked && !["Bench", "IR"].includes(p.slot));
  return [...fixed, ...starters, ...flex, ...take(sort("DST"), 1), ...take(sort("K"), 1)];
}

export function simulateWin(myMedian: number, oppMedian: number, iterations = 5000, seed = 42) {
  let state = seed >>> 0;
  const random = () => ((state = (1664525 * state + 1013904223) >>> 0) / 4294967296);
  const normal = () => Math.sqrt(-2 * Math.log(Math.max(random(), 1e-9))) * Math.cos(2 * Math.PI * random());
  let wins = 0;
  for (let i = 0; i < iterations; i++) if (myMedian + normal() * 16 > oppMedian + normal() * 16) wins++;
  return Math.round((wins / iterations) * 100);
}

export function topLineupRecommendations(players: RosterPlayer[]): Recommendation[] {
  const optimized = optimizeLineup(players);
  const current = players.filter((p) => !["Bench", "IR"].includes(p.slot));
  const moves: Recommendation[] = [];
  for (const starter of optimized) {
    if (current.some((p) => p.canonicalPlayerId === starter.canonicalPlayerId) || starter.locked) continue;
    const replacement = current.filter((p) => !p.locked && (p.position === starter.position || (["RB", "WR"].includes(p.position) && ["RB", "WR"].includes(starter.position))))
      .sort((a, b) => (a.projection ?? 99) - (b.projection ?? 99))[0];
    if (!replacement || (starter.projection ?? 0) <= (replacement.projection ?? 0)) continue;
    const delta = round((starter.projection ?? 0) - (replacement.projection ?? 0));
    moves.push({
      id: `start-${starter.canonicalPlayerId}`,
      kind: "START",
      headline: `START ${starter.name} sobre ${replacement.name}`,
      target: starter.name,
      alternative: replacement.name,
      confidence: delta >= 3 ? "HIGH" : "MEDIUM",
      confidenceScore: Math.min(9, Math.max(5, Math.round(5 + delta / 2))),
      risk: "Las proyecciones son estimaciones; noticias tardías pueden cambiar el papel.",
      why: [{ type: "MODEL", text: `Ventaja mediana estimada: +${delta} puntos PPR.` }],
      actionable: true,
    });
  }
  return moves.slice(0, 3);
}

const round = (value: number) => Math.round(value * 10) / 10;
