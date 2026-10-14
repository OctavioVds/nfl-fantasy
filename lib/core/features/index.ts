import type { CorePlayer, Evidence, Feature } from "../schema";
import featureCatalog from "../feature-catalog.json";

export interface FeatureDefinition { name: string; block: string; percent?: boolean; signed?: boolean }

/** Shared with the offline trainer; percentages use 0–100. */
export const FEATURE_CATALOG: readonly FeatureDefinition[] = featureCatalog;

const definitions = new Map(FEATURE_CATALOG.map((feature) => [feature.name, feature]));
export const DEFAULT_SOURCE_PRIORITY: Readonly<Record<string, number>> = { nfl: 0, "nfl-official-injuries": 0, official: 0, espn: 1, "flaim:espn": 1, sportsdataio: 2, media: 3, consensus: 4 };
const binaryFeatures = new Set("practice_dnp practice_lp practice_fp starter_practice_limited short_week extra_rest bye dome turf active official_inactive qb_changed coordinator_changed team_changed contract_changed rookie role_change_confirmed".split(" "));
export interface FeatureValue extends Partial<Evidence> { value: number | null }
export interface FeatureBuildInput {
  player: Pick<CorePlayer, "player_id">; season: number; week: number;
  asOf: string; fetchedAt: string; source: string; version: string;
  values: Record<string, number | null | FeatureValue | undefined>;
}
export interface QualityIssue { entity_id: string; name: string; reason: string }
export interface FeatureValidationContext { asOf: string; season?: number; week?: number; cutoff?: string; maxAgeHours?: number; sourcePriority?: Record<string, number> }

export function buildFeatureRows(input: FeatureBuildInput): Feature[] {
  return FEATURE_CATALOG.map(({ name }) => {
    const supplied = input.values[name];
    const value = typeof supplied === "object" && supplied !== null ? supplied : { value: supplied ?? null };
    return {
      entity_id: input.player.player_id, season: input.season, week: input.week, name, value: value.value,
      source: value.source ?? input.source, as_of: value.as_of ?? input.asOf, fetched_at: value.fetched_at ?? input.fetchedAt,
      version: input.version, estimated: value.estimated ?? false,
      ...(value.method ? { method: value.method } : {}),
      ...(value.reason ? { reason: value.reason } : value.value === null ? { reason: "Source did not provide this metric" } : {}),
    };
  });
}

export function validateFeatureRows(rows: readonly Feature[], context: FeatureValidationContext): { valid: Feature[]; issues: QualityIssue[] } {
  const valid: Feature[] = [];
  const issues: QualityIssue[] = [];
  const keys = new Map<string, number>();
  const naturalKey = (row: Feature) => JSON.stringify([row.entity_id, row.season, row.week, row.name, row.source, row.version]);
  for (const row of rows) keys.set(naturalKey(row), (keys.get(naturalKey(row)) ?? 0) + 1);
  const now = Date.parse(context.asOf);
  const cutoff = Date.parse(context.cutoff ?? context.asOf);
  if (!Number.isFinite(now) || !Number.isFinite(cutoff)) throw new Error("Invalid feature validation timestamp");
  for (const row of rows) {
    let reason: string | null = null;
    const key = naturalKey(row);
    const definition = definitions.get(row.name);
    const sourceTime = Date.parse(row.as_of);
    const fetchedTime = Date.parse(row.fetched_at);
    if (!row.entity_id || !row.source || !row.version) reason = "Missing identity, source or version";
    else if (!definition) reason = "Unknown feature name; schema version must be reviewed";
    else if ((keys.get(key) ?? 0) > 1) reason = "Duplicate feature natural key";
    else if (context.season !== undefined && row.season !== context.season) reason = "Feature season mismatch";
    else if (context.week !== undefined && row.week !== context.week) reason = "Feature week mismatch";
    else if (!Number.isFinite(sourceTime) || !Number.isFinite(fetchedTime)) reason = "Invalid provenance timestamp";
    else if (sourceTime > cutoff || fetchedTime > cutoff || sourceTime > now || fetchedTime > now) reason = "Future or post-cutoff feature would leak information";
    else if (fetchedTime < sourceTime) reason = "fetched_at precedes source as_of";
    else if (context.maxAgeHours !== undefined && now - sourceTime > context.maxAgeHours * 3_600_000) reason = "Stale feature";
    else if (row.value === null && !row.reason) reason = "Missing metric requires a reason";
    else if (row.value !== null && !Number.isFinite(row.value)) reason = "Non-finite metric";
    else if (row.value !== null && (definition.percent || /_share$|_rate$|^return_snap_limit$|^short_yardage_conversion$/.test(row.name)) && (row.value < 0 || row.value > 100)) reason = "Percentage must be in 0–100";
    else if (row.value !== null && binaryFeatures.has(row.name) && row.value !== 0 && row.value !== 1) reason = "Binary feature must be 0 or 1";
    else if (row.value !== null && (!definition.signed || /^(wind_mph|rain_mm|snow_mm|pace_seconds|total|expected_plays|expected_dropbacks)$/.test(row.name)) && row.value < 0) reason = "Negative count or unsigned metric";
    else if (row.estimated && !row.method) reason = "Estimated metric requires its method";
    if (reason) issues.push({ entity_id: row.entity_id, name: row.name, reason });
    else valid.push(row);
  }
  return { valid, issues };
}

/** Latest eligible observation; ties never silently merge competing provider values. */
export function selectFeature(rows: readonly Feature[], entityId: string, name: string, context: FeatureValidationContext): Feature | null {
  const priorities = { ...DEFAULT_SOURCE_PRIORITY, ...context.sourcePriority };
  const eligible = validateFeatureRows(rows, context).valid
    .filter((row) => row.entity_id === entityId && row.name === name && row.value !== null)
    .sort((a, b) => (priorities[a.source.toLowerCase()] ?? 100) - (priorities[b.source.toLowerCase()] ?? 100) || Date.parse(b.as_of) - Date.parse(a.as_of) || a.source.localeCompare(b.source));
  return eligible[0] ?? null;
}
