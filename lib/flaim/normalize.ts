import { externalSyncSchema, type ExternalSyncPayload } from "../schemas";
import { nflPeriod } from "../time";

type Row = Record<string, unknown>;

function object(value: unknown): Row {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Row : {};
}

function unwrap(value: unknown): Row {
  const row = object(value);
  return row.data && typeof row.data === "object" ? object(row.data) : row;
}

function first(row: Row, keys: string[]) {
  for (const key of keys) if (row[key] != null && row[key] !== "") return row[key];
  return undefined;
}

function text(value: unknown, fallback = "") {
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  if (value && typeof value === "object") {
    const row = object(value);
    const nested = first(row, ["abbreviation", "abbrev", "shortName", "name", "displayName", "id"]);
    if (nested != null) return String(nested).trim();
  }
  return fallback;
}

function number(value: unknown) {
  const result = Number(value);
  return Number.isFinite(result) ? result : undefined;
}

const fullTeamNames: Record<string, string> = {
  "ARIZONA CARDINALS": "ARI", "ATLANTA FALCONS": "ATL", "BALTIMORE RAVENS": "BAL", "BUFFALO BILLS": "BUF",
  "CAROLINA PANTHERS": "CAR", "CHICAGO BEARS": "CHI", "CINCINNATI BENGALS": "CIN", "CLEVELAND BROWNS": "CLE",
  "DALLAS COWBOYS": "DAL", "DENVER BRONCOS": "DEN", "DETROIT LIONS": "DET", "GREEN BAY PACKERS": "GB",
  "HOUSTON TEXANS": "HOU", "INDIANAPOLIS COLTS": "IND", "JACKSONVILLE JAGUARS": "JAX", "KANSAS CITY CHIEFS": "KC",
  "LAS VEGAS RAIDERS": "LV", "LOS ANGELES CHARGERS": "LAC", "LOS ANGELES RAMS": "LAR", "MIAMI DOLPHINS": "MIA",
  "MINNESOTA VIKINGS": "MIN", "NEW ENGLAND PATRIOTS": "NE", "NEW ORLEANS SAINTS": "NO", "NEW YORK GIANTS": "NYG",
  "NEW YORK JETS": "NYJ", "PHILADELPHIA EAGLES": "PHI", "PITTSBURGH STEELERS": "PIT", "SAN FRANCISCO 49ERS": "SF",
  "SEATTLE SEAHAWKS": "SEA", "TAMPA BAY BUCCANEERS": "TB", "TENNESSEE TITANS": "TEN", "WASHINGTON COMMANDERS": "WAS",
};

function array(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value && typeof value === "object") return Object.values(value as Row);
  return [];
}

function position(value: unknown): "QB" | "RB" | "WR" | "TE" | "DST" | "K" | undefined {
  const normalized = text(value).toUpperCase().replaceAll(".", "").replaceAll("/", "");
  if (normalized === "QB" || normalized === "RB" || normalized === "WR" || normalized === "TE" || normalized === "K") return normalized;
  if (["DST", "DEF", "D ST", "D/ST", "DEFENSE"].includes(normalized)) return "DST";
  return undefined;
}

function slot(value: unknown, fallback: string) {
  const raw = text(value).toUpperCase();
  const ids: Record<string, string> = { "0": "QB", "2": "RB", "4": "WR", "6": "TE", "16": "DST", "17": "K", "20": "Bench", "21": "IR" };
  if (ids[raw]) return ids[raw];
  if (!raw) return fallback;
  if (raw.includes("BENCH") || raw === "BE") return "Bench";
  if (raw.includes("RESERVE") || raw === "IR") return "IR";
  if (raw.includes("DEF")) return "DST";
  return raw.slice(0, 16);
}

function isoDate(value: unknown) {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
}

function mapPlayer(
  value: unknown,
  fallbackSlot: string,
  scope?: "platform_global" | "unavailable",
  capabilities?: Row,
) {
  const outer = object(value);
  const player = outer.player && typeof outer.player === "object" ? object(outer.player) : outer;
  const providerId = text(first(player, ["providerId", "playerId", "player_id", "id", "espnId"]));
  const name = text(first(player, ["name", "playerName", "fullName", "displayName"]));
  const playerPosition = position(first(player, ["position", "playerPosition", "defaultPosition", "positionAbbreviation"]));
  if (!providerId || !name || !playerPosition) return null;
  const rawTeam = text(first(player, ["proTeamAbbrev", "proTeam", "teamAbbreviation", "team", "teamAbbr"]), "UNK").toUpperCase();
  const team = rawTeam.length <= 4 ? rawTeam : fullTeamNames[rawTeam] ?? "UNK";
  const projection = number(first(player, ["projection", "projectedPoints", "projectedScore"]));
  const kickoff = isoDate(first(player, ["kickoff", "kickoffTime", "gameTime"]));
  const injury = text(first(player, ["injury", "injuryStatus"]));
  const ownedRaw = player.percentOwned !== undefined ? player.percentOwned : player.marketPercentOwned;
  const startedRaw = player.percentStarted !== undefined ? player.percentStarted : player.marketPercentStarted;
  const stateRaw = player.acquisitionState !== undefined ? player.acquisitionState : player.acquisition_state;
  const rawState = text(stateRaw).toLowerCase();
  const acquisitionState = rawState === "waivers" ? "waivers" : rawState === "free_agent" || rawState === "freeagent" ? "free_agent" : stateRaw === null ? null : undefined;
  const percentOwned = ownedRaw === null ? null : number(ownedRaw);
  const percentStarted = startedRaw === null ? null : number(startedRaw);
  const marketScope = scope ?? (text(first(player, ["ownershipScope", "marketScope"])) === "platform_global" ? "platform_global" : undefined);
  const waiverClearsAt = isoDate(first(player, ["waiverClearsAt", "waiverProcessDate"]));
  return {
    providerId,
    name,
    team: team.slice(0, 4) || "UNK",
    position: playerPosition,
    slot: slot(first(outer, ["slot", "lineupSlot", "lineupSlotName", "lineupSlotId"]) ?? first(player, ["slot", "lineupSlot", "lineupSlotName", "lineupSlotId"]), fallbackSlot),
    ...(projection == null ? {} : { projection }),
    ...(kickoff ? { kickoff } : {}),
    ...(injury ? { injury: injury.slice(0, 32) } : {}),
    ...(percentOwned !== undefined ? { percentOwned } : capabilities?.rosteredRate === false ? { percentOwned: null } : {}),
    ...(percentStarted !== undefined ? { percentStarted } : capabilities?.startedRate === false ? { percentStarted: null } : {}),
    ...(marketScope ? { marketScope } : {}),
    ...(acquisitionState !== undefined ? { acquisitionState } : capabilities?.acquisitionState === false ? { acquisitionState: null } : {}),
    ...(waiverClearsAt ? { waiverClearsAt } : {}),
  };
}

function rosterEntries(roster: Row) {
  const direct = first(roster, ["roster", "players", "entries"]);
  if (direct != null) return array(direct).map((row) => ({ row, fallbackSlot: "Bench" }));
  return [
    ...array(roster.starters).map((row) => ({ row, fallbackSlot: "Starter" })),
    ...array(roster.bench).map((row) => ({ row, fallbackSlot: "Bench" })),
    ...array(roster.reserve).map((row) => ({ row, fallbackSlot: "IR" })),
  ];
}

function toRecord(value: unknown) {
  const row = object(value);
  const wins = number(first(row, ["wins", "win", "winsCount"]));
  const losses = number(first(row, ["losses", "loss", "lossesCount"]));
  if (wins == null || losses == null) return undefined;
  const ties = number(first(row, ["ties", "tie"])) ?? 0;
  const rank = number(first(row, ["rank", "standing", "place"]));
  const pointsFor = number(first(row, ["pointsFor", "points_for", "points"]));
  const pointsAgainst = number(first(row, ["pointsAgainst", "points_against"]));
  return { wins, losses, ties, ...(rank && rank > 0 ? { rank } : {}), ...(pointsFor != null ? { pointsFor } : {}), ...(pointsAgainst != null ? { pointsAgainst } : {}) };
}

function scoring(info: Row) {
  const settings = object(info.scoringSettings);
  const explicitPoints = number(first(info, ["pointsPerReception", "receptionPoints"]))
    ?? number(first(settings, ["pointsPerReception", "receptionPoints"]));
  if (explicitPoints != null && explicitPoints >= 0) return { reception: explicitPoints };

  const kind = text(first(info, ["scoringType", "scoring"]), text(first(settings, ["scoringType", "type"]))).toLowerCase();
  if (/half[\s_-]?ppr|0\.5[\s_-]?ppr/.test(kind)) return { reception: 0.5 };
  if (/\bppr\b|points?[\s_-]?per[\s_-]?reception/.test(kind)) return { reception: 1 };
  if (/\bstandard\b|non[\s_-]?ppr/.test(kind)) return { reception: 0 };
  return undefined;
}

function currentWeek(info: Row) {
  const explicit = number(first(info, ["currentWeek", "currentMatchupPeriod", "matchupPeriod", "scoringPeriodId"]));
  if (explicit != null && explicit >= 1 && explicit <= 18) return Math.trunc(explicit);
  return nflPeriod(new Date()).week;
}

function matchupData(value: unknown, teamId: string) {
  const root = unwrap(value);
  const matchups = array(root.matchups);
  for (const candidate of matchups) {
    const matchup = object(candidate);
    const sides = ["home", "away", "team1", "team2", "homeTeam", "awayTeam"].map((key) => object(matchup[key])).filter((side) => Object.keys(side).length > 0);
    const own = sides.find((side) => text(first(side, ["teamId", "id", "team_id", "rosterId"])) === teamId);
    if (!own) continue;
    const other = sides.find((side) => side !== own);
    if (!other) continue;
    const opponentId = text(first(other, ["teamId", "id", "team_id", "rosterId"]));
    const opponentName = text(first(other, ["teamName", "name", "displayName"]), "Rival");
    const opponentRecord = toRecord(other.record ?? other);
    const opponentRoster = array(first(other, ["players", "roster"])).map((player) => mapPlayer(player, "Bench")).filter((player): player is NonNullable<typeof player> => player !== null);
    return {
      currentScore: number(first(own, ["score", "points", "totalPoints"])),
      opponent: {
        teamId: opponentId || "unknown",
        name: opponentName,
        ...(opponentRecord ? { record: opponentRecord } : {}),
        roster: opponentRoster,
      },
    };
  }
  return {};
}

function pendingWaiverMoves(value: unknown) {
  const transactions = array(unwrap(value).transactions);
  return transactions.flatMap((item) => {
    const transaction = object(item);
    const status = text(transaction.status).toLowerCase();
    if (!["pending", "processing", "queued", "unsubmitted"].some((part) => status.includes(part))) return [];
    const added = array(transaction.players_added).map(object)[0];
    const dropped = array(transaction.players_dropped).map(object)[0];
    const add = added ? text(first(added, ["name", "playerName"])) : "";
    const drop = dropped ? text(first(dropped, ["name", "playerName"])) : "";
    return [{
      kind: "waiver" as const,
      status: "pending" as const,
      ...(add ? { add } : {}),
      ...(drop ? { drop } : {}),
    }];
  }).filter((move) => Boolean(move.add || move.drop));
}

export function buildFlaimPayload(input: {
  league: unknown;
  leagueInfo: unknown;
  roster: unknown;
  freeAgents: unknown;
  matchups?: unknown;
  transactions?: unknown;
  fetchedAt?: string;
}): ExternalSyncPayload {
  const league = unwrap(input.league);
  const info = unwrap(input.leagueInfo);
  const rosterData = unwrap(input.roster);
  const availableData = unwrap(input.freeAgents);
  const capabilities = object(availableData.capabilities);
  const marketScopeValue = availableData.ownershipScope;
  const marketScope = marketScopeValue === "platform_global" || marketScopeValue === "unavailable" ? marketScopeValue : undefined;
  const leagueId = text(first(league, ["leagueId", "id", "league_id"]), text(first(info, ["leagueId", "id"])));
  const season = number(first(league, ["seasonYear", "season_year", "season"])) ?? number(first(info, ["seasonYear", "season", "seasonId"])) ?? nflPeriod(new Date()).season;
  const week = currentWeek(info);
  const roster = rosterEntries(rosterData).map((entry) => mapPlayer(entry.row, entry.fallbackSlot)).filter((player): player is NonNullable<typeof player> => player !== null);
  if (roster.length === 0) throw new Error("Flaim no devolvió jugadores identificables para tu roster.");
  const availableRows = first(availableData, ["freeAgents", "players", "availablePlayers"]);
  const freeAgents = array(availableRows).map((row) => mapPlayer(row, "FA", marketScope, capabilities)).filter((player): player is NonNullable<typeof player> => player !== null);
  const teamRecord = toRecord(rosterData.record ?? rosterData);
  const teamId = text(first(league, ["teamId", "team_id"]), text(first(rosterData, ["teamId", "team_id", "rosterId"])));
  const matchup = matchupData(input.matchups, teamId);
  const pendingMoves = pendingWaiverMoves(input.transactions);
  const payload = {
    league: {
      name: text(first(league, ["leagueName", "name"]), text(first(info, ["name", "leagueName"]), "ESPN Fantasy League")),
      ...(leagueId ? { leagueId } : {}),
      ...(teamId ? { teamId } : {}),
      season,
      week,
      teamCount: number(first(info, ["teamCount", "numTeams", "size", "totalRosters"])) ?? number(first(league, ["teamCount", "numTeams"])),
      scoring: scoring(info),
    },
    roster,
    freeAgents,
    ...(teamRecord ? { teamRecord } : {}),
    ...(matchup.opponent ? { opponent: matchup.opponent } : {}),
    ...(matchup.currentScore != null ? { currentScore: matchup.currentScore } : {}),
    ...(pendingMoves.length ? { pendingMoves } : {}),
    source: "flaim" as const,
    sourceTimestamp: input.fetchedAt ?? new Date().toISOString(),
    fetchedAt: input.fetchedAt ?? new Date().toISOString(),
  };
  return externalSyncSchema.parse(payload);
}

export function pickFootballEspnLeague(sessionValue: unknown) {
  const session = unwrap(sessionValue);
  const leagues = array(session.allLeagues ?? session.leagues);
  const candidates = leagues.filter((item) => {
    const league = object(item);
    return text(league.platform).toLowerCase() === "espn" && text(league.sport).toLowerCase() === "football";
  });
  const defaultLeague = object(session.defaultLeague);
  const preferredId = text(first(defaultLeague, ["leagueId", "id"]));
  const selected = candidates.find((item) => text(first(object(item), ["leagueId", "id"])) === preferredId) ?? candidates[0];
  if (!selected) throw new Error("No encontré una liga de ESPN Fantasy Football en la cuenta conectada.");
  if (candidates.length > 1 && !preferredId) throw new Error("Flaim tiene más de una liga de ESPN Football. Configura tu liga predeterminada en Flaim y vuelve a intentar.");
  return object(selected);
}
