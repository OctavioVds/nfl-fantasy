import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchSportsDataIoProjections, mapSportsDataRecentUsage } from "@/lib/providers/sportsdataio";

vi.mock("@/lib/env", () => ({ serverEnv: () => ({ SPORTSDATAIO_API_KEY: "test-only-key" }) }));

describe("SportsDataIO identity and provenance", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("requires athlete/defense IDs and preserves raw scoring and verified timestamps", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([
        { Name: "Missing ID", Team: "SF", Position: "WR", FantasyPointsPPR: 90 },
        { PlayerID: 1, Name: "Example", Team: "SF", Position: "WR", FantasyPointsPPR: 12, Updated: "2026-10-14T14:00:00Z", GameDate: "2026-10-18T17:00:00Z" },
        { PlayerID: 2, Name: "Local time", Team: "SF", Position: "WR", FantasyPointsYahoo: 8, Updated: "2026-10-14T10:00:00", GameDate: "2026-10-18T13:00:00" },
      ])))
      .mockResolvedValueOnce(new Response(JSON.stringify([
        { Team: "SF", FantasyPoints: 80 },
        { FantasyDefenseID: 5, Team: "SEA", FantasyPoints: -4 },
      ])));
    vi.stubGlobal("fetch", fetchMock);
    const result = await fetchSportsDataIoProjections(2026, 6);
    expect(result.map((player) => player.providerId)).toEqual(["1", "2", "5"]);
    expect(result[0]).toMatchObject({ scoringLabel: "PPR", sourceTimestamp: "2026-10-14T14:00:00.000Z", kickoff: "2026-10-18T17:00:00.000Z" });
    expect(result[0].fetchedAt).toBeTruthy();
    expect(result[1]).toMatchObject({ scoringLabel: "Yahoo" });
    expect(result[1].sourceTimestamp).toBeUndefined();
    expect(result[1].kickoff).toBeUndefined();
    expect(result[2]).toMatchObject({ position: "DST", points: -4, scoringLabel: "SportsDataIO DST" });
  });

  it("groups same-name players by ID and never fabricates IDs from names", () => {
    const result = mapSportsDataRecentUsage([
      { PlayerID: 1, Name: "Same Name", Team: "SF", Position: "WR", Week: 5, ReceivingTargets: 8 },
      { PlayerID: 2, Name: "Same Name", Team: "SF", Position: "WR", Week: 5, ReceivingTargets: 12 },
      { Name: "No ID", Team: "SF", Position: "WR", Week: 5, ReceivingTargets: 2 },
    ]);
    expect(result.map((player) => player.providerId)).toEqual(["1", "2"]);
    expect(result[0].games).toHaveLength(1);
    expect(result[1].games).toHaveLength(1);
  });
});
