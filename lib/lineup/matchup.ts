import { buildDecisionProfile, optimizeLineup } from "../engine";
import { isStale } from "../time";
import type { PlayerDecisionProfile, RosterPlayer, SourceRef } from "../types";
import { parseMatchupSignals, type MatchupSignal } from "./schemas";

export type LineupStrategy = "SAFE" | "BALANCED" | "UPSIDE";

export const MATCHUP_MAX_ADJUSTMENT = 0.12;
const MATCHUP_SOURCE_TTL_MS = 24 * 60 * 60_000;
const SAMPLE_PRIOR = 4;

const expectedSignals: Record<RosterPlayer["position"], readonly MatchupSignal["kind"][]> = {
  QB: ["pass-defense", "pass-rush", "game-environment"],
  RB: ["run-defense", "front-seven", "game-environment"],
  WR: ["pass-defense", "coverage", "game-environment"],
  TE: ["pass-defense", "coverage", "game-environment"],
  DST: ["opponent-qb", "opponent-line", "turnover", "game-environment"],
  K: ["game-environment"],
};

export interface MatchupProfile {
  floor: number;
  median: number;
  ceiling: number;
  adjustmentPct: number;
  confidence: number;
  roleWeight: number;
  factors: string[];
  missing: string[];
  sources: SourceRef[];
}

export type MatchupLineupPlayer = RosterPlayer & { matchupProfile: MatchupProfile };

export interface MatchupLineupOptions {
  /** Explicit flag input. False preserves the existing optimizer's exact result. */
  enabled: boolean;
  strategy?: LineupStrategy;
  signalsByPlayer?: Record<string, unknown>;
  now?: Date;
}

export interface MatchupLineupResult {
  enabled: boolean;
  strategy: LineupStrategy;
  lineup: RosterPlayer[];
  players: RosterPlayer[];
  adjustments: Array<{ canonicalPlayerId: string; profile: MatchupProfile }>;
}

/**
 * Scores supplied by a provider are already normalized to [-1, 1]. This function
 * only shrinks them for sample size, evidence coverage, freshness and player role.
 * Missing or stale matchup evidence yields zero adjustment.
 */
export function calculateMatchupProfile(
  player: RosterPlayer,
  inputSignals: unknown = [],
  now = new Date(),
): MatchupProfile {
  const { signals, rejectedCount } = parseMatchupSignals(inputSignals);
  const baseline = projectionRange(player);
  const usage = player.decisionProfile ?? buildDecisionProfile(player);
  const roleWeight = getRoleWeight(player.position, usage);
  const expected = expectedSignals[player.position];
  const missing = expected.filter((kind) => !signals.some((signal) => signal.kind === kind)).map((kind) => `no disponible: ${kind}`);
  const usedByKind = new Map<MatchupSignal["kind"], MatchupSignal[]>();
  const staleKinds = new Set<MatchupSignal["kind"]>();
  const fresh = signals.filter((signal) => {
    const fetched = Date.parse(signal.source.fetchedAt);
    const isFuture = !Number.isFinite(fetched) || fetched > now.getTime() + 5 * 60_000;
    if (isFuture || isStale(signal.source.fetchedAt, MATCHUP_SOURCE_TTL_MS, now)) {
      staleKinds.add(signal.kind);
      return false;
    }
    return expected.includes(signal.kind);
  });

  // Count one signal per provider and type so syndicated duplicates cannot amplify an edge.
  const unique = new Map<string, MatchupSignal>();
  for (const signal of fresh) {
    const key = `${signal.kind}|${signal.source.name.trim().toLowerCase()}`;
    const previous = unique.get(key);
    if (!previous || Date.parse(signal.source.fetchedAt) > Date.parse(previous.source.fetchedAt)) unique.set(key, signal);
  }
  for (const signal of unique.values()) usedByKind.set(signal.kind, [...(usedByKind.get(signal.kind) ?? []), signal]);

  const kindEdges = new Map<MatchupSignal["kind"], number>();
  const usedSignals = [...unique.values()];
  for (const [kind, rows] of usedByKind) {
    const contributions = rows.map((signal) => {
      const shrinkage = signal.sampleSize / (signal.sampleSize + SAMPLE_PRIOR);
      return signal.edge * shrinkage * signal.sourceConfidence;
    });
    kindEdges.set(kind, contributions.reduce((sum, value) => sum + value, 0) / contributions.length);
  }

  for (const kind of staleKinds) {
    const label = `fuente vencida: ${kind}`;
    if (!missing.includes(label)) missing.push(label);
  }
  if (rejectedCount) missing.push(`${rejectedCount} señal(es) inválida(s) descartada(s)`);
  if (roleWeight === 0 && ["QB", "RB", "WR", "TE"].includes(player.position)) missing.push("uso del jugador no disponible");

  const matchupEdge = expected.length
    ? expected.reduce((sum, kind) => sum + (kindEdges.get(kind) ?? 0), 0) / expected.length
    : 0;
  const adjustmentPct = clamp(matchupEdge * roleWeight * MATCHUP_MAX_ADJUSTMENT, -MATCHUP_MAX_ADJUSTMENT, MATCHUP_MAX_ADJUSTMENT);
  const adjusted = adjustRange(baseline, adjustmentPct);
  const coverage = expected.length ? kindEdges.size / expected.length : 0;
  const sampleQuality = usedSignals.length
    ? usedSignals.reduce((sum, signal) => sum + signal.sampleSize / (signal.sampleSize + SAMPLE_PRIOR), 0) / usedSignals.length
    : 0;
  const sourceQuality = usedSignals.length
    ? usedSignals.reduce((sum, signal) => sum + signal.sourceConfidence, 0) / usedSignals.length
    : 0;
  const confidence = Math.round(100 * coverage * sampleQuality * sourceQuality * (roleWeight || (player.position === "DST" || player.position === "K" ? 1 : 0)));

  return {
    ...adjusted,
    adjustmentPct: round(adjustmentPct),
    confidence,
    roleWeight: round(roleWeight),
    factors: usedSignals.map((signal) => `${signal.kind}: ${signal.edge > 0 ? "favorable" : signal.edge < 0 ? "desfavorable" : "neutral"} (${signal.source.name})`),
    missing,
    sources: usedSignals.map((signal) => signal.source),
  };
}

export function isMatchupLineupV2Enabled(flagValue: string | undefined) {
  return flagValue?.trim().toLowerCase() === "true";
}

/** Reuses the established slot/lock optimizer and changes only its scoring input. */
export function optimizeMatchupAwareLineup(players: RosterPlayer[], options: MatchupLineupOptions): MatchupLineupResult {
  const strategy = options.enabled ? options.strategy ?? "BALANCED" : "BALANCED";
  if (!options.enabled) {
    const lineup = optimizeLineup(players);
    return { enabled: false, strategy, lineup, players, adjustments: [] };
  }

  const now = options.now ?? new Date();
  const enriched = players.map((player) => {
    const profile = calculateMatchupProfile(player, options.signalsByPlayer?.[player.canonicalPlayerId] ?? [], now);
    const base = player.decisionProfile ?? profileFromPlayer(player);
    const decisionProfile: PlayerDecisionProfile = {
      ...base,
      floor: profile.floor,
      median: profile.median,
      ceiling: profile.ceiling,
      confidence: profile.confidence || base.confidence,
      hiddenFactor: profile.factors[0] ?? base.hiddenFactor,
      missing: [...new Set([...base.missing, ...profile.missing])],
    };
    return { ...player, decisionProfile, matchupProfile: profile } satisfies MatchupLineupPlayer;
  });
  const enrichedById = new Map(enriched.map((player) => [player.canonicalPlayerId, player]));
  const scored = enriched.map((player) => {
    const score = strategyScore(player.matchupProfile, strategy);
    // Keep the production optimizer's opportunity/depth/health modifiers, while
    // making its projection term represent the selected strategy only.
    const scoringProfile: PlayerDecisionProfile = {
      ...player.decisionProfile!, floor: score, median: score, ceiling: score,
    };
    return { ...player, decisionProfile: scoringProfile };
  });
  const selected = optimizeLineup(scored).flatMap((player) => {
    const original = enrichedById.get(player.canonicalPlayerId);
    return original ? [{ ...original, slot: player.slot }] : [];
  });
  return {
    enabled: true,
    strategy,
    lineup: selected,
    players: enriched,
    adjustments: enriched.map(({ canonicalPlayerId, matchupProfile }) => ({ canonicalPlayerId, profile: matchupProfile })),
  };
}

/** Reproducible independent-score comparison; null means no sourced range exists. */
export function probabilityOutscores(
  first: RosterPlayer,
  second: RosterPlayer,
  options: { iterations?: number; seed?: number } = {},
): number | null {
  const firstRange = availableRange(first);
  const secondRange = availableRange(second);
  if (!firstRange || !secondRange) return null;
  const iterations = Math.max(1, Math.min(50_000, Math.floor(options.iterations ?? 5_000)));
  let state = (options.seed ?? 42) >>> 0;
  const random = () => ((state = (1664525 * state + 1013904223) >>> 0) / 4294967296);
  let wins = 0;
  let ties = 0;
  for (let index = 0; index < iterations; index++) {
    const a = triangular(firstRange, random());
    const b = triangular(secondRange, random());
    if (a > b) wins++;
    else if (a === b) ties++;
  }
  return Math.round(((wins + ties / 2) / iterations) * 100);
}

function projectionRange(player: RosterPlayer) {
  const median = Math.max(0, player.decisionProfile?.median ?? player.projection ?? 0);
  const floor = clamp(player.decisionProfile?.floor ?? player.floor ?? median, 0, median);
  const ceiling = Math.max(median, player.decisionProfile?.ceiling ?? player.ceiling ?? median);
  return { floor, median, ceiling };
}

function profileFromPlayer(player: RosterPlayer): PlayerDecisionProfile {
  const range = projectionRange(player);
  const usage = buildDecisionProfile(player);
  return {
    ...usage,
    ...range,
    confidence: 0,
    hiddenFactor: "sin rango de matchup verificado",
  };
}

function getRoleWeight(position: RosterPlayer["position"], profile: PlayerDecisionProfile) {
  if (position === "K" || position === "DST") return 1;
  const candidateShares = position === "RB"
    ? [profile.snapShare, profile.targetShare, profile.touchesPerGame == null ? undefined : profile.touchesPerGame / 20]
    : position === "WR" || position === "TE"
      ? [profile.snapShare, profile.routeParticipation, profile.targetShare]
      : [profile.snapShare];
  const shares = candidateShares.filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return shares.length ? clamp(Math.max(...shares), 0, 1) : 0;
}

function adjustRange(range: { floor: number; median: number; ceiling: number }, adjustment: number) {
  const floorFactor = adjustment < 0 ? 1.2 : 0.65;
  const ceilingFactor = adjustment > 0 ? 1.2 : 0.65;
  const median = Math.max(0, range.median * (1 + adjustment));
  const floor = Math.max(0, Math.min(median, range.floor * (1 + adjustment * floorFactor)));
  const ceiling = Math.max(median, range.ceiling * (1 + adjustment * ceilingFactor));
  return { floor: round(floor), median: round(median), ceiling: round(ceiling) };
}

export function strategyScore(profile: MatchupProfile, strategy: LineupStrategy) {
  if (strategy === "SAFE") return profile.floor * 0.7 + profile.median * 0.3;
  if (strategy === "UPSIDE") return profile.median * 0.5 + profile.ceiling * 0.5;
  return profile.median;
}

function availableRange(player: RosterPlayer): { floor: number; median: number; ceiling: number } | null {
  const matchupProfile = (player as Partial<MatchupLineupPlayer>).matchupProfile;
  if (matchupProfile) return matchupProfile;
  if (player.decisionProfile) return player.decisionProfile;
  if (player.projection != null && player.floor != null && player.ceiling != null) {
    return { floor: player.floor, median: player.projection, ceiling: player.ceiling };
  }
  return null;
}

function triangular(range: { floor: number; median: number; ceiling: number }, uniform: number) {
  const width = range.ceiling - range.floor;
  if (width <= 0) return range.median;
  const split = (range.median - range.floor) / width;
  if (uniform < split) return range.floor + Math.sqrt(uniform * width * (range.median - range.floor));
  return range.ceiling - Math.sqrt((1 - uniform) * width * (range.ceiling - range.median));
}

function clamp(value: number, lower: number, upper: number) {
  return Math.max(lower, Math.min(upper, value));
}

function round(value: number) {
  return Math.round(value * 100) / 100;
}
