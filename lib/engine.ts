import type { PlayerProjection, Recommendation, RosterPlayer, TradePartner } from "./types";

export function pprPoints(input: {
  passYards?: number; passTd?: number; interceptions?: number;
  rushYards?: number; rushTd?: number; receptions?: number;
  recYards?: number; recTd?: number; fumblesLost?: number;
}) {
  return (input.passYards ?? 0) / 25 + (input.passTd ?? 0) * 4 - (input.interceptions ?? 0) * 2 +
    (input.rushYards ?? 0) / 10 + (input.rushTd ?? 0) * 6 + (input.receptions ?? 0) +
    (input.recYards ?? 0) / 10 + (input.recTd ?? 0) * 6 - (input.fumblesLost ?? 0) * 2;
}

export function canonicalPlayerId(name: string, team?: string) {
  return `${name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "")}${team ? `-${team.toLowerCase()}` : ""}`;
}

export function aggregateProjections(projections: PlayerProjection[]) {
  if (!projections.length) return null;
  const unique = new Map(projections.map((p) => [p.source, p]));
  const values = [...unique.values()].map((p) => p.points).sort((a, b) => a - b);
  const median = values.length % 2 ? values[(values.length - 1) / 2] : (values[values.length / 2 - 1] + values[values.length / 2]) / 2;
  const floor = Math.min(...values.map((v) => v * 0.7));
  const ceiling = Math.max(...values.map((v) => v * 1.3));
  return { median: round(median), floor: round(floor), ceiling: round(ceiling), sources: values.length };
}

export function optimizeLineup(players: RosterPlayer[]) {
  const slots = ["QB", "RB", "RB", "WR", "WR", "TE", "RB/WR", "DST", "K"];
  const used = new Set<string>();
  const result: RosterPlayer[] = [];
  const eligible = (player: RosterPlayer, slot: string) => player.position === slot || (slot === "RB/WR" && ["RB", "WR"].includes(player.position));

  for (const slot of slots) {
    const locked = players.find((p) => p.locked && p.slot === slot && !used.has(p.canonicalPlayerId));
    if (!locked) continue;
    used.add(locked.canonicalPlayerId);
    result.push({ ...locked, slot });
  }
  for (const slot of slots) {
    const occupied = result.filter((p) => p.slot === slot).length;
    const needed = slots.filter((candidate) => candidate === slot).length;
    if (occupied >= needed) continue;
    const candidate = players
      .filter((p) => !p.locked && p.slot !== "IR" && !used.has(p.canonicalPlayerId) && eligible(p, slot))
      .sort((a, b) => (b.projection ?? -1) - (a.projection ?? -1))[0];
    if (!candidate) continue;
    used.add(candidate.canonicalPlayerId);
    result.push({ ...candidate, slot });
  }
  return result;
}

export function simulateWin(myMedian: number, oppMedian: number, iterations = 5000, seed = 42) {
  let state = seed >>> 0;
  const random = () => ((state = (1664525 * state + 1013904223) >>> 0) / 4294967296);
  const normal = () => Math.sqrt(-2 * Math.log(Math.max(random(), 1e-9))) * Math.cos(2 * Math.PI * random());
  let wins = 0;
  for (let i = 0; i < iterations; i++) if (myMedian + normal() * 16 > oppMedian + normal() * 16) wins++;
  return Math.round((wins / iterations) * 100);
}

export function topLineupRecommendations(players: RosterPlayer[]): Recommendation[] {
  const optimized = optimizeLineup(players);
  const current = players.filter((p) => !["Bench", "IR"].includes(p.slot));
  const moves: Recommendation[] = [];
  for (const starter of optimized) {
    if (current.some((p) => p.canonicalPlayerId === starter.canonicalPlayerId) || starter.locked) continue;
    const replacement = current.filter((p) => !p.locked && (p.position === starter.position || (["RB", "WR"].includes(p.position) && ["RB", "WR"].includes(starter.position))))
      .sort((a, b) => (a.projection ?? 99) - (b.projection ?? 99))[0];
    if (!replacement || (starter.projection ?? 0) <= (replacement.projection ?? 0)) continue;
    const delta = round((starter.projection ?? 0) - (replacement.projection ?? 0));
    moves.push({
      id: `start-${starter.canonicalPlayerId}`,
      kind: "START",
      headline: `START ${starter.name} sobre ${replacement.name}`,
      target: starter.name,
      alternative: replacement.name,
      confidence: delta >= 3 ? "HIGH" : "MEDIUM",
      confidenceScore: Math.min(9, Math.max(5, Math.round(5 + delta / 2))),
      risk: "Las proyecciones son estimaciones; noticias tardías pueden cambiar el papel.",
      why: [{ type: "MODEL", text: `Ventaja mediana estimada: +${delta} puntos PPR.` }],
      actionable: true,
      priority: 1,
    });
  }
  return moves.slice(0, 3);
}

export function rosterManagementRecommendations(players: RosterPlayer[]): Recommendation[] {
  const actions: Recommendation[] = [];
  const quarterbacks = players
    .filter((p) => p.position === "QB" && p.slot !== "IR" && !p.locked)
    .sort((a, b) => (b.projection ?? 0) - (a.projection ?? 0));
  if (quarterbacks.length > 1) {
    const backup = quarterbacks[quarterbacks.length - 1];
    actions.push({
      id: `trade-${backup.canonicalPlayerId}`,
      kind: "TRADE",
      headline: `BUSCAR TRADE por ${backup.name} antes de cortarlo`,
      target: backup.name,
      confidence: "HIGH",
      confidenceScore: 8,
      risk: "El retorno depende de la necesidad de QB de los rivales; conserva al jugador si no recibes valor útil.",
      why: [
        { type: "FACT", text: "La liga utiliza un solo QB titular." },
        { type: "INFERENCE", text: "Un segundo QB con valor de mercado aporta menos a tu alineación semanal que profundidad en RB o WR." },
      ],
      actionable: true,
      priority: 4,
    });
  }
  for (const player of players.filter((p) => p.injury && /^(Q|QUESTIONABLE|D|DOUBTFUL|O|OUT)$/i.test(p.injury))) {
    actions.push({
      id: `watch-${player.canonicalPlayerId}`,
      kind: "WATCH",
      headline: `VIGILAR estado de ${player.name} antes del kickoff`,
      target: player.name,
      confidence: "HIGH",
      confidenceScore: 9,
      risk: "La designación oficial puede cambiar durante la semana.",
      why: [{ type: "FACT", text: `${player.name} figura con designación ${player.injury}.` }],
      actionable: true,
      priority: 2,
    });
  }
  return actions;
}

export function playerValue(player: RosterPlayer, roster: RosterPlayer[]) {
  const weekly = player.projection ?? 0;
  const future = player.futureProjection ?? weekly;
  const opportunity = (player.opportunityScore ?? 50) / 20;
  const scarcity = player.position === "RB" ? 2 : player.position === "WR" ? 1.5 : player.position === "TE" ? 1 : 0;
  const injury = /^(O|OUT|D|DOUBTFUL|IR)$/i.test(player.injury ?? "") ? -6 : /^(Q|QUESTIONABLE)$/i.test(player.injury ?? "") ? -1 : 0;
  const depth = player.depthOrder ? Math.max(-2, 2 - player.depthOrder) : 0;
  const qbPenalty = player.position === "QB" && roster.filter((p) => p.position === "QB").length >= 2 ? -3 : 0;
  return weekly * 0.55 + future * 0.3 + opportunity + scarcity + depth + injury + qbPenalty;
}

export function waiverRecommendations(roster: RosterPlayer[], freeAgents: RosterPlayer[]): Recommendation[] {
  const dropPool = roster.filter((p) => p.slot === "Bench" && !p.locked);
  if (!dropPool.length || !freeAgents.length) return [];
  const quarterbackCount = roster.filter((p) => p.position === "QB" && p.slot !== "IR").length;

  const ranked = freeAgents.filter((candidate) => !(candidate.position === "QB" && quarterbackCount >= 2)).map((candidate) => {
    const specialTeamsReplacement = ["DST", "K"].includes(candidate.position)
      ? roster.filter((p) => p.position === candidate.position && !p.locked)
      : [];
    const compatible = dropPool.filter((p) => p.position === candidate.position);
    const pool = specialTeamsReplacement.length ? specialTeamsReplacement : compatible.length ? compatible : dropPool;
    const drop = [...pool].sort((a, b) => playerValue(a, roster) - playerValue(b, roster))[0];
    const candidateValue = playerValue(candidate, roster);
    const dropValue = playerValue(drop, roster);
    const net = round(candidateValue - dropValue);
    const dataSignals = [candidate.projection, candidate.futureProjection, candidate.opportunityScore, candidate.depthOrder].filter((v) => v != null).length;
    const confidenceScore = Math.min(9, Math.max(4, Math.round(4 + Math.max(0, net) / 1.5 + dataSignals / 2)));
    return { candidate, drop, net, candidateValue, confidenceScore };
  }).filter((row) => row.net >= 1).sort((a, b) => b.net - a.net
    || (b.candidate.opportunityScore ?? 0) - (a.candidate.opportunityScore ?? 0)
    || (b.candidate.futureProjection ?? 0) - (a.candidate.futureProjection ?? 0));
  const selected = [] as typeof ranked;
  for (const row of ranked) {
    if (!selected.some((item) => item.candidate.position === row.candidate.position)) selected.push(row);
    if (selected.length === 3) break;
  }
  for (const row of ranked) {
    if (selected.length === 18) break;
    if (!selected.includes(row)) selected.push(row);
  }
  return selected.map(({ candidate, drop, net, confidenceScore }, index) => ({
      id: `add-${candidate.canonicalPlayerId}-drop-${drop.canonicalPlayerId}`,
      kind: "ADD" as const,
      headline: `ADD ${candidate.name} · DROP ${drop.name}`,
      target: candidate.name,
      alternative: drop.name,
      confidence: confidenceScore >= 8 ? "HIGH" as const : confidenceScore >= 6 ? "MEDIUM" as const : "LOW" as const,
      confidenceScore,
      risk: "La disponibilidad y el papel pueden cambiar antes de procesar waivers; confirma noticias cercanas al cierre.",
      why: [
        { type: "FACT" as const, text: `${candidate.name} fue confirmado disponible por la fuente de la liga.` },
        { type: "MODEL" as const, text: `Ganancia de valor estimada sobre ${drop.name}: +${net}.` },
        ...(candidate.opportunityScore != null ? [{ type: "INFERENCE" as const, text: `Opportunity score normalizado: ${candidate.opportunityScore}/100.` }] : []),
      ],
      actionable: true,
      priority: 3 + index / 100,
    }));
}

export function tradeRecommendations(roster: RosterPlayer[], partners: TradePartner[]): Recommendation[] {
  const myStarters = new Set(optimizeLineup(roster).map((p) => p.canonicalPlayerId));
  const offers = roster.filter((p) => !p.locked && p.slot !== "IR" && !myStarters.has(p.canonicalPlayerId));
  const myPositionCounts = new Map(["RB", "WR", "TE"].map((position) => [position, roster.filter((p) => p.position === position && p.slot !== "IR").length]));
  const candidates: { give: RosterPlayer; receive: RosterPlayer; partner: TradePartner; fit: number; gap: number }[] = [];

  for (const partner of partners) {
    const theirStarters = new Set(optimizeLineup(partner.roster).map((p) => p.canonicalPlayerId));
    const targets = partner.roster.filter((p) => !p.locked && p.slot !== "IR" && !theirStarters.has(p.canonicalPlayerId) && ["RB", "WR", "TE"].includes(p.position));
    for (const give of offers) for (const receive of targets) {
      if (receive.position === "TE" && (myPositionCounts.get("TE") ?? 0) >= 2) continue;
      if (receive.position === "WR" && (myPositionCounts.get("WR") ?? 0) >= 5) continue;
      const partnerBestQb = Math.max(0, ...partner.roster.filter((p) => p.position === "QB" && p.slot !== "IR").map((p) => p.projection ?? 0));
      if (give.position === "QB" && (partnerBestQb >= (give.projection ?? 0) * 0.82 || partner.roster.filter((p) => p.position === "QB" && p.slot !== "IR").length > 1)) continue;
      if ((receive.opportunityScore ?? 50) > (give.opportunityScore ?? 50) + 18) continue;
      const giveValue = playerValue(give, roster);
      const receiveValue = playerValue(receive, roster);
      if (giveValue <= 0 || receiveValue < giveValue * 0.82 || receiveValue > giveValue * 1.35) continue;
      const partnerAtGive = partner.roster.filter((p) => p.position === give.position && p.slot !== "IR").length;
      const fit = (give.position === "QB" && partnerAtGive <= 1 ? 5 : Math.max(0, 4 - partnerAtGive)) + Math.max(0, 4 - (myPositionCounts.get(receive.position) ?? 4));
      candidates.push({ give, receive, partner, fit, gap: receiveValue - giveValue });
    }
  }

  const used = new Set<string>();
  return candidates
    .sort((a, b) => b.fit - a.fit || b.gap - a.gap)
    .filter(({ give, receive, partner }) => {
      const key = `${give.canonicalPlayerId}|${receive.canonicalPlayerId}|${partner.teamId}`;
      if (used.has(key)) return false;
      used.add(key); return true;
    })
    .slice(0, 10)
    .map(({ give, receive, partner, gap }, index) => ({
      id: `trade-${give.canonicalPlayerId}-for-${receive.canonicalPlayerId}-${partner.teamId}`,
      kind: "TRADE" as const,
      headline: `OFRECER ${give.name} a ${partner.name} por ${receive.name}`,
      target: receive.name,
      alternative: give.name,
      partner: partner.name,
      confidence: Math.abs(gap) <= 2 ? "MEDIUM" as const : "LOW" as const,
      confidenceScore: Math.abs(gap) <= 2 ? 7 : 5,
      risk: "Es una propuesta de valor estimado; el rival puede rechazarla o pedir un paquete distinto.",
      why: [
        { type: "FACT" as const, text: `${receive.name} figura actualmente en el roster de ${partner.name}.` },
        { type: "MODEL" as const, text: `Valores proyectados comparables; diferencia estimada para tu roster: ${gap >= 0 ? "+" : ""}${round(gap)}.` },
        { type: "INFERENCE" as const, text: `La operación convierte profundidad de banca en ayuda de ${receive.position}.` },
      ],
      actionable: true,
      priority: 4.2 + index / 100,
    }));
}

const round = (value: number) => Math.round(value * 10) / 10;
