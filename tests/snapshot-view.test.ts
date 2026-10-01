import { describe, expect, it } from "vitest";
import { fallbackSnapshot } from "@/lib/fallback-data";
import { snapshotForDisplay } from "@/lib/snapshot-view";
import { nflPeriod } from "@/lib/time";

describe("private snapshot display guard", () => {
  it("hides roster and actions for a stale stored snapshot", () => {
    const snapshot = fallbackSnapshot();
    const period = nflPeriod(new Date("2026-09-30T18:00:00Z"));
    snapshot.season = period.season;
    snapshot.week = period.week;
    snapshot.freshness = "FRESH";
    snapshot.health = "HEALTHY";
    snapshot.leagueName = "Private League";
    snapshot.roster = [{ canonicalPlayerId: "espn:1", name: "Private Player", team: "KC", position: "QB", slot: "QB" }];
    snapshot.recommendations = [{ id: "a", kind: "HOLD", headline: "Private action", confidence: "LOW", confidenceScore: 1, risk: "", why: [], actionable: true }];
    snapshot.dataUpdatedAt = "2026-09-20T10:00:00.000Z";

    const display = snapshotForDisplay(snapshot, new Date("2026-09-30T18:00:00Z"));
    expect(display.freshness).toBe("STALE");
    expect(display.health).toBe("DEGRADED");
    expect(display.leagueName).toBe("Liga no conectada");
    expect(display.roster).toEqual([]);
    expect(display.recommendations).toEqual([]);
    expect(display.dataUpdatedAt).toBe(snapshot.dataUpdatedAt);
  });

  it("keeps a current league snapshot visible when only optional providers are degraded", () => {
    const snapshot = fallbackSnapshot();
    const now = new Date("2026-09-30T18:00:00Z");
    const period = nflPeriod(now);
    snapshot.season = period.season;
    snapshot.week = period.week;
    snapshot.freshness = "DEGRADED";
    snapshot.dataUpdatedAt = now.toISOString();
    snapshot.roster = [{ canonicalPlayerId: "espn:1", name: "Current Player", team: "KC", position: "QB", slot: "QB" }];

    const display = snapshotForDisplay(snapshot, now);
    expect(display.freshness).toBe("DEGRADED");
    expect(display.roster[0]?.name).toBe("Current Player");
  });
});
