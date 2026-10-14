import type { Evidence, SocialSignal, SourcePolicy } from "../schema";

/** Curated identities, not extraction permission. Reliability stays null until measured. */
export const NFL_SOURCE_POLICIES: readonly SourcePolicy[] = [
  { id: "nfl-official-injuries", url: "https://www.nfl.com/injuries/", tier: "official", reliability: null, version: "source-policy-v1", permitted: false },
];

export interface SignalConfig {
  asOf: string; halfLifeHours?: number; maxAgeHours?: number; reliableThreshold?: number;
  /** Learned signed point effect by kind, never populated from a rumor. */
  calibratedMeanEffect?: Record<string, number>; maxAbsoluteMeanEffect?: number;
}
export interface EvaluatedSignal {
  id: string; player_id: string | null; team_id: string | null; kind: string; summary: string;
  label: "RUMOR" | "CONFIRMADO" | "EXCLUIDO"; usable: boolean;
  source_id: string; reliability: number | null; policy_version: string | null;
  decay: number; uncertainty_score: number | null; mean_delta: number;
  evidence: Evidence; estimated: true; method: string; reason: string | null;
}

export function evaluateSignals(signals: readonly SocialSignal[], policies: readonly SourcePolicy[], config: SignalConfig): EvaluatedSignal[] {
  const now = Date.parse(config.asOf);
  const halfLife = config.halfLifeHours ?? 24;
  const maxAge = config.maxAgeHours ?? 72;
  const reliableThreshold = config.reliableThreshold ?? 80;
  const cap = config.maxAbsoluteMeanEffect ?? 2;
  if (!Number.isFinite(now) || !(halfLife > 0) || !(maxAge > 0) || !(cap >= 0) || reliableThreshold < 0 || reliableThreshold > 100) throw new Error("Invalid signal configuration");
  const byId = new Map(policies.map((policy) => [policy.id, policy]));
  const duplicatePolicies = byId.size !== policies.length;
  const seen = new Set<string>();
  return signals.map((signal) => {
    const policy = byId.get(signal.source_id);
    const second = signal.second_source_id ? byId.get(signal.second_source_id) : null;
    const ts = Date.parse(signal.ts);
    const evidenceTime = Date.parse(signal.evidence.as_of);
    const fetchedTime = Date.parse(signal.evidence.fetched_at);
    const age = (now - ts) / 3_600_000;
    let reason: string | null = null;
    if (seen.has(signal.id)) reason = "Duplicate signal ID";
    else if (duplicatePolicies) reason = "Duplicate source policies require review";
    else if (!policy || !policy.permitted) reason = "Source absent from permitted versioned whitelist";
    else if (signal.player_id === null && signal.team_id === null) reason = "Signal has no canonical player or team ID";
    else if (!Number.isFinite(ts) || !Number.isFinite(evidenceTime) || !Number.isFinite(fetchedTime) || age < 0 || evidenceTime > now || fetchedTime > now || fetchedTime < evidenceTime || fetchedTime < ts) reason = "Invalid or future signal provenance";
    else if (age > maxAge || now - evidenceTime > maxAge * 3_600_000) reason = "Signal is stale";
    seen.add(signal.id);
    const decay = reason === null ? Math.pow(2, -age / halfLife) : 0;
    const twoReliable = !!policy && !!second && second.permitted && second.id !== policy.id && second.url !== policy.url
      && policy.reliability !== null && second.reliability !== null && policy.reliability >= reliableThreshold && second.reliability >= reliableThreshold;
    const confirmed = reason === null && signal.confirmed && (policy?.tier === "official" || twoReliable);
    const learned = config.calibratedMeanEffect?.[signal.kind];
    const meanDelta = confirmed && learned !== undefined && Number.isFinite(learned) ? Math.max(-cap, Math.min(cap, learned * decay)) : 0;
    const reliability = policy?.reliability ?? null;
    return {
      id: signal.id, player_id: signal.player_id, team_id: signal.team_id, kind: signal.kind, summary: signal.summary,
      label: reason !== null ? "EXCLUIDO" : confirmed ? "CONFIRMADO" : "RUMOR", usable: reason === null,
      source_id: signal.source_id, reliability, policy_version: policy?.version ?? null,
      decay, uncertainty_score: reason === null && !confirmed && reliability !== null ? reliability * decay : null,
      mean_delta: meanDelta, evidence: signal.evidence, estimated: true,
      method: "Versioned permitted source policy; official or two distinct reliable confirmations; exponential half-life; mean effect only from supplied calibrated coefficient with absolute cap",
      reason: reason ?? (!confirmed ? "Unconfirmed information only flags uncertainty, never changes the projected mean" : learned === undefined ? "Confirmed signal; calibrated mean effect unavailable" : null),
    };
  });
}
