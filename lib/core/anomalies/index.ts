import type { Anomaly, CorePlayer, Feature } from "../schema";
import { DEFAULT_SOURCE_PRIORITY, validateFeatureRows, type FeatureValidationContext } from "../features";

export interface AnomalyThresholds {
  snapJump: number; highRoutes: number; lowTargetShare: number; minimumHighValueOpportunities: number;
  minimumVacantTargets: number; minimumVacantCarries: number; minimumEfficiencyAdvantage: number;
}
/** Detection thresholds are configurable starting hypotheses, not calibrated probabilities. */
export const DEFAULT_ANOMALY_THRESHOLDS: Readonly<AnomalyThresholds> = {
  snapJump: 20, highRoutes: 70, lowTargetShare: 10, minimumHighValueOpportunities: 2,
  minimumVacantTargets: 2, minimumVacantCarries: 3, minimumEfficiencyAdvantage: 0,
};
export interface AnomalyConfig extends FeatureValidationContext { thresholds?: Partial<AnomalyThresholds> }

export function detectAnomalies(players: readonly CorePlayer[], features: readonly Feature[], config: AnomalyConfig): Anomaly[] {
  const thresholds = { ...DEFAULT_ANOMALY_THRESHOLDS, ...config.thresholds };
  if (Object.values(thresholds).some((value) => !Number.isFinite(value) || value < 0) || thresholds.snapJump <= 0 || thresholds.highRoutes > 100 || thresholds.lowTargetShare > 100 || thresholds.minimumHighValueOpportunities <= 0 || thresholds.minimumVacantTargets <= 0 || thresholds.minimumVacantCarries <= 0) throw new Error("Invalid anomaly thresholds");
  const valid = validateFeatureRows(features, { ...config, maxAgeHours: config.maxAgeHours ?? 72 }).valid;
  const playerRows = new Map<string, Feature[]>();
  for (const row of valid) if (row.value !== null) playerRows.set(row.entity_id, [...(playerRows.get(row.entity_id) ?? []), row]);
  const anomalies: Anomaly[] = [];
  const priorities = { ...DEFAULT_SOURCE_PRIORITY, ...config.sourcePriority };
  const cutoff = Date.parse(config.asOf);
  for (const player of players) {
    if (!player.available || player.bye === true || /^(OUT|IR|PUP|SUSPENDED|SUSP)$/i.test(player.status ?? "")) continue;
    const evidence = player.evidence;
    if (!evidence || !evidence.source || !Number.isFinite(Date.parse(evidence.as_of)) || !Number.isFinite(Date.parse(evidence.fetched_at)) || Date.parse(evidence.as_of) > cutoff || Date.parse(evidence.fetched_at) > cutoff || Date.parse(evidence.fetched_at) < Date.parse(evidence.as_of) || cutoff - Date.parse(evidence.as_of) > (config.maxAgeHours ?? 72) * 3_600_000) continue;
    const rows = (playerRows.get(player.player_id) ?? []).sort((a, b) => (priorities[a.source.toLowerCase()] ?? 100) - (priorities[b.source.toLowerCase()] ?? 100) || Date.parse(b.as_of) - Date.parse(a.as_of) || a.source.localeCompare(b.source));
    const metrics = new Map<string, Feature>();
    for (const row of rows) if (!metrics.has(row.name)) metrics.set(row.name, row);
    const get = (name: string) => metrics.get(name);
    const add = (signal: string, evidence: Feature[], strength: number, risk: string, method: string) => {
      anomalies.push({ player_id: player.player_id, signal, evidence, strength: Math.min(100, Math.max(0, Math.round(strength))), duration: "Until the next verified role, practice or depth-chart update", risk, estimated: true, method: `${method}; configurable uncalibrated detection score, not breakout probability` });
    };
    const previousSnaps = get("snap_share_previous");
    const recentSnaps = get("snap_share_recent");
    if (previousSnaps?.value !== null && previousSnaps && recentSnaps?.value !== null && recentSnaps) {
      const delta = recentSnaps.value - previousSnaps.value;
      if (delta >= thresholds.snapJump) add("SILENT_SNAP_GROWTH", [previousSnaps, recentSnaps], 50 * delta / thresholds.snapJump, "More playing time may reflect temporary injuries or game script; snaps do not guarantee touches", "Observed recent-minus-prior snap share exceeds the configured threshold");
    }
    const routes = get("route_participation_recent") ?? get("route_participation");
    const targetShare = get("target_share_recent") ?? get("target_share");
    if ((player.position === "WR" || player.position === "TE") && routes && routes.value !== null && targetShare && targetShare.value !== null && routes.value >= thresholds.highRoutes && targetShare.value <= thresholds.lowTargetShare) {
      add("ROUTES_WITHOUT_TARGETS", [routes, targetShare], routes.value, "Routes alone do not prove targets will regress upward; coverage and quarterback choice can persist", "High observed route participation with low observed target share");
    }
    const endZone = get("end_zone_targets");
    const goalLine = get("goal_line_carries");
    const touchdowns = get("touchdowns");
    const highValue = [endZone, goalLine].filter((feature): feature is Feature => !!feature && feature.value !== null);
    const highValueCount = highValue.reduce((sum, feature) => sum + feature.value!, 0);
    if (touchdowns && touchdowns.value === 0 && highValueCount >= thresholds.minimumHighValueOpportunities) {
      add("HIGH_VALUE_WITHOUT_TOUCHDOWN", [...highValue, touchdowns], 50 * highValueCount / thresholds.minimumHighValueOpportunities, "Small sample; goal-line/end-zone opportunity does not establish an expected touchdown rate", "Observed high-value opportunities with no touchdown conversion; no assumed xTD rate");
    }
    const limited = get("starter_practice_limited");
    const candidateEfficiency = get("fppo");
    const starterEfficiency = get("starter_fppo");
    if (limited?.value === 1 && candidateEfficiency && candidateEfficiency.value !== null && starterEfficiency && starterEfficiency.value !== null && candidateEfficiency.value - starterEfficiency.value > thresholds.minimumEfficiencyAdvantage) {
      add("STARTER_LIMITED_EFFICIENT_BACKUP", [limited, candidateEfficiency, starterEfficiency], 50, "Comparative efficiency may come from different situations; official starter absence and role allocation remain necessary", "Verified limited practice plus observed higher points per opportunity; no assumed inheritance");
    }
    const vacantTargets = get("expected_vacant_targets");
    const vacantCarries = get("expected_vacant_carries");
    const inherited = [vacantTargets, vacantCarries].filter((feature): feature is Feature => !!feature && feature.value !== null && feature.estimated && !!feature.method);
    if ((vacantTargets?.estimated && vacantTargets.value !== null && vacantTargets.value >= thresholds.minimumVacantTargets) || (vacantCarries?.estimated && vacantCarries.value !== null && vacantCarries.value >= thresholds.minimumVacantCarries)) {
      if (inherited.length) add("STRUCTURAL_VACANCY", inherited, 50, "Conditional vacancy disappears if the absent teammate returns; redistributed role is an estimate", "Evidenced conditional opportunity allocation from the availability feature store");
    }
    const roleChange = get("role_change_confirmed");
    if (roleChange?.value === 1) add("CONFIRMED_ROLE_CHANGE", [roleChange], 50, "Role announcement must translate into measured playing time; effect size is uncalibrated", "Confirmed role/coordinator/quarterback change recorded by a permitted source");
  }
  return anomalies.sort((a, b) => b.strength - a.strength || a.player_id.localeCompare(b.player_id) || a.signal.localeCompare(b.signal));
}
