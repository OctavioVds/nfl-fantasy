import { describe, expect, it } from "vitest";
import { aggregateProjections, canonicalPlayerId, optimizeLineup, pprPoints, simulateWin, waiverRecommendations } from "@/lib/engine";
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
});

describe("time, identity and freshness", () => {
  it("detects 2026 week 2 before Monday night finishes", () => expect(nflPeriod(new Date("2026-09-20T18:00:00Z"))).toEqual({ season: 2026, week: 2 }));
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
