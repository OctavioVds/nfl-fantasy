import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ sql: vi.fn(), databaseUrl: "postgresql://test.invalid/example" }));
vi.mock("@neondatabase/serverless", () => ({ neon: vi.fn(() => state.sql) }));
vi.mock("@/lib/env", () => ({ serverEnv: () => ({ DATABASE_URL: state.databaseUrl }) }));

import { getPlayerIdentityMap, saveSnapshot } from "@/lib/db";
import { fallbackSnapshot } from "@/lib/fallback-data";

describe("source baseline persistence", () => {
  beforeEach(() => state.sql.mockReset().mockResolvedValue([]));

  it("persists raw provider values and scoring separately from an adjusted median", async () => {
    const snapshot = fallbackSnapshot();
    snapshot.roster = [{ canonicalPlayerId: "canonical:one", name: "Example", team: "SF", position: "WR", slot: "WR", projection: 99 }];
    snapshot.sourceProjections = [
      { canonicalPlayerId: "canonical:one", providerPlayerId: "1", name: "Example", team: "SF", position: "WR", source: "espn", points: 12, scoring: { reception: 0.5 }, scoringLabel: "Half PPR", sourceTimestamp: "2026-10-14T14:00:00Z", fetchedAt: "2026-10-14T14:01:00Z" },
      { canonicalPlayerId: "canonical:one", providerPlayerId: "7", name: "Example", team: "SF", position: "WR", source: "sportsdataio", points: 40, scoring: null, scoringLabel: "PPR", fetchedAt: "2026-10-14T14:02:00Z" },
    ];
    await saveSnapshot(snapshot);
    const writes = state.sql.mock.calls.filter(([strings]) => strings.join("").includes("insert into projections_by_source"));
    expect(writes).toHaveLength(1);
    const rows = JSON.parse(writes[0].find((value: unknown) => typeof value === "string" && value.startsWith("[{")));
    expect(rows.map((row: { projection: number }) => row.projection)).toEqual([12, 40]);
    expect(rows[0]).toMatchObject({ scoring: { settings: { reception: 0.5 }, label: "Half PPR" } });
    expect(rows[1]).toMatchObject({ scoring: { settings: null, label: "PPR" }, source_timestamp: null });
    const identityWrite = state.sql.mock.calls.find(([strings]) => strings.join("").includes("insert into player_id_map"));
    expect(identityWrite?.[0].join("")).toContain("do nothing");
  });

  it("does not invent a raw source projection for old snapshots lacking raw inputs", async () => {
    const snapshot = fallbackSnapshot();
    snapshot.roster = [{ canonicalPlayerId: "espn:1", name: "Example", team: "SF", position: "WR", slot: "WR", projection: 99 }];
    await saveSnapshot(snapshot);
    expect(state.sql.mock.calls.some(([strings]) => strings.join("").includes("insert into projections_by_source"))).toBe(false);
  });

  it("loads only explicit, verified identity aliases", async () => {
    state.sql.mockResolvedValueOnce([
      { provider: "espn", provider_player_id: "1", canonical_player_id: "canonical:one" },
      { provider: "sportsdataio", provider_player_id: "7", canonical_player_id: "canonical:one" },
      { provider: "bad", provider_player_id: null, canonical_player_id: "invalid" },
    ]);
    const identities = await getPlayerIdentityMap();
    expect([...identities.entries()]).toEqual([["espn:1", "canonical:one"], ["sportsdataio:7", "canonical:one"]]);
    expect(state.sql.mock.calls[0][0].join("")).toContain("where confidence = 1");
  });
});
