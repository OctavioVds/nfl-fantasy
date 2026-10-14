import { neon } from "@neondatabase/serverless";
import { serverEnv } from "../env";
import { artifactSchema, coreInputSchema, type CoreInput, type ModelArtifact } from "./schema";
import type { CoreRun } from "./run";
import type { Projection } from "./schema";

const memoryInputs = new Map<string, CoreInput>();
const memoryRuns = new Map<string, CoreRun>();
const database = () => serverEnv().DATABASE_URL;
/** Future horizons must obey the same source freshness and cutoff as this run. */
export function verifyFutureProjection(row: Projection, cutoff: string): Projection {
  const time = Date.parse(cutoff), asOf = Date.parse(row.as_of), fetched = Date.parse(row.fetched_at);
  if (Number.isFinite(time) && Number.isFinite(asOf) && Number.isFinite(fetched) && asOf <= fetched && fetched <= time && time - asOf <= 24 * 60 * 60 * 1000) return row;
  const reason = "Future forecast is stale or has invalid source timestamps at this run cutoff";
  return { ...row, eligible: false, reason, missing: [...row.missing, reason] };
}
export async function getFutureProjections(scope: string, season: number, week: number, cutoff: string): Promise<Projection[]> {
  const url = database();
  if (!url) return [...memoryRuns.values()].filter((run) => run.scope === scope && run.season === season && run.week > week && run.created_at <= cutoff).flatMap((run) => run.projections.filter((row) => row.scenario === "base").map((row) => verifyFutureProjection(row, cutoff)));
  // Preserve ties at the latest source timestamp so horizon validation can reject contradictory forecasts.
  const rows = await neon(url)`select payload from (select payload,dense_rank() over(partition by player_id,week order by (payload->>'as_of')::timestamptz desc) as source_rank from player_projections where scope=${scope} and season=${season} and week>${week} and scenario='base' and created_at<=${cutoff}::timestamptz) forecasts where source_rank=1`;
  return rows.map((row) => verifyFutureProjection(row.payload as Projection, cutoff));
}
export async function getCoreInput(scope?: string): Promise<CoreInput | null> {
  const url = database();
  if (!url) return scope ? memoryInputs.get(scope) ?? null : [...memoryInputs.values()].at(-1) ?? null;
  const sql = neon(url);
  const rows = scope ? await sql`select payload from core_inputs where scope=${scope} limit 1` : await sql`select payload from core_inputs order by updated_at desc limit 1`;
  const parsed = coreInputSchema.safeParse(rows[0]?.payload);
  return parsed.success ? parsed.data : null;
}
export async function getModel(scoringHash: string | null): Promise<ModelArtifact | null> {
  const url = database();
  if (!url || !scoringHash) return null;
  const rows = await neon(url)`select payload from model_registry where scoring_hash=${scoringHash} order by trained_at desc limit 1`;
  const parsed = artifactSchema.safeParse(rows[0]?.payload);
  return parsed.success ? parsed.data : null;
}
export async function getCoreRun(scope?: string, runId?: string): Promise<CoreRun | null> {
  const url = database();
  if (!url) return runId ? memoryRuns.get(runId) ?? null : [...memoryRuns.values()].filter((row) => !scope || row.scope === scope).at(-1) ?? null;
  const sql = neon(url);
  const rows = runId ? await sql`select payload from core_runs where run_id=${runId} limit 1` : scope ? await sql`select payload from core_runs where scope=${scope} order by created_at desc limit 1` : await sql`select payload from core_runs order by created_at desc limit 1`;
  return rows[0]?.payload as CoreRun ?? null;
}

/** Single transaction: verifier output and inputs appear atomically. JSON recordsets avoid N player roundtrips. */
export async function saveCoreRun(input: CoreInput, run: CoreRun, validFeatures = input.features): Promise<"memory" | "neon"> {
  const url = database();
  if (!url) { memoryInputs.set(input.scope, input); memoryRuns.set(run.run_id, run); return "memory"; }
  const sql = neon(url);
  const json = (value: unknown) => JSON.stringify(value);
  await sql.transaction([
    sql`insert into core_inputs(scope,payload) values(${input.scope},${json(input)}::jsonb) on conflict(scope) do update set payload=excluded.payload,updated_at=now()`,
    sql`insert into core_runs(run_id,scope,season,week,input_digest,model_version,status,payload,created_at) values(${run.run_id},${run.scope},${run.season},${run.week},${run.input_digest},${run.model_version},${run.status},${json(run)}::jsonb,${run.created_at}) on conflict(run_id) do nothing`,
    sql`insert into features(scope,entity_id,season,week,name,value,source,as_of,fetched_at,version,estimated,method,reason)
      select ${input.scope},x.entity_id,x.season,x.week,x.name,x.value,x.source,x.as_of,x.fetched_at,x.version,x.estimated,x.method,x.reason
      from jsonb_to_recordset(${json(validFeatures)}::jsonb) as x(entity_id text,season int,week int,name text,value double precision,source text,as_of timestamptz,fetched_at timestamptz,version text,estimated boolean,method text,reason text)
      on conflict(scope,entity_id,season,week,name,source,as_of,version) do update set value=excluded.value,fetched_at=excluded.fetched_at,reason=excluded.reason,method=excluded.method`,
    sql`insert into player_projections(run_id,scope,player_id,season,week,scenario,mean,sd,p10,p50,p90,prob_play,confidence,model_version,created_at,payload)
      select ${run.run_id},${run.scope},x->>'player_id',${run.season},${run.week},x->>'scenario',(x->>'mean')::double precision,(x->>'sd')::double precision,(x->>'p10')::double precision,(x->>'p50')::double precision,(x->>'p90')::double precision,(x->>'prob_play')::double precision,(x->>'confidence')::double precision,x->>'model_version',${run.created_at}::timestamptz,x from jsonb_array_elements(${json(run.projections)}::jsonb) as x on conflict(run_id,player_id,scenario) do nothing`,
    sql`insert into player_roles(scope,player_id,season,week,as_of,payload) select ${run.scope},x->>'player_id',${run.season},${run.week},(x->'evidence'->>'as_of')::timestamptz,x from jsonb_array_elements(${json(input.roles)}::jsonb) x on conflict do nothing`,
    sql`insert into teammate_splits(scope,a_id,b_id,metric,as_of,payload) select ${run.scope},x->>'a_id',x->>'b_id',x->>'metric',(x->'evidence'->>'as_of')::timestamptz,x from jsonb_array_elements(${json(input.splits)}::jsonb) x on conflict do nothing`,
    sql`insert into availability_scenarios(scope,season,week,team_id,scenario,probability,as_of,payload) select ${run.scope},${run.season},${run.week},x->>'team_id',x->>'id',(x->>'probability')::double precision,(x->'evidence'->>'as_of')::timestamptz,x from jsonb_array_elements(${json(input.scenarios)}::jsonb) x on conflict do nothing`,
    sql`insert into waiver_anomalies(run_id,player_id,signal,strength,payload) select ${run.run_id},x->>'player_id',x->>'signal',(x->>'strength')::double precision,x from jsonb_array_elements(${json(run.anomalies)}::jsonb) x on conflict do nothing`,
    sql`insert into social_signals(scope,signal_id,ts,payload) select ${run.scope},x->>'id',(x->>'ts')::timestamptz,x from jsonb_array_elements(${json(input.signals)}::jsonb) x on conflict(scope,signal_id) do update set payload=excluded.payload,ts=excluded.ts`,
    sql`insert into defense_adjusted(scope,season,week,team_id,position,alignment,as_of,payload) select ${run.scope},${run.season},${run.week},x->>'defense_team_id',x->>'position',(x->>'alignment')||':'||(x->>'phase'),${run.created_at}::timestamptz,x from jsonb_array_elements(${json(run.matchups)}::jsonb) x on conflict do nothing`,
    sql`insert into source_policies(scope,source_id,version,payload) select ${run.scope},x->>'id',x->>'version',x from jsonb_array_elements(${json(input.policies)}::jsonb) x on conflict do nothing`,
    sql`insert into data_quality_log(run_id,issue_key,payload) select ${run.run_id},ordinality::text,value from jsonb_array_elements(${json(run.quality)}::jsonb) with ordinality on conflict do nothing`,
  ]);
  return "neon";
}
