import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/providers/espn", () => ({ fetchEspnScoreboard: vi.fn().mockRejectedValue(new Error("offline")) }));
vi.mock("@/lib/providers/sleeper", () => ({ fetchSleeperTrending: vi.fn().mockResolvedValue([]) }));
vi.mock("@/lib/providers/sportsdataio", () => ({ fetchSportsDataIoProjections: vi.fn().mockResolvedValue([]) }));
vi.mock("@/lib/db", () => ({ saveSnapshot: vi.fn().mockResolvedValue({ persisted: false }) }));
vi.mock("@/lib/analytics", () => ({ captureServerEvent: vi.fn().mockResolvedValue(undefined) }));

import { synchronize } from "@/lib/orchestrator";

describe("sync orchestration", () => {
  it("continues after a provider partial failure", async () => {
    const result = await synchronize({ league: { name: "League", season: 2026, week: 2, scoring: { reception: 1 } }, roster: [{ providerId: "1", name: "P", team: "SF", position: "QB", slot: "QB", projection: 20 }], freeAgents: [], source: "manual", sourceTimestamp: new Date().toISOString() });
    expect(result.health).toBe("DEGRADED");
    expect(result.agents.find((a) => a.name === "Schedule")?.status).toBe("failed");
    expect(result.roster).toHaveLength(1);
  });
});
