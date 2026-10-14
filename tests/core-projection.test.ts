import { describe, expect, it } from "vitest";
import { calibrationOffsets, FEATURE_VERSION, mixScenarios, projectPlayer, validDistribution, weightedQuantile } from "@/lib/core/projection";
import { fantasyPoints, scoringHash, weightedOpportunity } from "@/lib/core/scoring";
import { shrinkTeammateSplit } from "@/lib/core/availability";
import type { CoreInput, CorePlayer, Evidence, ExternalProjection, Feature, ModelArtifact, Scoring, TeammateSplit } from "@/lib/core/schema";

// Explicitly fictitious engineering fixtures; their accepted flags never certify real performance.
const asOf = "2026-10-14T15:00:00Z";
const evidence: Evidence = { source: "fixture", as_of: "2026-10-14T13:00:00Z", fetched_at: "2026-10-14T14:00:00Z", estimated: false };
const scoring: Scoring = { rules: [{ stat: "receptions", points: 1, mode: "linear" }, { stat: "recYards", points: .1, mode: "linear" }, { stat: "recTd", points: 6, mode: "linear" }], ...evidence };
const player: CorePlayer = { player_id: "fixture:a", name: "Fictitious Receiver", team_id: "team-a", position: "WR", available: true, status: "ACTIVE", kickoff: "2026-10-18T17:00:00Z", bye: false, evidence };
const feature = (name: string, value: number, changes: Partial<Feature> = {}): Feature => ({ entity_id: player.player_id, season: 2026, week: 6, name, value, version: FEATURE_VERSION, ...evidence, ...changes });
const baseline = (changes: Partial<ExternalProjection> = {}): ExternalProjection => ({ player_id: player.player_id, season: 2026, week: 6, scenario: "base", points: 10, scoring_hash: scoringHash(scoring), ...evidence, source: "espn", ...changes });
const input = (changes: Partial<CoreInput> = {}): CoreInput => ({ scope: "fixture:league", season: 2026, week: 6, as_of: asOf, scoring, players: [player], features: [feature("targets", 5)], roles: [], splits: [], scenarios: [], signals: [], policies: [], projections: [baseline()], defense_observations: [], playoff_weeks: null, starter_counts: null, ...changes });
function artifact(residuals = Array.from({ length: 20 }, (_, index) => index - 5)): ModelArtifact {
  const bias = residuals.reduce((sum, value) => sum + value, 0) / residuals.length;
  const sd = Math.sqrt(residuals.reduce((sum, value) => sum + (value - bias) ** 2, 0) / (residuals.length - 1));
  return {
    version: "fixture-only", scoring_hash: scoringHash(scoring), feature_version: FEATURE_VERSION,
    trained_at: "2026-10-14T12:00:00Z", training_cutoff: "2026-10-14T12:00:00Z", seed: 42, data_digest: "not-real-data",
    models: { WR: { features: ["targets"], coefficients: [1], intercept: 5, means: [4], residuals, bias, sd, ensemble_weight: 1, conformal_radius: 15, prob_play: null, availability_reason: "No fitted availability classifier", accepted: true, training_cutoff: "2026-09-01T00:00:00Z", ensemble_calibration_cutoff: "2026-09-15T00:00:00Z", calibration_cutoff: "2026-10-14T12:00:00Z", train_samples: 50, ensemble_calibration_samples: 20, calibration_samples: residuals.length } },
    metrics: {}, gate: { accepted: true, real_data: true, reason: "Fictitious fixture flag for inference unit test only" },
  };
}

describe("calibrated projection and provenance", () => {
  it("rejects unknown artifact features instead of silently imputing a variable unsupported at inference", () => {
    const model = artifact(); model.models.WR.features=["targets","unknown-fixture-metric"]; model.models.WR.coefficients=[1,1]; model.models.WR.means=[4,99];
    expect(projectPlayer(player,input(),model)).toMatchObject({eligible:false,p50:null,reason:"Model feature is not supported by this feature version"});
  });
  it("applies weather only to verified open venues and blocks unknown roof", () => {
    const model = artifact(); model.models.WR.features=["wind_mph"]; model.models.WR.coefficients=[-1]; model.models.WR.means=[5]; model.models.WR.intercept=20;
    const outdoor = projectPlayer(player,input({features:[feature("wind_mph",10),feature("dome",0)]}),model);
    const indoor = projectPlayer(player,input({features:[feature("wind_mph",10),feature("dome",1)]}),model);
    expect(outdoor.mean).toBe(14.5); expect(indoor.mean).toBe(24.5);
    expect(indoor.drivers.find((driver) => driver.text.includes("disabled"))?.contribution).toBe(0);
    expect(projectPlayer(player,input({features:[feature("wind_mph",10)]}),model).eligible).toBe(false);
  });
  it("aligns Python equal-tail indices, median, bias correction and raw-unit coefficients", () => {
    expect(calibrationOffsets(Array.from({ length: 20 }, (_, index) => index - 5))).toEqual({ p10: -4, p50: 4.5, p90: 13 });
    const row = projectPlayer(player, input(), artifact());
    expect(row).toMatchObject({ mean: 14.5, p10: 6, p50: 14.5, p90: 23, prob_play: 1, eligible: true });
    expect(row.sd).toBeCloseTo(Math.sqrt(35));
    expect(row.residual_support!.reduce((sum, point) => sum + point.value * point.probability, 0)).toBeCloseTo(row.mean!);
    expect(row.drivers.reduce((sum, driver) => sum + (driver.contribution ?? 0), 0)).toBeCloseTo(row.mean!);
    expect(validDistribution(row)).toBe(true);
  });
  it("leaves raw baseline uncertainty and median unknown instead of calling its point mean a quantile", () => {
    const row = projectPlayer(player, input(), null);
    expect(row).toMatchObject({ mean: 10, sd: null, p10: null, p50: null, p90: null, eligible: false });
    expect(row.residual_support).toBeUndefined();
  });
  it("preserves negative defense points and calibrated bands", () => {
    const defense = { ...player, position: "DST" as const };
    const model = artifact();
    model.models.DST = { ...model.models.WR, intercept: -15 };
    const row = projectPlayer(defense, input({ players: [defense], projections: [baseline({ points: -4 })] }), model);
    expect(row.mean).toBe(-5.5);
    expect(row.p10).toBe(-14);
    expect(row.p50).toBe(-5.5);
    expect(validDistribution(row)).toBe(true);
  });
  it("returns zero for confirmed OUT/bye even without a model and refuses unknown scenarios", () => {
    const out = { ...player, status: "OUT" };
    expect(projectPlayer(out, input({ players: [out] }), null)).toMatchObject({ mean: 0, sd: 0, prob_play: 0, residual_support: [{ value: 0, probability: 1 }] });
    const bye = { ...player, bye: true, kickoff: null };
    expect(projectPlayer(bye, input({ players: [bye] }), null)).toMatchObject({ mean: 0, prob_play: 0 });
    expect(projectPlayer(player, input(), artifact(), "not-a-scenario")).toMatchObject({ mean: null, eligible: false, reason: "Unknown availability scenario" });
  });
  it("does not assert ACTIVE/OUT/bye or ownership when player evidence is missing or stale", () => {
    for (const candidate of [{ ...player, evidence: undefined }, { ...player, status: "OUT", evidence: { ...evidence, as_of: "2026-09-01T00:00:00Z" } }, { ...player, bye: true, kickoff: null, evidence: undefined }]) expect(projectPlayer(candidate, input({ players: [candidate] }), artifact())).toMatchObject({ mean: null, prob_play: null, eligible: false });
  });
  it("identifies the ESPN-connected Flaim baseline without treating unspecified Flaim points as ESPN", () => {
    expect(projectPlayer(player, input({ projections: [baseline({ source: "flaim" })] }), null).mean).toBeNull();
    expect(projectPlayer(player, input({ projections: [baseline({ source: "flaim:espn" })] }), null).mean).toBe(10);
  });
  it("blocks unknown identity, missing schedule, stale/future scoring and regenerated locked games", () => {
    expect(projectPlayer({ ...player, player_id: "different" }, input(), artifact()).mean).toBeNull();
    expect(projectPlayer({ ...player, bye: null }, input({ players: [{ ...player, bye: null }] }), artifact()).mean).toBeNull();
    expect(projectPlayer(player, input({ scoring: { ...scoring, fetched_at: "2026-10-14T15:00:01Z" } }), artifact()).mean).toBeNull();
    const locked = { ...player, evidence: { ...evidence, as_of: "2026-10-18T16:00:00Z", fetched_at: "2026-10-18T16:30:00Z" } };
    expect(projectPlayer(locked, input({ players: [locked], as_of: "2026-10-18T18:00:00Z", scoring: { ...scoring, as_of: "2026-10-18T16:00:00Z", fetched_at: "2026-10-18T16:30:00Z" } }), artifact()).reason).toContain("Game locked");
  });
  it("rejects baseline after kickoff or wrong scoring hash/week without borrowing another record", () => {
    for (const changes of [{ fetched_at: "2026-10-18T18:00:00Z" }, { scoring_hash: "wrong" }, { week: 5 }]) expect(projectPlayer(player, input({ projections: [baseline(changes)] }), null).mean).toBeNull();
  });
  it("requires accepted position/scoring/version/real data and valid calibration chronology", () => {
    for (const change of ["position", "hash", "version", "real", "chronology", "moments"] as const) {
      const model = artifact();
      if (change === "position") model.models.WR.accepted = false;
      if (change === "hash") model.scoring_hash = "different";
      if (change === "version") model.feature_version = "different";
      if (change === "real") model.gate.real_data = false;
      if (change === "chronology") model.models.WR.calibration_cutoff = "2026-10-19T00:00:00Z";
      if (change === "moments") model.models.WR.bias = 99;
      expect(projectPlayer(player, input(), model).eligible).toBe(false);
      expect(projectPlayer(player, input(), model).p50).toBeNull();
    }
  });
  it("does not use post-cutoff/wrong-version features and stops when more than half are missing", () => {
    const model = artifact();
    model.models.WR = { ...model.models.WR, features: ["targets", "routes", "carries"], coefficients: [1, .1, .2], means: [4, 20, 3] };
    const row = projectPlayer(player, input({ features: [feature("targets", 5), feature("routes", 30, { fetched_at: "2026-10-18T18:00:00Z" }), feature("carries", 4, { version: "wrong" })] }), model);
    expect(row).toMatchObject({ mean: 10, eligible: false, p50: null, missing: ["routes", "carries"] });
    expect(row.reason).toContain("fraction");
  });
  it("uses official/ESPN priority and fails contradictory provider duplicate forecasts", () => {
    expect(projectPlayer(player, input({ features: [feature("targets", 5, { source: "espn" }), feature("targets", 25, { source: "sportsdataio" })] }), artifact()).mean).toBe(14.5);
    const row = projectPlayer(player, input({ projections: [baseline(), baseline({ points: 30 })] }), artifact());
    expect(row.eligible).toBe(false);
    expect(row.reason).toContain("Contradictory");
  });
  it("broadens uncertainty from real provider disagreement, leaves mean unchanged, blocks consumers", () => {
    const ordinary = projectPlayer(player, input(), artifact());
    const diverged = projectPlayer(player, input({ projections: [baseline(), baseline({ source: "sportsdataio", points: 40 })] }), artifact());
    expect(diverged.mean).toBe(ordinary.mean);
    expect(diverged.sd!).toBeGreaterThan(ordinary.sd!);
    expect(diverged.eligible).toBe(false);
    expect(diverged.method).toContain("uncalibrated");
    expect(diverged.reason).toContain("divergence");
  });
});

describe("conditional inference and full scenario distribution", () => {
  const scenarios: CoreInput["scenarios"] = [
    { id: "with", team_id: "team-a", probability: .6, absent_player_ids: [], qb_id: null, evidence },
    { id: "without", team_id: "team-a", probability: .4, absent_player_ids: [player.player_id], qb_id: null, evidence },
  ];
  it("does not multiply playing probability twice and computes mixture CDF quantiles/total variance", () => {
    const model = artifact(Array(20).fill(0));
    const questionable = { ...player, status: "QUESTIONABLE" };
    const data = input({ players: [questionable], scenarios, features: [feature("targets", 5), feature("prob_play", 60)] });
    const alive = projectPlayer(questionable, data, model, "with"), absent = projectPlayer(questionable, data, model, "without");
    expect(alive).toMatchObject({ mean: 10, prob_play: 1 });
    expect(absent).toMatchObject({ mean: 0, prob_play: 0 });
    const mixed = mixScenarios([{ probability: .6, projection: alive }, { probability: .4, projection: absent }], projectPlayer(questionable, data, model));
    expect(mixed).toMatchObject({ mean: 6, p10: 0, p50: 10, p90: 10, prob_play: .6, eligible: true });
    expect(mixed.sd).toBeCloseTo(Math.sqrt(24));
    expect(mixed.residual_support!.reduce((sum, point) => sum + point.value * point.probability, 0)).toBeCloseTo(6);
  });
  it("requires the exact conditional ESPN baseline for a learned external ensemble", () => {
    const model = artifact();
    model.models.WR.ensemble_weight = .5;
    const data = input({ scenarios });
    expect(projectPlayer(player, data, model, "with")).toMatchObject({ mean: null, eligible: false });
    expect(projectPlayer(player, input({ scenarios, projections: [baseline({ scenario: "with" })] }), model, "with").eligible).toBe(true);
  });
  it("uses the same harmonic-sample WOWY shrinkage as availability", () => {
    const teammate = { ...player, player_id: "fixture:b", name: "Fictitious Teammate" };
    const split: TeammateSplit = { a_id: player.player_id, b_id: teammate.player_id, metric: "targets", with_value: 5, without_value: 10, n_with: 1, n_without: 1, prior_strength: 4, prior_delta: 0, evidence };
    const data = input({ players: [player, teammate], splits: [split], scenarios: [{ id: "teammate-out", team_id: "team-a", probability: 1, absent_player_ids: [teammate.player_id], qb_id: null, evidence }] });
    const row = projectPlayer(player, data, artifact(), "teammate-out");
    expect(row.mean).toBeCloseTo(14.5 + shrinkTeammateSplit(split).shrunk_delta!);
    expect(row.drivers.filter((driver) => driver.block === "availability")[0].contribution).toBeCloseTo(5 / 9);
  });
  it("refuses unknown absent teammates instead of fabricating their impact", () => {
    const data = input({ scenarios: [{ id: "unknown-out", team_id: "team-a", probability: 1, absent_player_ids: ["not-an-id"], qb_id: null, evidence }] });
    expect(projectPlayer(player, data, artifact(), "unknown-out")).toMatchObject({ mean: null, eligible: false });
  });
  it("does not renormalize missing positive-probability components, allows zero-weight unavailable rows", () => {
    const base = projectPlayer(player, input(), artifact());
    const available = { ...base, scenario: "one" }, unavailable = { ...projectPlayer(player, input(), null), scenario: "two" };
    expect(mixScenarios([{ probability: .5, projection: available }, { probability: .5, projection: unavailable }], base).eligible).toBe(false);
    expect(mixScenarios([{ probability: 1, projection: available }, { probability: 0, projection: unavailable }], base).eligible).toBe(true);
    expect(mixScenarios([{ probability: 1, projection: available }], base).p90).toBe(available.p90);
    expect(mixScenarios([{ probability: -1, projection: available }, { probability: 2, projection: unavailable }], base).eligible).toBe(false);
  });
  it("rejects invalid supports/quantile order even with absent medians and never invents distribution support", () => {
    const row = projectPlayer(player, input(), artifact());
    expect(validDistribution({ ...row, p10: 100, p50: null, p90: 10, eligible: false })).toBe(false);
    expect(validDistribution({ ...row, residual_support: [{ value: 10, probability: .5 }] })).toBe(false);
    expect(() => weightedQuantile([{ value: 5, probability: 0 }, { value: 10, probability: 1 }], NaN)).toThrow();
    expect(weightedQuantile([{ value: -999, probability: 0 }, { value: 10, probability: 1 }], 0)).toBe(10);
  });
});

describe("league scoring stays specific", () => {
  it("calculates TE premium and yardage bonuses from explicit league rules and changes scoring hash", () => {
    const custom: Scoring = { ...scoring, rules: [...scoring.rules, { stat: "receptions", position: "TE", points: .5, mode: "linear" }, { stat: "recYards", threshold: 50, points: 3, mode: "bonus" }] };
    const stats = { receptions: 3, recYards: 63, recTd: 0 };
    expect(fantasyPoints(stats, custom, "TE").value).toBeCloseTo(13.8);
    expect(fantasyPoints(stats, custom, "WR").value).toBeCloseTo(12.3);
    expect(scoringHash(custom)).not.toBe(scoringHash(scoring));
    expect(weightedOpportunity("target", { catchProbability: .7, expectedYards: 10, touchdownProbability: .1 }, custom, "TE").value).toBeNull();
  });
});
