import { describe, expect, it } from "vitest";
import { externalSyncSchema } from "@/lib/schemas";

const valid = { league: { name: "FANTASY VALDES", season: 2026, week: 2, scoring: { reception: 1 } }, roster: [{ providerId: "1", name: "Player", team: "SF", position: "WR", slot: "WR", projection: 12 }], source: "flaim", sourceTimestamp: "2026-09-20T12:00:00.000Z" };

describe("external sync validation", () => {
  it("accepts a valid league snapshot", () => expect(externalSyncSchema.safeParse(valid).success).toBe(true));
  it("rejects duplicate-shape corruption and bad weeks", () => expect(externalSyncSchema.safeParse({ ...valid, league: { ...valid.league, week: 99 } }).success).toBe(false));
  it("rejects invalid injuries and positions through schema constraints", () => expect(externalSyncSchema.safeParse({ ...valid, roster: [{ ...valid.roster[0], position: "CB" }] }).success).toBe(false));
  it("accepts record, opponent and trade partner rosters", () => expect(externalSyncSchema.safeParse({ ...valid, teamRecord: { wins: 1, losses: 0, ties: 0, streak: "W1" }, opponent: { teamId: "3", name: "The Hawks", roster: valid.roster }, tradePartners: [{ teamId: "3", name: "The Hawks", roster: valid.roster }] }).success).toBe(true));
});
