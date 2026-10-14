import { getCoreRun } from "./store";
export { getBacktest } from "./backtest";
import type { CoreRun } from "./run";

export function coreRunFresh(run: Pick<CoreRun, "source_as_of"> | null, now = Date.now()): boolean {
  const source = Date.parse(run?.source_as_of ?? "");
  return Number.isFinite(source) && source <= now && now - source <= 86400000;
}
export function publishedRun(run: CoreRun | null, now = Date.now()): CoreRun | null {
  if (!run || coreRunFresh(run, now)) return run;
  return {...run,status:"BLOCKED",players:[],projections:[],availability:[],anomalies:[],signals:[],matchups:[],gate:{accepted:false,reason:"Los datos de liga están vencidos o tienen fecha inválida; importa una consulta actual."}};
}

export async function getProjection(playerId: string, week: number, scenario = "base", scope?: string) {
  const run = await getCoreRun(scope);
  const projection = run?.projections.find((row) => row.player_id === playerId && row.week === week && row.scenario === scenario);
  if (!projection) return { projection: null, reason: "Projection not computed for this player/week/scenario" };
  if (!coreRunFresh(run)) return { projection: null, reason: "Stored league evidence is stale or has invalid timestamps" };
  return { projection, reason: projection.reason };
}
