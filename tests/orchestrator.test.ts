import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/providers/espn", () => ({
  fetchEspnScoreboard: vi.fn().mockRejectedValue(new Error("offline")),
  fetchEspnNews: vi.fn().mockResolvedValue([]),
  mapEspnTeamContexts: vi.fn().mockReturnValue(new Map()),
}));
vi.mock("@/lib/providers/sleeper", () => ({ fetchSleeperTrending: vi.fn().mockResolvedValue([]) }));
vi.mock("@/lib/providers/sportsdataio", () => ({ fetchSportsDataIoProjections: vi.fn().mockResolvedValue([]) }));
vi.mock("@/lib/providers/statshawk", () => ({ fetchStatsHawkContext: vi.fn().mockResolvedValue(null) }));
vi.mock("@/lib/db", () => ({
  saveSnapshot: vi.fn().mockResolvedValue({ persisted: false }),
  saveExternalIngest: vi.fn().mockResolvedValue({ persisted: false }),
  getLatestExternalIngest: vi.fn().mockResolvedValue(null),
}));
vi.mock("@/lib/analytics", () => ({ captureServerEvent: vi.fn().mockResolvedValue(undefined) }));

import { synchronize } from "@/lib/orchestrator";
import { getLatestExternalIngest } from "@/lib/db";
import { nflPeriod } from "@/lib/time";
import { leagueDataVersion } from "@/lib/data-version";

describe("sync orchestration", () => {
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
});
