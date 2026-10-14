"use client";
import { useEffect, useState } from "react";
import type { CoreRun } from "@/lib/core/run";
import { formatMonterrey } from "@/lib/time";

const point = (value: number | null | undefined) => value == null ? "—" : value.toFixed(2);
export function CoreDashboard() {
  const [run, setRun] = useState<CoreRun | null>(null);
  const [metrics, setMetrics] = useState<unknown>(null);
  const [notice, setNotice] = useState("Cargando estado del núcleo…");
  const [busy, setBusy] = useState(false);
  const [playerId, setPlayerId] = useState("");
  const [scenario, setScenario] = useState("base");
  useEffect(() => {
    let active = true;
    Promise.all([fetch("/api/core/status").then((r) => r.json()), fetch("/api/core/backtest").then((r) => r.json())])
      .then(([state, backtest]) => { if (!active) return; setRun(state.run); setMetrics(backtest.metrics); setNotice(state.run ? state.run.gate.reason : state.reason ?? "Sin datos del núcleo. Primero importa una consulta de liga y el scoring completo."); })
      .catch(() => { if (active) setNotice("No se pudo leer el núcleo. Revisa la conexión y las migraciones."); });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    if (!run || run.status === "BLOCKED") return;
    const expiresAt = Date.parse(run.source_as_of) + 86400000;
    const delay = expiresAt - Date.now();
    const timer = setTimeout(() => {
      setRun((current) => current?.run_id === run.run_id ? {...current,status:"BLOCKED",gate:{accepted:false,reason:"La consulta de liga venció; importa datos actuales."}} : current);
      setNotice("La consulta de liga venció; importa datos actuales.");
    }, Number.isFinite(delay) ? Math.max(0, Math.min(delay + 1, 86400001)) : 0);
    return () => clearTimeout(timer);
  }, [run]);
  async function recalculate() {
    setBusy(true);
    try {
      const response = await fetch("/api/core/run", { method: "POST" });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error);
      setRun(result); setNotice("Corrida " + result.run_id.slice(0,12) + " · " + result.status + ". " + result.gate.reason + " Esta corrida recalcula los datos importados; no registra una consulta nueva de ESPN.");
    } catch (error) { setNotice(error instanceof Error ? error.message : "No se pudo completar la corrida."); }
    finally { setBusy(false); }
  }
  const stale = run?.status === "BLOCKED";
  const selectedId = stale ? "" : playerId || run?.players[0]?.player_id || "";
  const player = run?.players.find((p) => p.player_id === selectedId);
  const choices = stale ? [] : run?.projections.filter((p) => p.player_id === selectedId) ?? [];
  const projection = choices.find((p) => p.scenario === scenario) ?? choices.find((p) => p.scenario === "base");
  const identity = (id: string) => { const p = run?.players.find((item) => item.player_id === id); return p ? p.name + " · " + p.team_id + " · " + p.position : id; };
  return <section className="panel core-panel">
    <div className="panel-head"><h2>Núcleo predictivo</h2><button className="sync-button" disabled={busy} onClick={recalculate}>{busy ? "Procesando…" : "Recalcular núcleo"}</button></div>
    <p className="decision-note" role="status">{notice}</p>
    <p className="core-meta">Scoring: {run?.scoring_hash ? "versionado · " + run.scoring_hash.slice(0,10) : "sin confirmar"} · Modelo: {run?.model_version ?? "sin backtest aceptado"} · Consumidores: {run?.gate.accepted ? "habilitados para filas verificadas" : "esperando validación"} · Zona: America/Monterrey</p>
    {run?.source_as_of && <p className="core-meta">Dato de liga: {formatMonterrey(run.source_as_of)} · Cálculo: {formatMonterrey(run.created_at)} · Persistencia: {run.persistence}</p>}
    {stale && <p className="warning">Corrida bloqueada o histórica (semana {run?.week}). Importa datos vigentes para ver jugadores y recomendaciones actuales.</p>}
    <h3>Ficha del jugador</h3>
    <div className="core-controls"><label>Jugador <select value={selectedId} onChange={(e) => { setPlayerId(e.target.value); setScenario("base"); }}><option value="">Seleccionar</option>{!stale && run?.players.map((p) => <option key={p.player_id} value={p.player_id}>{identity(p.player_id)}</option>)}</select></label><label>Escenario <select value={projection?.scenario ?? "base"} onChange={(e) => setScenario(e.target.value)}>{choices.length ? choices.map((p) => <option key={p.scenario} value={p.scenario}>{p.scenario}</option>) : <option value="base">Sin datos</option>}</select></label></div>
    {projection ? <div className="core-player">
      <h3>{player ? identity(player.player_id) : selectedId}</h3>
      <div className="core-metrics">{[["Media", projection.mean],["Desviación",projection.sd],["P10",projection.p10],["P50",projection.p50],["P90",projection.p90]].map(([label,value]) => <div key={String(label)}><small>{label}</small><strong>{point(value as number | null)}</strong></div>)}</div>
      <p>Probabilidad de jugar: {projection.prob_play == null ? "sin modelo/dato oficial" : (projection.prob_play*100).toFixed(0)+"%"} · Cobertura: {projection.confidence}% · {projection.eligible ? "VERIFICADA" : "REVISIÓN NECESARIA"}</p>
      <p className="core-meta">{projection.method} · {projection.reason ?? "Sin bloqueo"} · Estimación: {projection.estimated ? "sí" : "no disponible"}</p>
      <details><summary>Factores, volumen vs matchup y fuentes</summary>{projection.drivers.map((d,i) => <p key={i}><b>{d.block}: {point(d.contribution)}</b> · {d.text} · {d.estimated ? "inferencia" : "fuente"}{d.evidence.map((e,j) => <small key={j}> {e.source} · dato {formatMonterrey(e.as_of)} · consulta {formatMonterrey(e.fetched_at)}</small>)}</p>)}<p>ROS: {point(projection.ros_mean)} · Playoffs: {point(projection.playoff_mean)} · WAR: {point(projection.war)}. Requieren calendario futuro, reemplazos y proyecciones verificadas; no se extrapola la semana actual.</p></details>
    </div> : <p className="empty">No hay distribución calculada para un jugador. Las bandas se mostrarán después de calibrar el modelo con históricos previos al partido.</p>}
    <h3>Vacancias y escenarios con/sin</h3>
    {!stale && run?.availability.length ? run.availability.map((team) => <details key={team.team_id}><summary>{team.team_id} · {team.scenarios.length} escenarios · concentración WR1+WR2: {team.concentration.value == null ? "—" : team.concentration.value.toFixed(1)+"%"}</summary>{team.issues.map((issue,i) => <p key={i}>{issue}</p>)}{team.scenarios.map((s) => <p key={s.id}>{s.id}: {(s.probability*100).toFixed(1)}% · ausentes {s.absent_player_ids.map(identity).join(", ") || "ninguno"} · QB {s.qb_id ? identity(s.qb_id) : "sin confirmar"}</p>)}{team.redistribution.filter((a) => (a.vacant_share ?? 0)>0).map((a) => <p key={a.scenario_id+"-"+a.metric}><b>{a.scenario_id} · {a.metric}</b>: {a.vacant_share?.toFixed(1)} puntos porcentuales vacantes. {a.beneficiaries.map((b) => identity(b.player_id)+" +"+b.inherited_share.toFixed(1)+" pp").join("; ") || a.reason} · estimación por rol observado</p>)}</details>) : <p className="empty">Faltan roles, shares y probabilidades de disponibilidad con fuente.</p>}
    <h3>Alertas de jugadores disponibles</h3>
    {!stale && run?.anomalies.length ? run.anomalies.map((a) => <article className="core-alert" key={a.player_id+a.signal}><b>{identity(a.player_id)} · {a.signal} · {a.strength}/100</b><p>{a.risk}</p><small>Score de detección, no probabilidad calibrada. {a.duration}</small>{a.evidence.map((e,i) => <p key={i}>{e.name}: {e.value} · {e.source} · {formatMonterrey(e.as_of)} · {e.method ?? "observado"}</p>)}</article>) : <p className="empty">Sin alertas sustentadas en el mercado disponible importado.</p>}
    <h3>Matchups ajustados por calendario y volumen</h3>
    {!stale && run?.matchups?.length ? run.matchups.map((m,i) => <article className="core-alert" key={i}><b>{identity(m.player_id)} vs {m.defense_team_id} · {m.phase}/{m.alignment}</b><p>Ratio ajustado: {point(m.adjusted_ratio)} · muestra: {m.sample_games} partidos · tendencia: {point(m.trend)}</p><p>Volumen propio: {point(m.own_volume_points)} pts · contribución rival: {point(m.matchup_contribution)} pts · {m.reason}</p><small>Ratio 1 = promedio ajustado. No se convierte a puntos con parámetros sin calibrar.</small></article>) : <p className="empty">Faltan observaciones defensivas con scoring reconciliado, rival y volumen propio.</p>}
    <h3>Noticias y fuentes curadas</h3>
    {!stale && run?.signals.length ? run.signals.map((s) => <p key={s.id}><b>{s.label}</b> · {s.summary} · {s.source_id} · {s.reason}</p>) : <p className="empty">No hay señales confirmadas importadas. X requiere acceso oficial; rumores no cambian la media.</p>}
    <h3>Precisión, calibración y ablation</h3>
    {metrics ? <details><summary>Resultados temporales y comparación contra ESPN</summary><pre>{JSON.stringify(metrics,null,2)}</pre></details> : <p className="empty">MAE, RMSE, cobertura P10–P90 y mejora contra ESPN: no disponibles. Se necesita histórico con scoring real y proyecciones archivadas antes del partido.</p>}
    <h3>Calidad y datos pendientes</h3>
    <p>{run?.quality.length ?? 0} incidencias · semilla {run?.seed ?? 42} · consultas externas en esta corrida: {run?.sources_consulted.length ?? 0}</p>
    {run?.quality.length ? <details><summary>Ver razones</summary>{run.quality.slice(0,100).map((q,i) => <p key={i}>{identity(q.entity_id)} · {q.name}: {q.reason}</p>)}{run.quality.length>100 && <p>El registro completo está disponible en la API privada.</p>}</details> : null}
  </section>;
}
