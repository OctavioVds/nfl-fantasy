import { createHash } from "node:crypto";
import type { ExternalSyncPayload } from "./schemas";

function sortPlayers<T extends { providerId: string }>(players: T[]) {
  return [...players].sort((a, b) => a.providerId.localeCompare(b.providerId));
}

export function leagueDataVersion(payload: ExternalSyncPayload) {
  const stable = {
    ...payload,
    sourceTimestamp: undefined,
    fetchedAt: undefined,
    roster: sortPlayers(payload.roster),
    freeAgents: sortPlayers(payload.freeAgents),
    opponent: payload.opponent ? { ...payload.opponent, roster: sortPlayers(payload.opponent.roster) } : undefined,
    nextOpponent: payload.nextOpponent ? { ...payload.nextOpponent, roster: sortPlayers(payload.nextOpponent.roster) } : undefined,
    tradePartners: payload.tradePartners?.map((partner) => ({ ...partner, roster: sortPlayers(partner.roster) })).sort((a, b) => a.teamId.localeCompare(b.teamId)),
  };
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}
