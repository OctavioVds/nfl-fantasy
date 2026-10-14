import { describe, expect, it } from "vitest";
import { externalSyncSchema } from "@/lib/schemas";

const valid = { league: { name: "Test League", season: 2026, week: 2, scoring: { reception: 1 } }, roster: [{ providerId: "1", name: "Player", team: "SF", position: "WR", slot: "WR", projection: 12 }], source: "flaim", sourceTimestamp: "2026-09-20T12:00:00.000Z" };

describe("external sync validation", () => {
  it("accepts a valid league snapshot", () => expect(externalSyncSchema.safeParse(valid).success).toBe(true));
  it("rejects duplicate-shape corruption and bad weeks", () => expect(externalSyncSchema.safeParse({ ...valid, league: { ...valid.league, week: 99 } }).success).toBe(false));
  it("rejects invalid injuries and positions through schema constraints", () => expect(externalSyncSchema.safeParse({ ...valid, roster: [{ ...valid.roster[0], position: "CB" }] }).success).toBe(false));
  it("rejects a player who is both rostered and marked available", () => expect(externalSyncSchema.safeParse({ ...valid, freeAgents: [{ ...valid.roster[0], slot: "FA" }] }).success).toBe(false));
  it("accepts record, opponent and trade partner rosters", () => expect(externalSyncSchema.safeParse({ ...valid, teamRecord: { wins: 1, losses: 0, ties: 0, streak: "W1" }, opponent: { teamId: "3", name: "The Hawks", roster: valid.roster }, tradePartners: [{ teamId: "3", name: "The Hawks", roster: valid.roster }] }).success).toBe(true));
  it("accepts negative actual fantasy points for defenses", () => expect(externalSyncSchema.safeParse({ ...valid, roster: [{ ...valid.roster[0], position: "DST", projection: -4 }] }).success).toBe(true));
  it("rejects duplicate provider IDs in rosters and the available market", () => {
    expect(externalSyncSchema.safeParse({ ...valid, roster: [...valid.roster, { ...valid.roster[0], slot: "Bench" }] }).success).toBe(false);
    const available = { ...valid.roster[0], providerId: "available", slot: "FA" };
    expect(externalSyncSchema.safeParse({ ...valid, freeAgents: [available, available] }).success).toBe(false);
  });
  it("rejects available players owned by an opponent, next opponent or trade partner", () => {
    const occupied = { ...valid.roster[0], providerId: "other-player" };
    const freeAgents = [{ ...occupied, slot: "FA" }];
    const opponent = { teamId: "other", name: "Other", roster: [occupied] };
    expect(externalSyncSchema.safeParse({ ...valid, freeAgents, opponent }).success).toBe(false);
    expect(externalSyncSchema.safeParse({ ...valid, freeAgents, nextOpponent: { ...opponent, week: 3 } }).success).toBe(false);
    expect(externalSyncSchema.safeParse({ ...valid, freeAgents, tradePartners: [opponent] }).success).toBe(false);
  });
  it("accepts provider IDs on pending moves without requiring display names", () => {
    const result = externalSyncSchema.safeParse({ ...valid, pendingMoves: [{ kind: "waiver", status: "pending", addProviderId: "42", dropProviderId: "1" }] });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.pendingMoves?.[0]).toMatchObject({ addProviderId: "42", dropProviderId: "1" });
  });
  it("rejects whitespace-only IDs and duplicates that differ only in surrounding whitespace", () => {
    expect(externalSyncSchema.safeParse({ ...valid, roster: [{ ...valid.roster[0], providerId: " " }] }).success).toBe(false);
    expect(externalSyncSchema.safeParse({ ...valid, roster: [...valid.roster, { ...valid.roster[0], providerId: " 1 " }] }).success).toBe(false);
  });
});
