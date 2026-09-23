import type { PlayerDecisionProfile, PlayerProjection, Recommendation, RosterPlayer, TradePartner } from "./types";

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

export const LINEUP_SWAP_THRESHOLD = 3;

export function buildDecisionProfile(player: RosterPlayer): PlayerDecisionProfile {
  const games = player.recentGames ?? [];
  const points = games.flatMap((game) => game.fantasyPointsPpr == null ? [] : [game.fantasyPointsPpr]);
  const average = (key: keyof (typeof games)[number]) => {
    const values = games.flatMap((game) => typeof game[key] === "number" ? [game[key] as number] : []);
    return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : undefined;
  };
  let median = player.projection ?? (points.length ? points.reduce((sum, value) => sum + value, 0) / points.length : 0);
  let floor = player.floor ?? median * 0.67;
  let ceiling = player.ceiling ?? median * 1.38;
  const snapShare = average("snapShare");
  const targetShare = average("targetShare");
  const routeParticipation = average("routeParticipation");
  const touchesPerGame = average("touches");
  const redZoneTouchesPerGame = average("redZoneTouches");
  const insideFiveTouchesPerGame = average("insideFiveTouches");
  const yprr = average("yprr");
  const ycoPerAttempt = average("ycoPerAttempt");
  const factors: string[] = [];

  if (points.length >= 2) {
    const recentFloor = Math.min(...points);
    const recentCeiling = Math.max(...points);
    floor = floor * 0.55 + recentFloor * 0.45;
    ceiling = ceiling * 0.55 + recentCeiling * 0.45;
  }
  if ((snapShare ?? 0) >= 0.72 && ((targetShare ?? 0) >= 0.18 || (touchesPerGame ?? 0) >= 14)) {
    floor *= 1.05;
    factors.push("volumen estable eleva el piso");
  }
  if ((player.windMph ?? 0) > 15 && ["QB", "WR", "TE", "K"].includes(player.position)) {
    median *= 0.91; floor *= 0.88; ceiling *= 0.9;
    factors.push(`viento ${round(player.windMph!)} mph penaliza pase/pateo`);
  } else if ((player.windMph ?? 0) > 15 && player.position === "RB") {
    median *= 1.02; factors.push("viento favorece volumen terrestre");
  }
  if ((player.overUnder ?? 45) >= 49) { ceiling *= 1.05; factors.push(`total alto ${player.overUnder}`); }
  if ((player.overUnder ?? 45) <= 39) { median *= 0.96; ceiling *= 0.94; factors.push(`total bajo ${player.overUnder}`); }
  if ((player.spread ?? 0) <= -7) {
    if (player.position === "RB") { median *= 1.05; floor *= 1.05; factors.push("favorito amplio favorece acarreos tardíos"); }
    if (["QB", "WR"].includes(player.position)) { ceiling *= 0.97; factors.push("favorito amplio limita volumen aéreo tardío"); }
  }
  if ((player.spread ?? 0) >= 7 && ["WR", "TE"].includes(player.position)) {
    ceiling *= 1.05; factors.push("underdog amplio favorece volumen de remontada");
  }
  if ((player.offensiveLineAbsences ?? 0) >= 1) {
    const penalty = Math.min(0.14, player.offensiveLineAbsences! * 0.045);
    median *= 1 - penalty; floor *= 1 - penalty * 1.2;
    factors.push(`${round(player.offensiveLineAbsences!)} bajas ponderadas en OL`);
  }
  if ((player.opponentCoverageAbsences ?? 0) >= 1 && ["QB", "WR", "TE"].includes(player.position)) {
    ceiling *= 1.04; median *= 1.02; factors.push("bajas relevantes en cobertura rival");
  }
  if ((player.opponentFrontSevenAbsences ?? 0) >= 1 && player.position === "RB") {
    ceiling *= 1.04; median *= 1.02; factors.push("bajas en front seven rival");
  }
  if (player.quarterbackRisk && ["WR", "TE", "RB"].includes(player.position)) {
    median *= 0.91; floor *= 0.88; factors.push("QB del equipo figura lesionado");
  }
  if (player.divisional) { ceiling *= 0.97; factors.push("juego divisional reduce ligeramente el techo"); }
  if (player.shortWeek) { floor *= 0.97; median *= 0.98; factors.push("semana corta"); }
  if (/^(Q|QUESTIONABLE)$/i.test(player.injury ?? "")) { floor *= 0.86; median *= 0.94; factors.push("designación cuestionable"); }
  if (/^(D|DOUBTFUL)$/i.test(player.injury ?? "")) { floor *= 0.45; median *= 0.72; factors.push("alta probabilidad de limitación/inactividad"); }
  if (/^(IR|O|OUT|INACTIVE)$/i.test(player.injury ?? "")) { floor = 0; median = 0; ceiling = 0; factors.push("no disponible"); }

  const latest = games[0];
  const priorAverage = games.slice(1).flatMap((game) => game.fantasyPointsPpr == null ? [] : [game.fantasyPointsPpr]);
  const comparison = priorAverage.length ? priorAverage.reduce((sum, value) => sum + value, 0) / priorAverage.length : undefined;
  const lowOpportunity = (latest?.touches ?? 0) < 8 && (latest?.targets ?? 0) < 6;
  if (latest?.fantasyPointsPpr != null && comparison != null && latest.fantasyPointsPpr > comparison * 1.5 && (latest.touchdowns ?? 0) >= 1 && lowOpportunity) {
    median *= 0.95; ceiling *= 0.94; factors.unshift("pico reciente dependió de TD con poco volumen");
  }

  const missing = [
    snapShare == null ? "snaps" : null,
    targetShare == null && ["WR", "TE", "RB"].includes(player.position) ? "target share" : null,
    routeParticipation == null && ["WR", "TE", "RB"].includes(player.position) ? "route participation" : null,
    redZoneTouchesPerGame == null && ["RB", "WR", "TE"].includes(player.position) ? "toques RZ" : null,
    player.position === "RB" && ycoPerAttempt == null ? "YCO/A" : null,
    ["WR", "TE"].includes(player.position) && yprr == null ? "YPRR" : null,
    player.overUnder == null ? "O/U" : null,
    player.spread == null ? "spread" : null,
    player.windMph == null ? "viento" : null,
    player.offensiveLineAbsences == null ? "salud OL" : null,
    player.opponentCoverageAbsences == null || player.opponentFrontSevenAbsences == null ? "bajas defensivas rivales" : null,
  ].filter((value): value is string => Boolean(value));
  const expected = player.position === "DST" || player.position === "K" ? 4 : player.position === "QB" ? 6 : 9;
  const confidence = Math.max(20, Math.round(100 * Math.max(0, expected - missing.length) / expected));
  const gameScript = player.spread == null ? "Sin spread confirmado" : player.spread <= -7 ? "Favorito amplio: posible modo reloj" : player.spread >= 7 ? "Underdog amplio: posible remontada" : "Guion competitivo";
  return {
    floor: round(Math.max(0, Math.min(floor, median))), median: round(Math.max(0, median)), ceiling: round(Math.max(median, ceiling)),
    confidence, sampleGames: games.length, snapShare, targetShare, routeParticipation, touchesPerGame,
    redZoneTouchesPerGame, insideFiveTouchesPerGame, yprr, ycoPerAttempt, gameScript,
    hiddenFactor: factors[0] ?? (missing.length ? `faltan ${missing.slice(0, 2).join(" y ")}` : "volumen y contexto sin alerta dominante"), missing,
  };
}

export function lineupDecisionScore(player: RosterPlayer) {
  const projection = player.decisionProfile?.median ?? player.projection ?? 0;
  const floorAdjustment = player.decisionProfile ? (player.decisionProfile.floor - projection) * 0.2 : 0;
  const opportunity = player.opportunityScore == null ? 0 : Math.max(-1, Math.min(1, (player.opportunityScore - 70) / 25));
  const depth = player.depthOrder === 1 ? 0.6 : player.depthOrder === 2 ? 0.15 : player.depthOrder && player.depthOrder >= 3 ? -0.6 : 0;
  const status = (player.injury ?? "").toUpperCase();
  const injury = /^(IR|O|OUT|INACTIVE)$/.test(status) ? -100 : /^(D|DOUBTFUL)$/.test(status) ? -8 : /^(Q|QUESTIONABLE)$/.test(status) ? -2 : 0;
  return projection + floorAdjustment + opportunity + depth + injury;
}

export function optimizeLineup(players: RosterPlayer[]) {
  const slots = ["QB", "RB", "RB", "WR", "WR", "TE", "RB/WR", "DST", "K"];
  const eligible = (player: RosterPlayer, slot: string) => player.position === slot || (slot === "RB/WR" && ["RB", "WR"].includes(player.position));
  const currentStarters = new Set(players.filter((p) => !["Bench", "IR"].includes(p.slot)).map((p) => p.canonicalPlayerId));
  let best: RosterPlayer[] = [];
  let bestScore = Number.NEGATIVE_INFINITY;

  const search = (slotIndex: number, used: Set<string>, lineup: RosterPlayer[], score: number) => {
    if (slotIndex === slots.length) {
      if (score > bestScore) { bestScore = score; best = lineup; }
      return;
    }
    const slot = slots[slotIndex];
    const locked = players.filter((p) => p.locked && p.slot === slot && !used.has(p.canonicalPlayerId));
    const candidates = (locked.length ? locked : players.filter((p) => p.slot !== "IR" && !used.has(p.canonicalPlayerId) && eligible(p, slot) && (!p.locked || p.slot === slot)))
      .sort((a, b) => lineupDecisionScore(b) - lineupDecisionScore(a));
    for (const candidate of candidates) {
      used.add(candidate.canonicalPlayerId);
      const incumbentBonus = currentStarters.has(candidate.canonicalPlayerId) ? LINEUP_SWAP_THRESHOLD : 0;
      search(slotIndex + 1, used, [...lineup, { ...candidate, slot }], score + lineupDecisionScore(candidate) + incumbentBonus);
      used.delete(candidate.canonicalPlayerId);
    }
  };
  search(0, new Set(), [], 0);
  return best;
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
    const delta = round((starter.decisionProfile?.median ?? starter.projection ?? 0) - (replacement.decisionProfile?.median ?? replacement.projection ?? 0));
    const safetyDelta = round(lineupDecisionScore(starter) - lineupDecisionScore(replacement));
    if (safetyDelta < LINEUP_SWAP_THRESHOLD) continue;
    moves.push({
      id: `start-${starter.canonicalPlayerId}`,
      kind: "START",
      headline: `PON A ${starter.name} · SIENTA A ${replacement.name}`,
      target: starter.name,
      alternative: replacement.name,
      confidence: delta >= 3 ? "HIGH" : "MEDIUM",
      confidenceScore: Math.min(10, Math.max(5, Math.round(5 + delta / 2))),
      risk: "Las proyecciones son estimaciones; noticias tardías pueden cambiar el papel.",
      why: [
        { type: "FACT", text: `${starter.name} está en tu banca y ${replacement.name} aparece actualmente como titular.` },
        { type: "MODEL", text: `Ventaja mediana estimada: +${delta} puntos PPR; ventaja ajustada por seguridad: +${safetyDelta}.` },
        { type: "INFERENCE", text: `Factor decisivo: ${starter.decisionProfile?.hiddenFactor ?? `supera el umbral conservador de ${LINEUP_SWAP_THRESHOLD} puntos`}.` },
      ],
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
  // Protect players supported by at least two strong hold signals, while allowing
  // popular handcuffs with weak weekly and future value to be upgraded.
  const isHighValueHold = (p: RosterPlayer) => [
    (p.opportunityScore ?? 0) >= 75,
    (p.projection ?? 0) >= 10,
    (p.futureProjection ?? 0) >= 8,
  ].filter(Boolean).length >= 2;
  const dropPool = roster.filter((p) => p.slot === "Bench" && !p.locked && !isHighValueHold(p));
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
    const confidenceScore = Math.min(10, Math.max(3, Math.round(3 + Math.max(0, net) / 2 + (candidate.opportunityScore ?? 50) / 50 + dataSignals / 4)));
    return { candidate, drop, net, candidateValue, confidenceScore };
  }).filter((row) => row.net >= 1).sort((a, b) => Math.round(b.net) - Math.round(a.net)
    || (b.candidate.opportunityScore ?? 0) - (a.candidate.opportunityScore ?? 0)
    || b.net - a.net
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
      headline: `TOMA A ${candidate.name} · TIRA A ${drop.name}`,
      target: candidate.name,
      alternative: drop.name,
      confidence: confidenceScore >= 8 ? "HIGH" as const : confidenceScore >= 6 ? "MEDIUM" as const : "LOW" as const,
      confidenceScore,
      risk: "La disponibilidad y el papel pueden cambiar antes de procesar waivers; confirma noticias cercanas al cierre.",
      why: [
        { type: "FACT" as const, text: `${candidate.name} fue confirmado disponible por la fuente de la liga.` },
        { type: "FACT" as const, text: `${drop.name} está en tu roster, no está bloqueado y fue validado como opción de corte.` },
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
    .sort((a, b) => Math.abs(a.gap) - Math.abs(b.gap) || b.fit - a.fit || b.gap - a.gap)
    .filter(({ give, receive, partner }) => {
      const key = `${give.canonicalPlayerId}|${receive.canonicalPlayerId}|${partner.teamId}`;
      if (used.has(key)) return false;
      used.add(key); return true;
    })
    .slice(0, 10)
    .map(({ give, receive, partner, gap, fit }, index) => {
      const difference = Math.abs(gap);
      const equityScore = difference <= 0.75 ? 9 : difference <= 1.5 ? 8 : difference <= 2.5 ? 7 : difference <= 3.5 ? 6 : difference <= 5 ? 5 : 4;
      const valueScore = Math.max(1, Math.min(10, equityScore + (fit >= 4 ? 1 : fit <= 1 ? -1 : 0)));
      return {
        id: `trade-${give.canonicalPlayerId}-for-${receive.canonicalPlayerId}-${partner.teamId}`,
        kind: "TRADE" as const,
        headline: `OFRECE ${give.name} A ${partner.name} POR ${receive.name}`,
        target: receive.name,
        alternative: give.name,
        partner: partner.name,
        confidence: valueScore >= 9 ? "HIGH" as const : valueScore >= 7 ? "MEDIUM" as const : "LOW" as const,
        confidenceScore: valueScore,
        risk: "Es una propuesta de valor estimado; el rival puede rechazarla o pedir un paquete distinto.",
        why: [
          { type: "FACT" as const, text: `${receive.name} figura actualmente en el roster de ${partner.name}.` },
          { type: "MODEL" as const, text: `Valores proyectados comparables; diferencia estimada para tu roster: ${gap >= 0 ? "+" : ""}${round(gap)}.` },
          { type: "INFERENCE" as const, text: `La operación convierte profundidad de banca en ayuda de ${receive.position}.` },
        ],
        actionable: true,
        priority: 4.2 + index / 100,
      };
    });
}

const round = (value: number) => Math.round(value * 10) / 10;
