import { describe, expect, it } from "vitest";
import { buildFlaimPayload, pickFootballEspnLeague } from "@/lib/flaim/normalize";

describe("Flaim league adapter", () => {
  it("uses the configured ESPN football league and maps a fresh snapshot", () => {
    const league = pickFootballEspnLeague({
      allLeagues: [
        { leagueId: "fixture-1", leagueName: "Fixture League", platform: "espn", sport: "football", seasonYear: 2026, teamId: "1" },
      ],
    });
    const payload = buildFlaimPayload({
      league,
      leagueInfo: { leagueId: "fixture-1", name: "Fixture League", season: 2026, currentWeek: 4, numTeams: 10, scoringType: "PPR" },
      roster: { teamId: "1", roster: [{ playerId: "player-1", name: "Fixture Player", position: "QB", proTeam: "Buffalo Bills", lineupSlotId: 0 }], record: { wins: 2, losses: 1 } },
      freeAgents: {
        ownershipScope: "platform_global",
        capabilities: { rosteredRate: true, startedRate: true, acquisitionState: true },
        freeAgents: [{ id: "player-2", name: "Available Player", position: "WR", team: "NYJ", percentOwned: 5, percentStarted: 1, acquisitionState: "waivers", waiverClearsAt: "2026-10-02T12:00:00.000Z" }],
      },
      matchups: { matchups: [{ home: { teamId: "1", name: "My Team", score: 17 }, away: { teamId: "2", name: "Opponent", players: [{ playerId: "player-3", name: "Opponent Player", position: "RB", team: "BUF", lineupSlot: "RB" }] } }] },
      transactions: { transactions: [{ status: "PENDING", players_added: [{ name: "Available Player" }], players_dropped: [{ name: "Fixture Player" }] }] },
      fetchedAt: "2026-10-01T12:00:00.000Z",
    });

    expect(payload.source).toBe("flaim");
    expect(payload.league).toMatchObject({ leagueId: "fixture-1", teamId: "1", season: 2026, week: 4, teamCount: 10, scoring: { reception: 1 } });
    expect(payload.roster[0]).toMatchObject({ providerId: "player-1", team: "BUF", position: "QB", slot: "QB" });
    expect(payload.freeAgents[0]).toMatchObject({ providerId: "player-2", team: "NYJ", position: "WR", slot: "FA", percentOwned: 5, percentStarted: 1, acquisitionState: "waivers", marketScope: "platform_global" });
    expect(payload.opponent).toMatchObject({ teamId: "2", name: "Opponent", roster: [{ providerId: "player-3", slot: "RB" }] });
    expect(payload.pendingMoves).toEqual([{ kind: "waiver", status: "pending", add: "Available Player", drop: "Fixture Player" }]);
    expect(payload.currentScore).toBe(17);
  });

  it("does not guess an ESPN league when the account has none", () => {
    expect(() => pickFootballEspnLeague({ allLeagues: [{ leagueId: "fixture", platform: "sleeper", sport: "football" }] }))
      .toThrow("No encontré una liga de ESPN Fantasy Football");
  });

  it("does not invent player identity or position when Flaim omits them", () => {
    expect(() => buildFlaimPayload({
      league: { leagueId: "fixture", name: "Fixture League", platform: "espn", sport: "football", seasonYear: 2026, teamId: "1" },
      leagueInfo: { season: 2026, currentWeek: 4 },
      roster: { roster: [{ name: "Unknown Position Player" }] },
      freeAgents: { freeAgents: [] },
    })).toThrow("Flaim no devolvió jugadores identificables");
  });

  it("does not turn a generic ESPN scoring mode into standard reception scoring", () => {
    const payload = buildFlaimPayload({
      league: { leagueId: "fixture", name: "Fixture League", platform: "espn", sport: "football", seasonYear: 2026, teamId: "1" },
      leagueInfo: { season: 2026, currentMatchupPeriod: 4, scoringSettings: { type: "H2H_POINTS" } },
      roster: { roster: [{ playerId: "player-1", name: "Fixture Player", position: "QB", proTeam: "BUF" }] },
      freeAgents: { freeAgents: [] },
    });
    expect(payload.league.scoring).toBeUndefined();
  });
});
