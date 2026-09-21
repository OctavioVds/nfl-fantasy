import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/providers/espn", () => ({
  fetchEspnScoreboard: vi.fn().mockRejectedValue(new Error("offline")),
  mapEspnTeamContexts: vi.fn().mockReturnValue(new Map()),
}));
vi.mock("@/lib/providers/sleeper", () => ({ fetchSleeperTrending: vi.fn().mockResolvedValue([]) }));
vi.mock("@/lib/providers/sportsdataio", () => ({ fetchSportsDataIoProjections: vi.fn().mockResolvedValue([]) }));
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
});
