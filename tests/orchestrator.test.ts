import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/providers/espn", () => ({
  fetchEspnScoreboard: vi.fn().mockRejectedValue(new Error("offline")),
  fetchEspnNews: vi.fn().mockResolvedValue([]),
  mapEspnTeamContexts: vi.fn().mockReturnValue(new Map()),
}));
vi.mock("@/lib/providers/sleeper", () => ({ fetchSleeperTrending: vi.fn().mockResolvedValue([]) }));
vi.mock("@/lib/providers/sportsdataio", () => ({
  fetchSportsDataIoProjections: vi.fn().mockResolvedValue([]),
  fetchSportsDataIoRecentUsage: vi.fn().mockResolvedValue({ players: [], defenseAllowed: [] }),
  fetchSportsDataIoInjuries: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/lib/providers/statshawk", () => ({ fetchStatsHawkContext: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/db", () => ({
  saveSnapshot: vi.fn().mockResolvedValue({ persisted: false }),
  saveExternalIngest: vi.fn().mockResolvedValue({ persisted: false }),
  getLatestExternalIngest: vi.fn().mockResolvedValue(null),
  getPlayerIdentityMap: vi.fn().mockResolvedValue(new Map()),
}));
vi.mock("@/lib/analytics", () => ({ captureServerEvent: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@/lib/core/consumers", () => ({ applyCoreProjections: vi.fn().mockImplementation(async (players) => players) }));

import { synchronize } from "@/lib/orchestrator";
import { getLatestExternalIngest, getPlayerIdentityMap } from "@/lib/db";
import { applyCoreProjections } from "@/lib/core/consumers";
import { fetchSportsDataIoProjections, fetchSportsDataIoRecentUsage } from "@/lib/providers/sportsdataio";
import { nflPeriod } from "@/lib/time";
import { leagueDataVersion } from "@/lib/data-version";

describe("sync orchestration", () => {
  beforeEach(() => { vi.clearAllMocks(); });
  it("keeps a content version stable across fetch time and provider roster order", () => {
    const base = { league: { name: "League", season: 2026, week: 4 }, roster: [{ providerId: "a", name: "A", team: "KC", position: "QB" as const, slot: "QB" }, { providerId: "b", name: "B", team: "SF", position: "QB" as const, slot: "Bench" }], freeAgents: [], source: "espn" as const, sourceTimestamp: "2026-09-30T10:00:00.000Z", fetchedAt: "2026-09-30T10:00:01.000Z" };
    const refreshed = { ...base, roster: [...base.roster].reverse(), sourceTimestamp: "2026-09-30T11:00:00.000Z", fetchedAt: "2026-09-30T11:00:01.000Z" };
    expect(leagueDataVersion(base)).toBe(leagueDataVersion(refreshed));
  });
  it("continues after a provider partial failure", async () => {
    const period = nflPeriod();
    const result = await synchronize({ league: { name: "League", season: period.season, week: period.week, scoring: { reception: 1 } }, roster: [{ providerId: "1", name: "P", team: "SF", position: "QB", slot: "QB", projection: 20 }], freeAgents: [], source: "manual", sourceTimestamp: new Date().toISOString() });
    expect(result.health).toBe("DEGRADED");
    expect(result.agents.find((a) => a.name === "Schedule")?.status).toBe("failed");
    expect(result.roster).toHaveLength(1);
  });
  it("never presents a persisted roster as current when this run did not query the league", async () => {
    const period = nflPeriod();
    vi.mocked(getLatestExternalIngest).mockResolvedValueOnce({ league: { name: "Saved League", season: period.season, week: period.week, scoring: { reception: 1 } }, roster: [{ providerId: "1", name: "Saved Player", team: "KC", position: "QB", slot: "QB", projection: 22 }], freeAgents: [], source: "flaim", sourceTimestamp: new Date().toISOString() });
    const result = await synchronize();
    expect(result.freshness).toBe("STALE");
    expect(result.leagueName).toBe("Liga no conectada");
    expect(result.roster).toEqual([]);
    expect(result.recommendations).toEqual([]);
  });
  it("keeps waiver and roster-management actions instead of truncating the action center", async () => {
    const now = new Date().toISOString();
    const period = nflPeriod();
    const kickoff = new Date(Date.now() + 5 * 86_400_000).toISOString();
    const result = await synchronize({
      league: { name: "League", season: period.season, week: period.week, scoring: { reception: 1 } },
      roster: [
        { providerId: "q1", name: "QB1", team: "KC", position: "QB", slot: "QB", projection: 22, kickoff },
        { providerId: "q2", name: "QB2", team: "SF", position: "QB", slot: "Bench", projection: 20, kickoff },
        { providerId: "w1", name: "Drop WR", team: "TEN", position: "WR", slot: "Bench", projection: 2, kickoff },
        { providerId: "r1", name: "Drop RB", team: "CAR", position: "RB", slot: "Bench", projection: 2, kickoff },
        { providerId: "t1", name: "Drop TE", team: "LV", position: "TE", slot: "Bench", projection: 2, kickoff },
      ],
      freeAgents: [
        { providerId: "w2", name: "Add WR", team: "CLE", position: "WR", slot: "FA", projection: 14, kickoff },
        { providerId: "r2", name: "Add RB", team: "HOU", position: "RB", slot: "FA", projection: 14, kickoff },
        { providerId: "t2", name: "Add TE", team: "NO", position: "TE", slot: "FA", projection: 14, kickoff },
      ], source: "manual", sourceTimestamp: now,
    });
    expect(result.recommendations.filter((item) => item.kind === "ADD")).toHaveLength(3);
    expect(result.recommendations.some((item) => item.kind === "TRADE")).toBe(true);
    expect(result.recommendations.every((item) => item.actionable === false)).toBe(true);
  });
  it("replaces removed roster players and reports the exact provider-ID diff", async () => {
    const period = nflPeriod();
    const sourceTimestamp = new Date().toISOString();
    const player = (providerId: string, name: string) => ({ providerId, name, team: "KC", position: "QB" as const, slot: "Bench" });
    vi.mocked(getLatestExternalIngest).mockResolvedValueOnce({ league: { name: "League", leagueId: "league-1", season: period.season, week: period.week }, roster: [player("a", "A"), player("b", "B"), player("c", "C")], freeAgents: [], source: "flaim", sourceTimestamp });
    const result = await synchronize({ league: { name: "League", leagueId: "league-1", season: period.season, week: period.week }, roster: [player("a", "A"), player("b", "B"), player("d", "D")], freeAgents: [], source: "flaim", sourceTimestamp });
    expect(result.roster.map((entry) => entry.name)).toEqual(["A", "B", "D"]);
    expect(result.roster.some((entry) => entry.name === "C")).toBe(false);
    expect(result.rosterChanges?.map((change) => change.kind).sort()).toEqual(["ADDED", "DROPPED"]);
  });
  it("preserves raw source points before a gated core changes player projections", async () => {
    const period = nflPeriod();
    const sourceTimestamp = new Date().toISOString();
    const kickoff = new Date(Date.now() + 86_400_000).toISOString();
    vi.mocked(applyCoreProjections).mockImplementationOnce(async (players) => players.map((player) => ({ ...player, projection: 99,
      decisionProfile: { ...player.decisionProfile!, median: 99, floor: 95, ceiling: 105 },
      coreProjection: { player_id: player.canonicalPlayerId, ...period, scenario: "base", mean: 99, sd: 1, p10: 95, p50: 99, p90: 105, prob_play: 1, confidence: 90, drivers: [], model_version: "test-fixture", scoring_hash: "test-fixture", as_of: sourceTimestamp, fetched_at: sourceTimestamp, estimated: true, method: "test fixture only", reason: null, missing: [], eligible: true, ros_mean: null, ros_sd: null, playoff_mean: null, war: null },
    })));
    const result = await synchronize({ league: { name: "League", leagueId: "l1", teamId: "t1", ...period, scoring: { reception: 0.5 } }, roster: [{ providerId: "1", name: "Player", team: "SF", position: "WR", slot: "WR", projection: 12, kickoff }], freeAgents: [], source: "espn", sourceTimestamp });
    expect(result.roster[0].projection).toBe(99);
    expect(result.sourceProjections).toContainEqual(expect.objectContaining({ source: "espn", points: 12, scoring: { reception: 0.5 }, sourceTimestamp }));
    expect(applyCoreProjections).toHaveBeenCalledTimes(1);
    expect(applyCoreProjections).toHaveBeenCalledWith(expect.any(Array), { scope: `espn:l1:t1:${period.season}`, ...period, dataAsOf: sourceTimestamp });
  });
  it("enriches usage through explicit canonical ID mapping without mixing PPR points", async () => {
    const period = nflPeriod();
    vi.mocked(getPlayerIdentityMap).mockResolvedValueOnce(new Map([["espn:1", "canonical:player"], ["sportsdataio:7", "canonical:player"]]));
    vi.mocked(fetchSportsDataIoProjections).mockResolvedValueOnce([{ providerId: "7", name: "Provider Name", team: "SF", position: "WR", points: 40, scoringLabel: "PPR", fetchedAt: new Date().toISOString() }]);
    vi.mocked(fetchSportsDataIoRecentUsage).mockResolvedValueOnce({ players: [{ providerId: "7", name: "Provider Name", team: "SF", position: "WR", games: [{ week: period.week - 1, fantasyPointsPpr: 50, snapShare: 0.8, routes: 30 }] }], defenseAllowed: [{ team: "SF", position: "WR", pointsPerGame: 80, games: 3 }] });
    const result = await synchronize({ league: { name: "League", ...period, scoring: { reception: 0.5 } }, roster: [{ providerId: "1", name: "League Name", team: "SF", position: "WR", slot: "WR", projection: 12 }], freeAgents: [], source: "espn", sourceTimestamp: new Date().toISOString() });
    expect(result.roster[0]).toMatchObject({ canonicalPlayerId: "canonical:player", projection: 12, recentGames: [{ week: period.week - 1, snapShare: 0.8, routes: 30 }] });
    expect(result.roster[0].recentGames?.[0].fantasyPointsPpr).toBeUndefined();
    expect(result.roster[0].opponentPointsAllowedL3).toBeUndefined();
    expect(result.sourceProjections).toContainEqual(expect.objectContaining({ canonicalPlayerId: "canonical:player", source: "sportsdataio", points: 40, scoring: null, scoringLabel: "PPR" }));
    expect(result.sourceProjections?.find((projection) => projection.source === "sportsdataio")?.sourceTimestamp).toBeUndefined();
  });
  it("does not join SportsDataIO by matching names, numerical IDs or DST team", async () => {
    const period = nflPeriod();
    vi.mocked(fetchSportsDataIoProjections).mockResolvedValueOnce([{ providerId: "1", name: "Same Name", team: "SF", position: "WR", points: 90, injury: "OUT" }, { providerId: "defense-id", name: "SF D/ST", team: "SF", position: "DST", points: 80, injury: "OUT" }]);
    vi.mocked(fetchSportsDataIoRecentUsage).mockResolvedValueOnce({ players: [{ providerId: "1", name: "Same Name", team: "SF", position: "WR", games: [{ week: period.week - 1, snapShare: 0.8 }] }], defenseAllowed: [] });
    const result = await synchronize({ league: { name: "League", ...period }, roster: [{ providerId: "1", name: "Same Name", team: "SF", position: "WR", slot: "WR", projection: 12 }, { providerId: "different-defense", name: "SF D/ST", team: "SF", position: "DST", slot: "DST", projection: -4 }], freeAgents: [], source: "espn", sourceTimestamp: new Date().toISOString() });
    expect(result.roster[0].projection).toBe(12);
    expect(result.roster[0].injury).toBeUndefined();
    expect(result.roster[0].recentGames).toBeUndefined();
    expect(result.roster[1].projection).toBe(-4);
    expect(result.roster[1].injury).toBeUndefined();
    expect(result.sourceProjections?.every((projection) => projection.source === "espn")).toBe(true);
  });
  it("keeps unknown starter points undefined and the lineup total null", async () => {
    const period = nflPeriod();
    const kickoff = new Date(Date.now() + 86_400_000).toISOString();
    const slots = ["QB", "RB", "RB", "WR", "WR", "TE", "RB/WR", "DST", "K"];
    const roster = slots.map((slot, index) => ({ providerId: String(index), name: `Player ${index}`, team: "SF", position: (slot === "RB/WR" ? "WR" : slot) as "QB" | "RB" | "WR" | "TE" | "DST" | "K", slot, projection: index === 0 ? undefined : 10, kickoff }));
    const result = await synchronize({ league: { name: "League", ...period }, roster, freeAgents: [], source: "manual", sourceTimestamp: new Date().toISOString() });
    expect(result.roster[0].projection).toBeUndefined();
    expect(result.roster[0].decisionProfile).toMatchObject({ projectionAvailable: false, confidence: 0 });
    expect(result.projectedScore).toBeNull();
    expect(result.winProbability).toBeNull();
  });
  it("uses pending IDs, allowing distinct players with the same display name", async () => {
    const period = nflPeriod();
    const kickoff = new Date(Date.now() + 86_400_000).toISOString();
    const result = await synchronize({ league: { name: "League", ...period }, roster: [{ providerId: "drop", name: "Drop", team: "SF", position: "WR", slot: "Bench", projection: 2, kickoff }], freeAgents: [{ providerId: "pending", name: "Same Name", team: "SF", position: "WR", slot: "FA", projection: 14, kickoff }, { providerId: "other", name: "Same Name", team: "SF", position: "WR", slot: "FA", projection: 13, kickoff }], pendingMoves: [{ kind: "waiver", status: "pending", add: "Same Name", addProviderId: "pending" }], source: "manual", sourceTimestamp: new Date().toISOString() });
    expect(result.recommendations.filter((move) => move.kind === "ADD").map((move) => move.targetPlayerId)).toEqual(["manual:other"]);
  });
  it("blocks waiver recommendations when a legacy pending move lacks provider IDs", async () => {
    const period = nflPeriod();
    const kickoff = new Date(Date.now() + 86_400_000).toISOString();
    const result = await synchronize({ league: { name: "League", ...period }, roster: [{ providerId: "drop", name: "Drop", team: "SF", position: "WR", slot: "Bench", projection: 2, kickoff }], freeAgents: [{ providerId: "add", name: "Add", team: "SF", position: "WR", slot: "FA", projection: 14, kickoff }], pendingMoves: [{ kind: "waiver", status: "pending", add: "Unresolved name" }], source: "manual", sourceTimestamp: new Date().toISOString() });
    expect(result.recommendations.filter((move) => move.kind === "ADD")).toEqual([]);
    expect(result.warnings.some((warning) => warning.includes("addProviderId"))).toBe(true);
  });
  it("calls the core once for all roster, market and rival players, preserving ownership slots", async () => {
    const period = nflPeriod();
    const player = (providerId: string, slot: string) => ({ providerId, name: providerId, team: "SF", position: "WR" as const, slot, projection: 12 });
    const result = await synchronize({ league: { name: "League", ...period }, roster: [player("own", "WR")], freeAgents: [player("market", "FA")], opponent: { teamId: "2", name: "Other", roster: [player("rival", "WR")] }, tradePartners: [{ teamId: "2", name: "Other", roster: [player("rival", "Bench")] }], source: "manual", sourceTimestamp: new Date().toISOString() });
    expect(applyCoreProjections).toHaveBeenCalledTimes(1);
    expect(vi.mocked(applyCoreProjections).mock.calls[0][0].map((item) => item.canonicalPlayerId).sort()).toEqual(["manual:market", "manual:own", "manual:rival"]);
    expect(result.roster[0].slot).toBe("WR");
  });
  it("preserves separate source views when the core returns players unchanged", async () => {
    const period = nflPeriod();
    const kickoff = new Date(Date.now() + 86_400_000).toISOString();
    const player = { providerId: "same-player", name: "Primary View", team: "SF", position: "WR" as const, slot: "WR", projection: 12, kickoff };
    const result = await synchronize({ league: { name: "League", ...period }, roster: [player], freeAgents: [], tradePartners: [{ teamId: "2", name: "Other", roster: [{ ...player, name: "Secondary View", projection: 90, slot: "Bench" }] }], source: "manual", sourceTimestamp: new Date().toISOString() });
    expect(result.roster[0]).toMatchObject({ name: "Primary View", projection: 12, slot: "WR" });
    expect(result.roster[0].coreProjection).toBeUndefined();
    expect(result.sourceProjections?.[0]).toMatchObject({ name: "Primary View", points: 12 });
  });
});
