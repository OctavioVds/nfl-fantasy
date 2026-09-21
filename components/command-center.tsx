"use client";

import { useMemo, useState } from "react";
import type { SyncSnapshot } from "@/lib/types";
import { optimizeLineup } from "@/lib/engine";
import { formatMonterrey } from "@/lib/time";

type View = "command" | "lineup" | "actions" | "system";

export function CommandCenter({ initialSnapshot }: { initialSnapshot: SyncSnapshot }) {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [view, setView] = useState<View>("command");
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const starters = useMemo(() => optimizeLineup(snapshot.roster), [snapshot.roster]);
  const starterIds = useMemo(() => new Set(starters.map((p) => p.canonicalPlayerId)), [starters]);
  const bench = useMemo(() => snapshot.roster.filter((p) => p.slot !== "IR" && !starterIds.has(p.canonicalPlayerId)).map((p) => ({ ...p, slot: "Bench" })), [snapshot.roster, starterIds]);

  async function sync() {
    setSyncing(true); setError(null);
    try {
      const response = await fetch("/api/sync", { method: "POST" });
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? "No se pudo sincronizar");
      setSnapshot(body);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "No se pudo sincronizar"); }
    finally { setSyncing(false); }
  }

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">FANTASY VALDES · PPR · 10 EQUIPOS</p>
          <h1>COMMAND <span>CENTER</span></h1>
        </div>
        <div className="sync-block">
          <div className={`health health-${snapshot.health.toLowerCase()}`}><i />{snapshot.health}</div>
          <button className="sync-button" onClick={sync} disabled={syncing}>
            <span className={syncing ? "spinner active" : "spinner"} />
            {syncing ? "Sincronizando" : "Sincronizar"}
          </button>
        </div>
      </header>

      <nav className="nav-tabs" aria-label="Secciones">
        {(["command", "lineup", "actions", "system"] as View[]).map((item) => (
          <button key={item} onClick={() => setView(item)} className={view === item ? "active" : ""}>
            {item === "command" ? "Resumen" : item === "lineup" ? "Alineación" : item === "actions" ? "Acciones" : "Sistema"}
          </button>
        ))}
      </nav>

      {snapshot.warnings.length > 0 && (
        <section className="warning" role="status">
          <strong>{snapshot.freshness === "STALE" ? "Datos vencidos" : "Datos parciales"}</strong>
          <div>{snapshot.warnings.join(" ")}</div>
        </section>
      )}
      {error && <section className="error" role="alert">{error}</section>}

      {view === "command" && <CommandView snapshot={snapshot} />}
      {view === "lineup" && <LineupView starters={starters} bench={bench} historical={snapshot.freshness === "STALE"} />}
      {view === "actions" && <ActionsView snapshot={snapshot} />}
      {view === "system" && <SystemView snapshot={snapshot} />}

      <footer>
        <span>Temporada {snapshot.season} · Semana {snapshot.week}</span>
        <span>Datos: {formatMonterrey(snapshot.dataAsOf)}</span>
        <span>Sync: {formatMonterrey(snapshot.generatedAt)}</span>
      </footer>
    </main>
  );
}

function CommandView({ snapshot }: { snapshot: SyncSnapshot }) {
  const bestWaiver = snapshot.recommendations.find((item) => item.kind === "ADD");
  const urgent = snapshot.recommendations.filter((item) => ["START", "WATCH"].includes(item.kind));
  const topActions = [...urgent, ...snapshot.recommendations.filter((item) => !urgent.includes(item))];
  const record = snapshot.teamRecord;
  const recordValue = record ? `${record.wins}-${record.losses}${record.ties ? `-${record.ties}` : ""}` : "—";
  const recordUnit = record ? `${record.streak ?? "SIN RACHA"}${record.rank ? ` · #${record.rank}` : ""}` : "SIN DATOS";
  return <>
    <section className="score-strip">
      <Metric label="Mi proyección" value={snapshot.projectedScore == null ? "—" : snapshot.projectedScore.toFixed(1)} unit="PTS" />
      <Metric label={snapshot.opponentName ?? "Rival"} value={snapshot.opponentScore == null ? "—" : snapshot.opponentScore.toFixed(1)} unit="PTS" />
      <Metric label="Victoria" value={snapshot.winProbability == null ? "—" : `${snapshot.winProbability}%`} unit={snapshot.winProbability == null ? "SIN DATOS" : "SIMULACIÓN"} />
      <Metric label="Récord" value={recordValue} unit={recordUnit} />
      <Metric label="Actualidad" value={snapshot.freshness} unit={snapshot.sources.length ? `${snapshot.sources.length} FUENTE(S)` : "SIN FUENTE VIVA"} compact />
    </section>
    <div className="dashboard-grid">
      <section className="panel actions-panel">
        <div className="panel-head"><h2>Mejores acciones</h2><span>{snapshot.freshness === "STALE" ? "HISTÓRICAS · NO ACCIONABLES" : "ORDENADAS POR PRIORIDAD"}</span></div>
        {topActions.length ? <ExpandableActions items={topActions} initialCount={3} /> : <Empty message="No hay acciones validadas con los datos actuales." />}
      </section>
      <section className="panel intel-panel">
        <div className="panel-head"><h2>Estado de decisión</h2><span>{snapshot.health}</span></div>
        <div className="intel-item"><b>Mejor waiver</b><p>{bestWaiver?.headline ?? (snapshot.sources.length ? "Sin mejora positiva validada." : "Requiere disponibilidad actual de la liga.")}</p></div>
        <div className="intel-item"><b>Mayor riesgo</b><p>{snapshot.freshness === "STALE" ? "La plantilla guardada puede no ser la actual." : "Noticias e inactivos cercanos al kickoff."}</p></div>
        <div className="intel-item"><b>Regla activa</b><p>Una recomendación no puede mover jugadores bloqueados.</p></div>
      </section>
    </div>
  </>;
}

function LineupView({ starters, bench, historical }: { starters: SyncSnapshot["roster"]; bench: SyncSnapshot["roster"]; historical: boolean }) {
  return <section className="panel lineup-panel">
    <div className="panel-head"><h2>Alineación óptima</h2><span>PROYECCIÓN PPR · AJUSTADA AUTOMÁTICAMENTE</span></div>
    <div className="decision-note">Usa esta alineación en ESPN. Respeta jugadores bloqueados y elige la mayor proyección disponible para cada puesto.</div>
    <h3>Titulares recomendados</h3>
    <div className="player-list">{starters.map((p) => <PlayerRow key={p.canonicalPlayerId} player={p} historical={historical} />)}</div>
    <h3>Banca</h3>
    <div className="player-list">{bench.map((p) => <PlayerRow key={p.canonicalPlayerId} player={p} historical={historical} />)}</div>
  </section>;
}

function ActionsView({ snapshot }: { snapshot: SyncSnapshot }) {
  const groups = [
    { title: "Cambios de alineación", kinds: ["START", "SIT"] },
    { title: "Waivers en orden", kinds: ["ADD", "DROP", "STREAM"] },
    { title: "Trades recomendados", kinds: ["TRADE"] },
    { title: "Manejo del roster", kinds: ["HOLD", "WATCH"] },
  ];
  return <section className="panel">
    <div className="panel-head"><h2>Action Center</h2><span>{snapshot.freshness === "STALE" ? "HISTÓRICO · NO ACCIONABLE" : "PLAN VALIDADO"}</span></div>
    <div className="decision-note">Ejecuta en este orden. Las reclamaciones alternativas con el mismo jugador a cortar deben colocarse debajo de la prioridad principal en ESPN.</div>
    <div className="action-groups">{groups.map((group) => {
      const items = snapshot.recommendations.filter((r) => group.kinds.includes(r.kind));
      return <div className="action-group" key={group.title}><h3>{group.title}</h3>{items.length ? <ExpandableActions items={items} initialCount={3} /> : <p>La plantilla actual no requiere una acción en esta categoría.</p>}</div>;
    })}</div>
  </section>;
}

function SystemView({ snapshot }: { snapshot: SyncSnapshot }) {
  return <section className="panel">
    <div className="panel-head"><h2>System Health</h2><span>{snapshot.health}</span></div>
    <div className="agent-grid">{snapshot.agents.map((agent) => <div className="agent" key={agent.name}><div><i className={`state-${agent.status}`} /> <b>{agent.name}</b></div><span>{agent.status} · {agent.latencyMs} ms</span>{agent.message && <p>{agent.message}</p>}</div>)}</div>
    <div className="source-list"><h3>Fuentes</h3>{snapshot.sources.length ? snapshot.sources.map((source) => <div key={`${source.name}-${source.sourceTimestamp}`}><b>{source.name}</b><span>{formatMonterrey(source.sourceTimestamp)}</span></div>) : <Empty message="No hay una fuente viva de liga conectada." />}</div>
  </section>;
}

function Metric({ label, value, unit, compact = false }: { label: string; value: string; unit: string; compact?: boolean }) {
  return <div className="metric"><span>{label}</span><strong className={compact ? "compact" : ""}>{value}</strong><small>{unit}</small></div>;
}

function PlayerRow({ player, historical }: { player: SyncSnapshot["roster"][number]; historical: boolean }) {
  const status = historical ? "HISTÓRICO" : player.locked ? "LOCKED" : "ABIERTO";
  const matchup = player.opponent ? `${player.homeAway === "away" ? "@" : "vs"} ${player.opponent}` : null;
  const conditions = [player.venue, player.weather].filter(Boolean).join(" · ");
  return <div className="player-row"><span className="slot">{player.slot}</span><div><b>{player.name}</b><small>{player.team} · {player.position}{matchup ? ` · ${matchup}` : ""}{player.injury ? ` · ${player.injury}` : ""}</small>{conditions && <small className="conditions">{conditions}</small>}</div><strong>{player.projection?.toFixed(1) ?? "—"}</strong><span className={historical ? "historical" : player.locked ? "locked" : "open"}>{status}</span></div>;
}

function ActionCard({ action, index }: { action: SyncSnapshot["recommendations"][number]; index: number }) {
  return <article className={`action-card ${!action.actionable ? "disabled" : ""}`}>
    <div className="action-index">0{index + 1}</div><div className="action-copy"><span>{action.actionable ? action.kind : `${action.kind} · NO ACCIONABLE`}</span><h3>{action.headline}</h3><div className="evidence">{action.why.map((reason, i) => <p key={i}><b>{reason.type}</b> {reason.text}</p>)}</div><small>Riesgo: {action.risk}</small></div><div className="confidence"><strong>{action.confidenceScore}/10</strong><span>{action.confidence}</span></div>
  </article>;
}

function ExpandableActions({ items, initialCount }: { items: SyncSnapshot["recommendations"]; initialCount: number }) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? items : items.slice(0, initialCount);
  return <>
    {visible.map((action, index) => <ActionCard key={action.id} action={action} index={index} />)}
    {items.length > initialCount && <button className="more-button" onClick={() => setExpanded((value) => !value)} aria-expanded={expanded}>
      {expanded ? "Ver menos" : `Ver más opciones (${items.length - initialCount})`}
    </button>}
  </>;
}

function Empty({ message }: { message: string }) { return <div className="empty">{message}</div>; }
