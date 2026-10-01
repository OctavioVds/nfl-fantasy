import { loadFlaimConnection, saveFlaimConnection } from "./storage";
import { refreshFlaimTokens } from "./oauth";
import { FlaimMcpClient } from "./mcp";
import { buildFlaimPayload, pickFootballEspnLeague } from "./normalize";
import type { ExternalSyncPayload } from "../schemas";

async function connectedTokens() {
  let tokens = await loadFlaimConnection();
  if (!tokens) throw new Error("Conecta Flaim para importar tu liga.");
  if (tokens.expiresAt && tokens.expiresAt <= Date.now() + 60_000) {
    tokens = await refreshFlaimTokens(tokens);
    await saveFlaimConnection(tokens);
  }
  return tokens;
}

export async function fetchFlaimLeagueSnapshot(): Promise<ExternalSyncPayload> {
  const client = new FlaimMcpClient(await connectedTokens());
  await client.initialize();
  const session = await client.callTool("get_user_session");
  const league = pickFootballEspnLeague(session);
  const leagueId = String(league.leagueId ?? league.id ?? "");
  if (!leagueId) throw new Error("Flaim no devolvió la liga seleccionada.");
  const platform = String(league.platform || "espn").toLowerCase();
  const sport = String(league.sport || "football").toLowerCase();
  const seasonYear = Number(league.seasonYear ?? league.season_year ?? league.season);
  const teamId = league.teamId ?? league.team_id;
  const sharedArguments: Record<string, unknown> = {
    league_id: leagueId,
    platform,
    sport,
    ...(Number.isInteger(seasonYear) ? { season_year: seasonYear } : {}),
  };
  const leagueInfo = await client.callTool("get_league_info", sharedArguments).catch(() => league);
  const rosterArguments = { ...sharedArguments, ...(teamId == null ? {} : { team_id: String(teamId) }) };
  const info = leagueInfo && typeof leagueInfo === "object" ? leagueInfo as Record<string, unknown> : {};
  const week = Number(info.currentWeek ?? info.currentMatchupPeriod ?? info.scoringPeriodId);
  const matchupArguments = teamId != null && Number.isInteger(week) && week >= 1
    ? { ...sharedArguments, team_id: String(teamId), detail: "players", week }
    : Number.isInteger(week) && week >= 1 ? { ...sharedArguments, week } : sharedArguments;
  await client.listTools();
  const [rosterResult, freeAgentsResult, matchupResult, transactionsResult] = await Promise.allSettled([
    client.callTool("get_roster", rosterArguments),
    client.callTool("get_free_agents", { ...sharedArguments, count: 100 }),
    client.callTool("get_matchups", matchupArguments),
    client.callTool("get_transactions", { ...sharedArguments, type: "waiver" }),
  ]);
  if (rosterResult.status === "rejected") throw rosterResult.reason;
  const roster = rosterResult.value;
  const freeAgents = freeAgentsResult.status === "fulfilled" ? freeAgentsResult.value : { freeAgents: [] };
  let matchups = matchupResult.status === "fulfilled" ? matchupResult.value : undefined;
  if (!matchups && teamId != null) {
    const summaryArguments = Number.isInteger(week) && week >= 1 ? { ...sharedArguments, week } : sharedArguments;
    matchups = await client.callTool("get_matchups", summaryArguments).catch(() => undefined);
  }
  const transactions = transactionsResult.status === "fulfilled" ? transactionsResult.value : undefined;
  return buildFlaimPayload({ league, leagueInfo, roster, freeAgents, matchups, transactions, fetchedAt: new Date().toISOString() });
}
