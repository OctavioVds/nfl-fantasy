import { serverEnv } from "../env";
import type { RosterPlayer } from "../types";
import { getCoreRun } from "./store";
import { validDistribution } from "./projection";

export async function applyCoreProjections(players: RosterPlayer[], context: { scope: string; season: number; week: number; dataAsOf: string }): Promise<RosterPlayer[]> {
  if (serverEnv().USE_PREDICTIVE_CORE === "false") return players;
  let run;
  try { run = await getCoreRun(context.scope); } catch { return players; }
  if (!run?.gate.accepted || run.season !== context.season || run.week !== context.week || run.source_as_of !== context.dataAsOf || Date.now() - Date.parse(run.source_as_of) > 24 * 3600000) return players;
  const byId = new Map(run.projections.filter((projection) => projection.scenario === "base").map((projection) => [projection.player_id, projection]));
  return players.map((player) => {
    const projection = byId.get(player.canonicalPlayerId);
    if (!projection?.eligible || !validDistribution(projection) || projection.mean == null || projection.p10 == null || projection.p50 == null || projection.p90 == null || projection.prob_play == null) return player;
    // Mean is already unconditional for the artifact's target; do not multiply by prob_play again.
    return { ...player, projection: projection.mean, floor: projection.p10, ceiling: projection.p90, coreProjection: projection,
      futureProjection: projection.ros_mean ?? player.futureProjection,
      coreAnomalies: run.anomalies.filter((anomaly) => anomaly.player_id === player.canonicalPlayerId),
      decisionProfile: { ...player.decisionProfile!, floor: projection.p10, median: projection.mean, ceiling: projection.p90, confidence: projection.confidence, projectionAvailable: true, estimated: true, method: projection.method, hiddenFactor: [...projection.drivers].sort((a, b) => Math.abs(b.contribution ?? 0) - Math.abs(a.contribution ?? 0))[0]?.text ?? "Predictive Core", missing: projection.missing } };
  });
}
