import { getCoreInput, getModel } from "../store";
import { scoringHash } from "../scoring";

/** Reads offline temporal validation; runtime recalculation never invents accuracy. */
export async function getBacktest(scope?: string) {
  const input = await getCoreInput(scope);
  const artifact = await getModel(input?.scoring ? scoringHash(input.scoring) : null);
  return artifact ? { model_version: artifact.version, metrics: artifact.metrics, gate: artifact.gate, training_cutoff: artifact.training_cutoff, seed: artifact.seed, reason: null } : { model_version: null, metrics: null, gate: { accepted: false, reason: "No real historical dataset and accepted temporal backtest available" }, reason: "No real historical dataset and accepted temporal backtest available" };
}
