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

describe("sync orchestration", () => {
  it("continues after a provider partial failure", async () => {
    const result = await synchronize({ league: { name: "League", season: 2026, week: 2, scoring: { reception: 1 } }, roster: [{ providerId: "1", name: "P", team: "SF", position: "QB", slot: "QB", projection: 20 }], freeAgents: [], source: "manual", sourceTimestamp: new Date().toISOString() });
    expect(result.health).toBe("DEGRADED");
    expect(result.agents.find((a) => a.name === "Schedule")?.status).toBe("failed");
    expect(result.roster).toHaveLength(1);
  });
  it("reuses the latest persisted league ingest for scheduled refreshes", async () => {
    vi.mocked(getLatestExternalIngest).mockResolvedValueOnce({ league: { name: "Saved League", season: 2026, week: 3, scoring: { reception: 1 } }, roster: [{ providerId: "1", name: "Saved Player", team: "KC", position: "QB", slot: "QB", projection: 22 }], freeAgents: [], source: "flaim", sourceTimestamp: new Date().toISOString() });
    const result = await synchronize();
    expect(result.leagueName).toBe("Saved League");
    expect(result.roster[0]?.name).toBe("Saved Player");
  });
  it("keeps waiver and roster-management actions instead of truncating the action center", async () => {
    const now = new Date().toISOString();
    const result = await synchronize({
      league: { name: "League", season: 2026, week: 3, scoring: { reception: 1 } },
      roster: [
        { providerId: "q1", name: "QB1", team: "KC", position: "QB", slot: "QB", projection: 22 },
        { providerId: "q2", name: "QB2", team: "SF", position: "QB", slot: "Bench", projection: 20 },
        { providerId: "w1", name: "Drop WR", team: "TEN", position: "WR", slot: "Bench", projection: 2 },
        { providerId: "r1", name: "Drop RB", team: "CAR", position: "RB", slot: "Bench", projection: 2 },
        { providerId: "t1", name: "Drop TE", team: "LV", position: "TE", slot: "Bench", projection: 2 },
      ],
      freeAgents: [
        { providerId: "w2", name: "Add WR", team: "CLE", position: "WR", slot: "FA", projection: 14 },
        { providerId: "r2", name: "Add RB", team: "HOU", position: "RB", slot: "FA", projection: 14 },
        { providerId: "t2", name: "Add TE", team: "NO", position: "TE", slot: "FA", projection: 14 },
      ], source: "manual", sourceTimestamp: now,
    });
    expect(result.recommendations.filter((item) => item.kind === "ADD")).toHaveLength(3);
    expect(result.recommendations.some((item) => item.kind === "TRADE")).toBe(true);
  });
});
