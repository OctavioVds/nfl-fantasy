import { describe, expect, it } from "vitest";
import { aggregateProjections, canonicalPlayerId, optimizeLineup, pprPoints, rosterManagementRecommendations, simulateWin, tradeRecommendations, waiverRecommendations } from "@/lib/engine";
import { isPlayerLocked, isStale, nflPeriod } from "@/lib/time";
import type { PlayerProjection, RosterPlayer } from "@/lib/types";
import { mapEspnTeamContexts } from "@/lib/providers/espn";

describe("scoring and projections", () => {
  it("calculates full PPR scoring", () => expect(pprPoints({ rushYards: 50, receptions: 5, recYards: 60, rushTd: 1 })).toBe(22));
  it("deduplicates projection sources and uses a median", () => {
    const base = { canonicalPlayerId: "a", name: "A", team: "SF", position: "RB", sourceTimestamp: "2026-09-20T00:00:00Z" };
    const inputs: PlayerProjection[] = [{ ...base, source: "one", points: 10 }, { ...base, source: "one", points: 30 }, { ...base, source: "two", points: 20 }];
    expect(aggregateProjections(inputs)).toMatchObject({ median: 25, sources: 2 });
  });
  it("simulates deterministically", () => expect(simulateWin(120, 120, 1000, 7)).toBeGreaterThanOrEqual(45));
});

describe("waiver decisions", () => {
  const p = (name: string, position: RosterPlayer["position"], projection: number, slot = "Bench", futureProjection = projection): RosterPlayer => ({ canonicalPlayerId: canonicalPlayerId(name), name, team: "X", position, projection, futureProjection, slot });
  it("only recommends confirmed available players with positive net value", () => {
    const moves = waiverRecommendations([p("Drop", "WR", 7), p("Hold", "RB", 14)], [p("Add", "WR", 13, "FA", 14)]);
    expect(moves[0]).toMatchObject({ kind: "ADD", target: "Add", alternative: "Drop", actionable: true });
  });
  it("does not recommend a worse free agent", () => expect(waiverRecommendations([p("Hold", "WR", 12)], [p("Worse", "WR", 5, "FA")])).toEqual([]));
  it("never drops a starter", () => {
    const moves = waiverRecommendations([p("Starter", "WR", 1, "WR"), p("Bench", "RB", 5)], [p("Upgrade", "WR", 20, "FA")]);
    expect(moves[0]?.alternative).toBe("Bench");
  });
  it("does not add a third quarterback in a one-QB roster", () => {
    const roster = [p("QB1", "QB", 20, "QB"), p("QB2", "QB", 18), p("Bench", "WR", 5)];
    expect(waiverRecommendations(roster, [p("QB3", "QB", 30, "FA")])).toEqual([]);
  });
  it("streams defense by replacing the existing unlocked defense", () => {
    const roster = [p("Old DST", "DST", 4, "DST"), p("Bench", "WR", 2)];
    const moves = waiverRecommendations(roster, [p("New DST", "DST", 10, "FA")]);
    expect(moves[0]?.alternative).toBe("Old DST");
  });
  it("surfaces upgrades across positions before same-position alternatives", () => {
    const roster = [p("TE Drop", "TE", 3), p("WR Drop", "WR", 3), p("Other", "RB", 3)];
    const moves = waiverRecommendations(roster, [p("TE Best", "TE", 15, "FA"), p("TE Second", "TE", 14, "FA"), p("WR Best", "WR", 10, "FA")]);
    expect(moves.slice(0, 2).map((move) => move.target)).toEqual(["TE Best", "WR Best"]);
  });
  it("keeps fallback claims after the best option at each position", () => {
    const roster = [p("TE Drop", "TE", 2), p("WR Drop", "WR", 2), p("RB Drop", "RB", 2)];
    const moves = waiverRecommendations(roster, [p("WR One", "WR", 15, "FA"), p("WR Two", "WR", 14, "FA"), p("RB One", "RB", 13, "FA"), p("TE One", "TE", 12, "FA")]);
    expect(moves.map((move) => move.target)).toEqual(["WR One", "RB One", "TE One", "WR Two"]);
  });
});

describe("lineup legality", () => {
  const p = (name: string, position: RosterPlayer["position"], projection: number, slot = "Bench"): RosterPlayer => ({ canonicalPlayerId: canonicalPlayerId(name), name, team: "X", position, projection, slot });
  it("fills QB, two RB, two WR, TE, FLEX, DST and K", () => {
    const roster = [p("q", "QB", 20), p("r1", "RB", 18), p("r2", "RB", 17), p("r3", "RB", 16), p("w1", "WR", 15), p("w2", "WR", 14), p("t", "TE", 10), p("d", "DST", 8), p("k", "K", 7)];
    const result = optimizeLineup(roster);
    expect(result).toHaveLength(9);
    expect(result.filter((x) => x.position === "RB")).toHaveLength(3);
  });
  it("does not displace locked starters", () => {
    const locked = { ...p("locked", "WR", 1, "WR"), locked: true };
    expect(optimizeLineup([locked, p("better", "WR", 20), p("w2", "WR", 19), p("q", "QB", 1), p("r1", "RB", 1), p("r2", "RB", 1), p("t", "TE", 1), p("d", "DST", 1), p("k", "K", 1)]).some((x) => x.name === "locked")).toBe(true);
  });
  it("returns the recommended slot instead of the player's old bench slot", () => {
    const result = optimizeLineup([p("q", "QB", 20), p("r1", "RB", 18), p("r2", "RB", 17), p("r3", "RB", 16), p("w1", "WR", 15), p("w2", "WR", 14), p("t", "TE", 10), p("d", "DST", 8), p("k", "K", 7)]);
    expect(result.find((x) => x.name === "q")?.slot).toBe("QB");
    expect(result.find((x) => x.name === "r3")?.slot).toBe("RB/WR");
  });
  it("flags a valuable second quarterback for trade before a cut", () => {
    const actions = rosterManagementRecommendations([p("QB1", "QB", 22, "QB"), p("QB2", "QB", 20)]);
    expect(actions[0]).toMatchObject({ kind: "TRADE", target: "QB2", confidence: "HIGH" });
  });
  it("builds concrete trade offers against rival rosters", () => {
    const roster = [p("QB1", "QB", 22, "QB"), p("QB2", "QB", 18), p("RB1", "RB", 15, "RB"), p("RB2", "RB", 14, "RB"), p("WR1", "WR", 14, "WR"), p("WR2", "WR", 13, "WR"), p("TE1", "TE", 10, "TE"), p("DST", "DST", 8, "DST"), p("K", "K", 7, "K")];
    const partnerRoster = [p("Their QB", "QB", 8, "QB"), p("Target RB", "RB", 17), p("Their RB", "RB", 22, "RB"), p("Their RB2", "RB", 21, "RB"), p("Their WR1", "WR", 20, "WR"), p("Their WR2", "WR", 19, "WR"), p("Their WR3", "WR", 18), p("Their TE", "TE", 9, "TE"), p("Their DST", "DST", 7, "DST"), p("Their K", "K", 6, "K")];
    const trades = tradeRecommendations(roster, [{ teamId: "2", name: "Rival", roster: partnerRoster }]);
    expect(trades.some((move) => move.kind === "TRADE" && move.partner === "Rival")).toBe(true);
  });
});

describe("time, identity and freshness", () => {
  it("detects 2026 week 2 before Monday night finishes", () => expect(nflPeriod(new Date("2026-09-20T18:00:00Z"))).toEqual({ season: 2026, week: 2 }));
  it("rolls fantasy recommendations to week 3 on Tuesday", () => expect(nflPeriod(new Date("2026-09-22T14:00:00Z"))).toEqual({ season: 2026, week: 3 }));
  it("uses the real instant across timezones for locks", () => expect(isPlayerLocked("2026-09-20T12:00:00-05:00", new Date("2026-09-20T17:00:01Z"))).toBe(true));
  it("marks stale timestamps", () => expect(isStale("2026-09-20T10:00:00Z", 60_000, new Date("2026-09-20T10:02:00Z"))).toBe(true));
  it("canonicalizes accents and punctuation", () => expect(canonicalPlayerId("Eddy Piñeiro", "SF")).toBe("eddy-pineiro-sf"));
});

describe("ESPN schedule context", () => {
  it("maps opponent, venue, home/away and weather by team", () => {
    const result = mapEspnTeamContexts([{ date: "2026-09-20T17:00:00Z", competitions: [{ venue: { fullName: "Example Field" }, weather: { displayValue: "Cloudy, 68°" }, competitors: [{ homeAway: "home", team: { abbreviation: "SF" } }, { homeAway: "away", team: { abbreviation: "MIA" } }] }] }]);
    expect(result.get("SF")).toMatchObject({ opponent: "MIA", homeAway: "home", venue: "Example Field", weather: "Cloudy, 68°" });
    expect(result.get("MIA")).toMatchObject({ opponent: "SF", homeAway: "away" });
  });
});
