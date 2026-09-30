import { describe, expect, it } from "vitest";
import { canonicalPlayerId, optimizeLineup } from "@/lib/engine";
import { calculateMatchupProfile, isMatchupLineupV2Enabled, MATCHUP_MAX_ADJUSTMENT, optimizeMatchupAwareLineup, probabilityOutscores, strategyScore } from "@/lib/lineup/matchup";
import { matchupSignalSchema, parseMatchupSignals, type MatchupSignal } from "@/lib/lineup/schemas";
import type { RosterPlayer } from "@/lib/types";

const now = new Date("2026-09-30T18:00:00Z");
const player = (name: string, position: RosterPlayer["position"], projection: number, slot = "Bench"): RosterPlayer => ({
  canonicalPlayerId: canonicalPlayerId(name), name, position, team: "X", slot,
  projection, floor: projection * 0.7, ceiling: projection * 1.3,
  recentGames: [{ week: 3, snapShare: 0.8, targetShare: 0.25, routeParticipation: 0.9, touches: 15 }],
});

function signal(kind: MatchupSignal["kind"], edge: number, sampleSize: number, provider = "Stats API"): MatchupSignal {
  return {
    kind, edge, sampleSize, sourceConfidence: 0.9,
    source: {
      name: provider, url: "https://example.com/matchup", sourceTimestamp: "2026-09-30T17:00:00Z",
      fetchedAt: "2026-09-30T17:30:00Z", season: 2026, week: 4, gameStatus: "pre",
    },
  };
}

describe("matchup signal validation", () => {
  it("rejects malformed matchup scores and missing provenance", () => {
    expect(matchupSignalSchema.safeParse({ ...signal("coverage", 2, 10) }).success).toBe(false);
    expect(parseMatchupSignals([signal("coverage", 0.8, 8), { kind: "coverage", edge: 3 }])).toMatchObject({ rejectedCount: 1 });
    expect(parseMatchupSignals(Array.from({ length: 101 }, () => signal("coverage", 0.2, 8))).rejectedCount).toBe(1);
  });

  it("ignores stale evidence and reports its missing category", () => {
    const stale = { ...signal("pass-defense", 1, 20), source: { ...signal("pass-defense", 1, 20).source, fetchedAt: "2026-09-28T17:00:00Z" } };
    const profile = calculateMatchupProfile(player("Receiver", "WR", 12), [stale], now);
    expect(profile.adjustmentPct).toBe(0);
    expect(profile.missing).toContain("fuente vencida: pass-defense");
  });
});

describe("matchup adjustment", () => {
  it("shrinks a small sample toward neutral", () => {
    const receiver = player("Small sample", "WR", 12);
    const small = calculateMatchupProfile(receiver, [signal("pass-defense", 1, 1)], now);
    const large = calculateMatchupProfile(receiver, [signal("pass-defense", 1, 100)], now);
    expect(small.adjustmentPct).toBeGreaterThan(0);
    expect(small.adjustmentPct).toBeLessThan(large.adjustmentPct);
  });

  it("penalizes a supported difficult run matchup and exposes unavailable coverage evidence", () => {
    const back = player("Runner", "RB", 16);
    const hardRun = calculateMatchupProfile(back, [signal("run-defense", -1, 20)], now);
    expect(hardRun.adjustmentPct).toBeLessThan(0);
    const receiver = calculateMatchupProfile(player("Receiver", "WR", 12), [signal("pass-defense", 0.8, 12)], now);
    expect(receiver.missing).toContain("no disponible: coverage");
    expect(receiver.confidence).toBeLessThan(50);
  });

  it("deduplicates repeated provider signals before calculating an edge", () => {
    const receiver = player("Receiver", "WR", 12);
    const single = signal("pass-defense", 0.8, 20, "Same provider");
    const repeated = { ...single, edge: -1 };
    expect(calculateMatchupProfile(receiver, [single], now).adjustmentPct)
      .toBe(calculateMatchupProfile(receiver, [single, repeated], now).adjustmentPct);
  });

  it("caps the median and preserves floor <= median <= ceiling", () => {
    const receiver = player("Strong matchup", "WR", 12);
    const signals = [
      signal("pass-defense", 1, 100_000, "Provider A"),
      signal("coverage", 1, 100_000, "Provider B"),
      signal("game-environment", 1, 100_000, "Provider C"),
    ];
    const profile = calculateMatchupProfile(receiver, signals, now);
    expect(profile.adjustmentPct).toBeLessThanOrEqual(MATCHUP_MAX_ADJUSTMENT);
    expect(profile.adjustmentPct).toBeGreaterThanOrEqual(-MATCHUP_MAX_ADJUSTMENT);
    expect(profile.floor).toBeLessThanOrEqual(profile.median);
    expect(profile.median).toBeLessThanOrEqual(profile.ceiling);
  });

  it("does not turn a strong matchup into a boost when player usage is missing", () => {
    const lowEvidenceRole = { ...player("Unknown role", "WR", 12), recentGames: undefined };
    const profile = calculateMatchupProfile(lowEvidenceRole, [signal("pass-defense", 1, 100)], now);
    expect(profile.adjustmentPct).toBe(0);
    expect(profile.confidence).toBe(0);
    expect(profile.missing).toContain("uso del jugador no disponible");
  });

  it("uses the existing optimizer unchanged when the feature flag is off", () => {
    const roster = [player("Quarterback", "QB", 20), player("Runner", "RB", 15), player("Wide one", "WR", 16)];
    expect(optimizeMatchupAwareLineup(roster, { enabled: false, strategy: "UPSIDE" }).lineup).toEqual(optimizeLineup(roster));
    expect(optimizeMatchupAwareLineup(roster, { enabled: false }).adjustments).toEqual([]);
    expect(isMatchupLineupV2Enabled(undefined)).toBe(false);
    expect(isMatchupLineupV2Enabled("true")).toBe(true);
    expect(isMatchupLineupV2Enabled("TRUE")).toBe(true);
    expect(isMatchupLineupV2Enabled("1")).toBe(false);
  });

  it("orders SAFE, BALANCED and UPSIDE strategy scores by their intended ranges", () => {
    const range = { floor: 4, median: 10, ceiling: 30, adjustmentPct: 0, confidence: 0, roleWeight: 1, factors: [], missing: [], sources: [] };
    expect(strategyScore(range, "SAFE")).toBe(5.8);
    expect(strategyScore(range, "BALANCED")).toBe(10);
    expect(strategyScore(range, "UPSIDE")).toBe(20);
  });

  it("reuses slot assignment and keeps locked starters while applying strategy", () => {
    const locked = { ...player("Locked WR", "WR", 5, "WR"), locked: true };
    const roster = [
      { ...player("Quarterback", "QB", 20), slot: "QB" },
      { ...player("Back one", "RB", 15), slot: "RB" },
      { ...player("Back two", "RB", 12), slot: "RB" },
      locked,
      { ...player("Wide two", "WR", 16), slot: "WR" },
      { ...player("Tight end", "TE", 10), slot: "TE" },
      player("Flex back", "RB", 14), player("Defense", "DST", 8), player("Kicker", "K", 7),
    ];
    const result = optimizeMatchupAwareLineup(roster, { enabled: true, strategy: "SAFE", now });
    expect(result.lineup).toHaveLength(9);
    expect(result.lineup.find((item) => item.name === "Locked WR")?.slot).toBe("WR");
  });
});

describe("player comparison", () => {
  it("returns a reproducible P(A > B) when ranges exist and null without ranges", () => {
    const a = player("A", "WR", 15);
    const b = player("B", "WR", 10);
    const first = probabilityOutscores(a, b, { iterations: 2_000, seed: 123 });
    expect(first).toBe(probabilityOutscores(a, b, { iterations: 2_000, seed: 123 }));
    expect(first).toBeGreaterThan(50);
    expect(probabilityOutscores({ ...a, floor: undefined, ceiling: undefined }, b)).toBeNull();
  });
});
