import { describe, expect, it } from "vitest";
import { horizonValue, type HorizonInput } from "@/lib/core/projection/horizon";
import type { Projection } from "@/lib/core/schema";
import { verifyFutureProjection } from "@/lib/core/store";

// Fictional forecasts only. These fixtures never certify a fantasy model.
const forecast = (playerId: string, week: number, mean: number, change: Partial<Projection> = {}): Projection => ({
  player_id: playerId, season: 2026, week, scenario: "base", mean, sd: 2, p10: mean - 3, p50: mean, p90: mean + 3, prob_play: 1, confidence: 90,
  drivers: [], model_version: "fixture-model", scoring_hash: "fixture-scoring", as_of: "2026-10-01T12:00:00Z", fetched_at: "2026-10-01T12:00:00Z",
  estimated: true, method: "Fictitious accepted forecast for engineering only", reason: null, missing: [], eligible: true,
  ros_mean: null, ros_sd: null, playoff_mean: null, war: null, ...change,
});
const input = (change: Partial<HorizonInput> = {}): HorizonInput => ({
  playerId: "fixture-target", season: 2026, fromWeek: 7, throughWeek: 9, playoffWeeks: [8, 9],
  projections: [forecast("fixture-target", 7, 12), forecast("fixture-target", 8, 15), forecast("fixture-target", 9, 18)],
  replacementProjections: [7, 8, 9].flatMap((week) => [forecast("fixture-available-a", week, 10), forecast("fixture-available-b", week, 6)]),
  starterCounts: { WR: 2 }, position: "WR", scoringHash: "fixture-scoring", ...change,
});

describe("verified future weekly horizons and positional replacement", () => {
  it("blocks stale or future source timestamps before future forecasts reach ROS and WAR", () => {
    const current = "2026-10-02T12:00:00Z";
    expect(verifyFutureProjection(forecast("fixture-target", 8, 15), current).eligible).toBe(true);
    for (const change of [{as_of:"2026-09-30T11:59:59Z"},{fetched_at:"2026-10-02T12:00:01Z"},{as_of:"invalid"},{fetched_at:"2026-09-30T12:00:00Z"}]) {
      const invalid = verifyFutureProjection(forecast("fixture-target", 8, 15, change), current);
      expect(invalid.eligible).toBe(false);
      expect(horizonValue(input({projections: input().projections.map((row) => row.week === 8 ? invalid : row)})).ros_mean).toBeNull();
    }
  });
  it("uses weekly averages for ROS, actual playoff weeks and points above the best available replacement", () => {
    const result = horizonValue(input());
    expect(result).toMatchObject({ ros_mean: 15, ros_sd: null, playoff_mean: 16.5, war: 5, estimated: true });
    expect(result.reason).toEqual([expect.stringContaining("covariance/correlation")]);
  });

  it("leaves ROS and WAR null if any week is missing, without extrapolating the current week", () => {
    const result = horizonValue(input({ projections: [forecast("fixture-target", 8, 15), forecast("fixture-target", 9, 18)] }));
    expect(result).toMatchObject({ ros_mean: null, playoff_mean: 16.5, war: null });
    expect(result.reason).toContainEqual(expect.stringContaining("ROS week 7"));
  });

  it("matches player, season and exact scoring, and uses unconditional base rather than conditional double counts", () => {
    for (const change of [{ player_id: "other-player" }, { season: 2025 }, { scoring_hash: "other-scoring" }, { scenario: "teammate-out" }]) {
      const projections = input().projections.map((row) => row.week === 8 ? { ...row, ...change } : row);
      expect(horizonValue(input({ projections })).ros_mean).toBeNull();
    }
    expect(horizonValue(input({ projections: [...input().projections, forecast("fixture-target", 8, 100, { scenario: "teammate-out", as_of: "2026-10-03T12:00:00Z", fetched_at: "2026-10-03T12:00:00Z" })] })).ros_mean).toBe(15);
  });

  it("takes the latest as_of and deduplicates repeated forecasts before averaging", () => {
    const later = forecast("fixture-target", 8, 21, { as_of: "2026-10-02T12:00:00Z", fetched_at: "2026-10-02T12:00:00Z" });
    expect(horizonValue(input({ projections: [...input().projections, later, later] })).ros_mean).toBe(17);
    const result = horizonValue(input({ projections: [...input().projections, later, { ...later, mean: 99 }] }));
    expect(result.ros_mean).toBeNull();
    expect(result.reason).toContainEqual(expect.stringContaining("Contradictory forecasts"));
  });

  it("does not fall back to an older accepted forecast when the latest is unavailable", () => {
    const bad = forecast("fixture-target", 8, 21, { as_of: "2026-10-02T12:00:00Z", fetched_at: "2026-10-02T12:00:00Z", eligible: false });
    expect(horizonValue(input({ projections: [...input().projections, bad] })).ros_mean).toBeNull();
  });

  it("requires calibrated distribution/model metadata while allowing an officially verified future bye", () => {
    for (const change of [{ sd: null }, { p10: 100 }, { prob_play: null }, { model_version: null }, { as_of: "invalid" }, { fetched_at: "2026-09-01T12:00:00Z" }]) {
      expect(horizonValue(input({ projections: input().projections.map((row) => row.week === 8 ? { ...row, ...change } : row) })).ros_mean).toBeNull();
    }
    const bye = forecast("fixture-target", 8, 0, { sd: 0, p10: 0, p50: 0, p90: 0, prob_play: 0, model_version: null, method: "Verified schedule or availability determines zero opportunity", reason: "Bye confirmed" });
    expect(horizonValue(input({ projections: [forecast("fixture-target", 7, 12), bye, forecast("fixture-target", 9, 18)] })).ros_mean).toBe(10);
  });

  it("does not invent playoff dates, and deduplicates supplied dates", () => {
    expect(horizonValue(input({ playoffWeeks: null })).playoff_mean).toBeNull();
    expect(horizonValue(input({ playoffWeeks: [] })).playoff_mean).toBeNull();
    expect(horizonValue(input({ playoffWeeks: [8, 8, 9] })).playoff_mean).toBe(16.5);
    expect(horizonValue(input({ playoffWeeks: [10] })).playoff_mean).toBeNull();
    expect(horizonValue(input({ playoffWeeks: [0, 8] })).playoff_mean).toBeNull();
  });

  it("requires real positional starter demand without changing available ROS", () => {
    for (const starterCounts of [null, {}, { WR: 0 }, { WR: 1.5 }, { QB: 12 }]) {
      expect(horizonValue(input({ starterCounts }))).toMatchObject({ ros_mean: 15, war: null });
    }
  });

  it("requires a replacement in every week, deduplicates forecasts and does not rank free agents by league capacity", () => {
    const pool = [7, 8, 9].flatMap((week) => [forecast("fixture-available-a", week, 10), forecast("fixture-available-a", week, 10)]);
    expect(horizonValue(input({ replacementProjections: pool })).war).toBe(5);
    expect(horizonValue(input({ replacementProjections: pool, starterCounts: { WR: 24 } })).war).toBe(5);
    expect(horizonValue(input({ replacementProjections: input().replacementProjections.filter((row) => row.week !== 8) })).war).toBeNull();
  });

  it("does not claim a lower replacement when another available player's forecast is unknown", () => {
    const pool = [...input().replacementProjections, forecast("fixture-unmeasured", 8, 50, { eligible: false, mean: null })];
    expect(horizonValue(input({ replacementProjections: pool })).war).toBeNull();
    const conflicting = forecast("fixture-available-a", 8, 30);
    expect(horizonValue(input({ replacementProjections: [...input().replacementProjections, conflicting] })).war).toBeNull();
  });

  it("never uses the target as its own replacement and preserves negative point/WAR estimates", () => {
    const pool = [7, 8, 9].flatMap((week) => [forecast("fixture-target", week, 20), forecast("fixture-available-a", week, 10)]);
    expect(horizonValue(input({ replacementProjections: pool })).war).toBe(5);
    expect(horizonValue(input({ replacementProjections: input().projections })).war).toBeNull();
    const projections = [7, 8, 9].map((week) => forecast("fixture-target", week, -4));
    const replacementProjections = [7, 8, 9].map((week) => forecast("fixture-available", week, -1));
    expect(horizonValue(input({ position: "DST", starterCounts: { DST: 1 }, projections, replacementProjections }))).toMatchObject({ ros_mean: -4, playoff_mean: -4, war: -3, ros_sd: null });
  });

  it("returns nulls for empty history or invalid horizon instead of zero forecasts", () => {
    expect(horizonValue(input({ projections: [], replacementProjections: [] }))).toMatchObject({ ros_mean: null, playoff_mean: null, war: null });
    expect(horizonValue(input({ fromWeek: 10, throughWeek: 9 }))).toMatchObject({ ros_mean: null, playoff_mean: null, war: null });
  });
});
