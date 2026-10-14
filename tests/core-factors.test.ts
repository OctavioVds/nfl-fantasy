import { describe, expect, it } from "vitest";
import { buildFeatureRows, FEATURE_CATALOG, validateFeatureRows } from "@/lib/core/features";
import { getAvailability, redistributeVacancies, shrinkTeammateSplit, validateScenarios } from "@/lib/core/availability";
import { estimateAdjustedMatchup, type DefenseObservation, type MatchupInput } from "@/lib/core/features/matchup";
import { detectAnomalies } from "@/lib/core/anomalies";
import { evaluateSignals, NFL_SOURCE_POLICIES } from "@/lib/core/signals";
import type { CorePlayer, Evidence, Feature, Roles, Scenario, SocialSignal, SourcePolicy, TeammateSplit } from "@/lib/core/schema";

// Fictitious fixtures validate engineering, not model accuracy or any real league.
const asOf = "2026-10-14T15:00:00Z";
const evidence: Evidence = { source: "fixture-manual", as_of: "2026-10-14T13:00:00Z", fetched_at: "2026-10-14T14:00:00Z", estimated: false };
const player = (id: string, position: CorePlayer["position"] = "WR", available = true): CorePlayer => ({ player_id: id, name: `Fictitious ${id}`, position, team_id: "team-a", available, kickoff: "2026-10-18T17:00:00Z", bye: false, evidence });
const role = (id: string, shares: Roles["shares"], rank?: string): Roles => ({ player_id: id, team_id: "team-a", role: rank, shares, evidence });
const scenario = (id: string, absent: string[], probability = 1, qbId: string | null = null): Scenario => ({ id, team_id: "team-a", probability, absent_player_ids: absent, qb_id: qbId, evidence });
const feature = (entity: string, name: string, value: number | null, changes: Partial<Feature> = {}): Feature => ({ entity_id: entity, season: 2026, week: 6, name, value, version: "core-features-v1", ...evidence, ...(value === null ? { reason: "Unavailable in fixture" } : {}), ...changes });

describe("honest feature store and cutoff checks", () => {
  it("emits exhaustive missing features as null plus reason, preserving per-feature provenance", () => {
    const rows = buildFeatureRows({ player: player("a"), season: 2026, week: 6, asOf: evidence.as_of, fetchedAt: evidence.fetched_at, source: evidence.source, version: "core-features-v1", values: { targets: { value: 7, source: "other", as_of: evidence.as_of, fetched_at: evidence.fetched_at }, separation: null } });
    expect(rows).toHaveLength(FEATURE_CATALOG.length);
    expect(new Set(rows.map((row) => row.name)).size).toBe(FEATURE_CATALOG.length);
    expect(rows.find((row) => row.name === "targets")).toMatchObject({ value: 7, source: "other" });
    expect(rows.find((row) => row.name === "separation")).toMatchObject({ value: null, reason: "Source did not provide this metric" });
    expect(validateFeatureRows(rows, { asOf, season: 2026, week: 6 }).issues).toEqual([]);
  });
  it("rejects invalid percentages, future fetches, duplicates, stale and unexplained estimates", () => {
    const rows = [feature("a", "snap_share", 101), feature("a", "targets", 3, { fetched_at: "2026-10-18T18:00:00Z" }), feature("a", "carries", 2), feature("a", "carries", 3), feature("a", "age", 21, { as_of: "2026-09-01T00:00:00Z" }), feature("a", "separation", 2, { estimated: true })];
    const checked = validateFeatureRows(rows, { asOf, maxAgeHours: 72 });
    expect(checked.valid).toHaveLength(0);
    expect(checked.issues).toHaveLength(6);
  });
  it("allows signed scoring projections/EPA and rejects binary values or future known-at leakage", () => {
    const checked = validateFeatureRows([feature("a", "espn_projection", -4), feature("a", "qb_epa_per_dropback", -0.2), feature("a", "bye", 2), feature("a", "targets", 4)], { asOf, cutoff: "2026-10-14T13:30:00Z" });
    expect(checked.valid).toHaveLength(0);
    expect(checked.issues.every((issue) => issue.reason.includes("cutoff"))).toBe(true);
    expect(validateFeatureRows([feature("a", "espn_projection", -4), feature("a", "qb_epa_per_dropback", -0.2), feature("a", "bye", 2)], { asOf }).valid).toHaveLength(2);
  });
  it("fails unknown names and wrong week instead of ingesting schema drift silently", () => {
    expect(validateFeatureRows([feature("a", "unexpected_api_field", 4), feature("a", "targets", 4, { week: 5 })], { asOf, week: 6 }).valid).toEqual([]);
  });
});

describe("availability, WOWY and differentiated roles", () => {
  const players = [player("a"), player("b"), player("c"), player("q", "QB")];
  it("requires probabilities sum one and canonical same-team valid quarterback IDs", () => {
    expect(validateScenarios([scenario("with", [], 0.7, "q"), scenario("without", ["a"], 0.3, "q")], players)).toEqual([]);
    expect(validateScenarios([scenario("without", ["not-an-id"], 0.3, "a")], players)).toHaveLength(3);
    expect(validateScenarios([scenario("qb-out", ["q"], 1, "q")], players).join(" ")).toContain("Invalid active QB");
  });
  it("shrinks small WOWY samples more strongly and labels prior-only estimates", () => {
    const split: TeammateSplit = { a_id: "a", b_id: "b", metric: "targets", with_value: 5, without_value: 10, n_with: 1, n_without: 1, prior_strength: 4, prior_delta: 0, evidence };
    const small = shrinkTeammateSplit(split);
    const large = shrinkTeammateSplit({ ...split, n_with: 40, n_without: 40 });
    expect(small.shrunk_delta).toBeCloseTo(5 / 9);
    expect(large.shrunk_delta!).toBeGreaterThan(small.shrunk_delta!);
    expect(shrinkTeammateSplit({ ...split, n_without: 0 })).toMatchObject({ shrunk_delta: 0, reason: "No usable paired sample; supplied prior only" });
  });
  it("redistributes double-injury target vacancy by observed routes, preserving total share", () => {
    const roles = [role("a", { targets: 25, routes: 25 }), role("b", { targets: 15, routes: 15 }), role("c", { targets: 30, routes: 40 }), role("d", { targets: 30, routes: 20 })];
    const [allocation] = redistributeVacancies(roles, [scenario("double-out", ["a", "b"])], "targets");
    expect(allocation.vacant_share).toBe(40);
    expect(allocation.beneficiaries.find((item) => item.player_id === "c")!.inherited_share).toBeCloseTo(80 / 3);
    expect(allocation.beneficiaries.reduce((sum, item) => sum + item.conditional_share, 0)).toBeCloseTo(100);
    expect(allocation.unallocated_share).toBe(0);
  });
  it("applies measured alignment overlap only when all candidates have complete alignment data", () => {
    const align = { outside: 100, slot: 0, in_line: 0, backfield: 0 };
    const roles = [role("a", { targets: 40, routes: 40, ...align }), role("b", { targets: 30, routes: 30, ...align }), role("c", { targets: 30, routes: 30, outside: 0, slot: 100, in_line: 0, backfield: 0 })];
    const [allocation] = redistributeVacancies(roles, [scenario("out", ["a"])], "targets");
    expect(allocation.beneficiaries.map((item) => item.player_id)).toEqual(["b"]);
    expect(allocation.beneficiaries[0].inherited_share).toBe(40);
  });
  it("keeps third-down and goal-line inheritance separate and does not invent recipient shares", () => {
    const roles = [role("a", { carries: 50, third_down: 60, goal_line: 50 }), role("b", { carries: 40, third_down: 0, goal_line: 50 }), role("c", { carries: 10, third_down: 40, goal_line: 0 })];
    const scenarios = [scenario("out", ["a"])];
    expect(redistributeVacancies(roles, scenarios, "third_down")[0].beneficiaries.map((item) => item.player_id)).toEqual(["c"]);
    expect(redistributeVacancies(roles, scenarios, "goal_line")[0].beneficiaries.map((item) => item.player_id)).toEqual(["b"]);
    expect(redistributeVacancies([role("a", { targets: 30 }), role("b", { targets: 20, routes: null })], scenarios, "targets")[0]).toMatchObject({ beneficiaries: [], unallocated_share: 30 });
  });
  it("fails impossible total shares and stale roles, reports explicit WR1+WR2 concentration", () => {
    expect(redistributeVacancies([role("a", { targets: 70, routes: 60 }), role("b", { targets: 60, routes: 40 })], [scenario("out", ["a"])], "targets")[0].reason).toContain("conflict");
    const result = getAvailability("team-a", players, [role("a", { targets: 35 }, "WR1"), role("b", { targets: 20 }, "WR2"), role("c", { targets: 30 }, "WR3")], [], [scenario("base", [], 1, "q")], { asOf });
    expect(result.concentration).toMatchObject({ value: 55, estimated: false, player_ids: ["a", "b"] });
    const stale = getAvailability("team-a", players, [{ ...role("a", { targets: 35 }), evidence: { ...evidence, as_of: "2026-09-01T00:00:00Z" } }], [], [scenario("base", [], 1, "q")], { asOf });
    expect(stale.redistribution).toEqual([]);
    expect(stale.issues.join(" ")).toContain("Stale");
  });
  it("does not create quarterback mean boosts without historically calibrated parameters", () => {
    const availability = getAvailability("team-a", players, [], [], [scenario("backup", ["a"], 1, "q")], { asOf });
    expect(availability.qb_context[0]).toMatchObject({ qb_id: "q" });
    expect(availability.qb_context[0].reason).toContain("no automatic mean boost");
  });
});

describe("schedule-adjusted DvP", () => {
  const observation = (week: number, changes: Partial<DefenseObservation> = {}): DefenseObservation => ({ defense_team_id: "defense", season: 2026, week, position: "RB", phase: "rush", alignment: "all", allowed_points: 40, opportunities: 20, opponent_expected_points: 20, opponent_expected_opportunities: 10, evidence, ...changes });
  const input = (changes: Partial<MatchupInput> = {}): MatchupInput => ({ defense_team_id: "defense", season: 2026, week: 6, position: "RB", phase: "rush", alignment: "all", expected_opportunities: 15, own_expected_points: 18, own_volume_evidence: evidence, observations: [observation(1), observation(2), observation(3)], asOf, ...changes });
  it("normalizes opponent quality and volume rather than using raw position points", () => {
    const adjusted = estimateAdjustedMatchup(input(), { calibrated: true });
    expect(adjusted.raw_ratio).toBe(1);
    expect(adjusted.adjusted_ratio).toBe(1);
    expect(adjusted.matchup_contribution).toBe(0);
    expect(adjusted.adjusted_points).toBe(18);
  });
  it("shrinks small samples, reports recent trend and separates matchup versus own volume", () => {
    const result = estimateAdjustedMatchup(input({ observations: [observation(1), observation(2), observation(3, { allowed_points: 60 }), observation(4, { allowed_points: 60 }), observation(5, { allowed_points: 60 })] }), { calibrated: true });
    expect(result.adjusted_ratio!).toBeGreaterThan(1);
    expect(result.adjusted_ratio!).toBeLessThan(result.raw_ratio!);
    expect(result.trend!).toBeGreaterThan(0);
    expect(result.own_volume_points).toBe(18);
    expect(result.matchup_contribution!).toBeLessThanOrEqual(18 * 0.15);
    expect(result.adjusted_points).toBeCloseTo(18 + result.matchup_contribution!);
  });
  it("never makes a three-touch RB explode and does not apply uncalibrated mean deltas", () => {
    expect(estimateAdjustedMatchup(input({ expected_opportunities: 3 }), { calibrated: true })).toMatchObject({ adjusted_points: null, matchup_contribution: null, reason: "Own volume is below the configured matchup threshold" });
    expect(estimateAdjustedMatchup(input())).toMatchObject({ adjusted_points: null, calibrated: false });
  });
  it("filters future/current week or mismatched alignment and blocks injured-defense extrapolation", () => {
    expect(estimateAdjustedMatchup(input({ observations: [observation(6), observation(5, { alignment: "slot" }), observation(4, { evidence: { ...evidence, fetched_at: "2026-10-20T00:00:00Z" } })] })).sample_games).toBe(0);
    expect(estimateAdjustedMatchup(input({ defensive_absences: ["cb-id"] }), { calibrated: true }).reason).toContain("defensive absences");
  });
});

describe("source-based available-player anomalies", () => {
  const rows = [feature("a", "snap_share_previous", 15), feature("a", "snap_share_recent", 65), feature("a", "route_participation", 80), feature("a", "target_share", 5), feature("a", "goal_line_carries", 3), feature("a", "touchdowns", 0)];
  it("flags measured snap/routes/high-value opportunity with evidence and explicit estimated methods", () => {
    const anomalies = detectAnomalies([player("a")], rows, { asOf, week: 6 });
    expect(anomalies.map((item) => item.signal).sort()).toEqual(["HIGH_VALUE_WITHOUT_TOUCHDOWN", "ROUTES_WITHOUT_TARGETS", "SILENT_SNAP_GROWTH"]);
    expect(anomalies.every((item) => item.evidence.length > 0 && item.strength >= 0 && item.strength <= 100 && item.method.includes("uncalibrated"))).toBe(true);
  });
  it("ignores occupied, OUT, bye and stale players/features", () => {
    expect(detectAnomalies([player("a", "WR", false)], rows, { asOf })).toEqual([]);
    expect(detectAnomalies([{ ...player("a"), status: "OUT" }], rows, { asOf })).toEqual([]);
    expect(detectAnomalies([{ ...player("a"), bye: true }], rows, { asOf })).toEqual([]);
    expect(detectAnomalies([player("a")], rows.map((row) => ({ ...row, as_of: "2026-09-01T00:00:00Z" })), { asOf })).toEqual([]);
  });
  it("requires explained conditional estimates for structural vacancy", () => {
    expect(detectAnomalies([player("a")], [feature("a", "expected_vacant_targets", 4)], { asOf })).toEqual([]);
    const allocation = feature("a", "expected_vacant_targets", 4, { estimated: true, method: "Observed role redistribution" });
    expect(detectAnomalies([player("a")], [allocation], { asOf })[0]).toMatchObject({ signal: "STRUCTURAL_VACANCY", estimated: true });
  });
});

describe("curated signals, confirmation and decay", () => {
  const policies: SourcePolicy[] = [
    { id: "team-official", url: "https://official.example/injury", tier: "official", reliability: null, version: "fixture-v1", permitted: true },
    { id: "beat-one", url: "https://beat-one.example/report", tier: "beat", reliability: 90, version: "fixture-v1", permitted: true },
    { id: "beat-two", url: "https://beat-two.example/report", tier: "beat", reliability: 85, version: "fixture-v1", permitted: true },
  ];
  const signal = (changes: Partial<SocialSignal> = {}): SocialSignal => ({ id: "signal-a", source_id: "beat-one", player_id: "a", team_id: "team-a", kind: "role", summary: "Fictitious practice role report", confirmed: false, second_source_id: null, ts: "2026-10-14T13:00:00Z", evidence, ...changes });
  it("curates policy identities without claiming reliability or permission absent verification", () => {
    expect(NFL_SOURCE_POLICIES[0]).toMatchObject({ reliability: null, permitted: false });
    expect(evaluateSignals([signal()], [], { asOf })[0]).toMatchObject({ label: "EXCLUIDO", mean_delta: 0 });
  });
  it("unconfirmed or self-confirmed rumors only flag uncertainty even with learned coefficients", () => {
    const [rumor] = evaluateSignals([signal({ confirmed: true, second_source_id: "beat-one" })], policies, { asOf, calibratedMeanEffect: { role: 3 } });
    expect(rumor).toMatchObject({ label: "RUMOR", mean_delta: 0 });
    expect(rumor.uncertainty_score!).toBeGreaterThan(0);
  });
  it("accepts official or two distinct reliable confirmations, applies only bounded learned effects", () => {
    const [official] = evaluateSignals([signal({ source_id: "team-official", confirmed: true })], policies, { asOf });
    expect(official).toMatchObject({ label: "CONFIRMADO", mean_delta: 0 });
    const [confirmed] = evaluateSignals([signal({ confirmed: true, second_source_id: "beat-two" })], policies, { asOf, calibratedMeanEffect: { role: 5 }, maxAbsoluteMeanEffect: 1 });
    expect(confirmed).toMatchObject({ label: "CONFIRMADO", mean_delta: 1 });
  });
  it("decays to half at one half-life and excludes stale, future or missing-ID signals", () => {
    const [decayed] = evaluateSignals([signal({ ts: "2026-10-13T15:00:00Z" })], policies, { asOf, halfLifeHours: 24 });
    expect(decayed.decay).toBeCloseTo(0.5);
    const excluded = evaluateSignals([signal({ ts: "2026-10-20T00:00:00Z" }), signal({ id: "stale", ts: "2026-09-20T00:00:00Z" }), signal({ id: "missing", player_id: null, team_id: null })], policies, { asOf });
    expect(excluded.every((item) => item.label === "EXCLUIDO" && item.mean_delta === 0)).toBe(true);
  });
});
