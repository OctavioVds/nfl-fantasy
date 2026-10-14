# Auditoría previa al Predictive Core

Fecha: 2026-10-14. Base: main `42b405b0d59e3191662c0a65d3b4836fecb82943`. Esta auditoría corresponde a OctavioVds/nfl-fantasy, no al proyecto independiente de Sites.

## Resultado previo a construir

| Módulo | Estado | Evidencia aplicada | Falta verificable |
|---|---|---|---|
| Waiver Engine | APLICADO PARCIAL | `lib/engine.ts` waiverRecommendations/playerValue; `lib/orchestrator.ts` WaiverRecommendations; `components/command-center.tsx` ActionsView; `tests/engine.test.ts`; tabla waiver_claims en 002 | Detector de anomalías/vacancias, distribución calibrada, scoring/slots reales, productor de claims y comparación global de disponibilidad; pendingMoves compara nombres |
| Lineup Optimizer | APLICADO PARCIAL | optimizeLineup/topLineupRecommendations en engine; `lib/lineup/matchup.ts`, schemas y 11 tests; UI LineupView | Matchup V2 no conectado, slots rígidos, recomendaciones duplican bajas y no sustituyen OUT si baja proyección cruda; scoring/distribución/prob_play calibrados |
| Trade Engine | APLICADO PARCIAL | tradeRecommendations/playerValue en engine; TradeFinder en orchestrator; UI acciones y tests | Simulación post-trade, ROS/playoffs/WAR, reglas/scoring reales; roster incompleto permite ofrecer único titular QB |

Los tres prompts originales no se encuentran en el checkout. No es comprobable una lista exacta de diferencias contra textos no disponibles. La lista anterior se reconstruye del código, `docs/COORDINATION.md` y el pedido de Predictive Core. No se declara ninguno completo.

## Persistencia y rutas

`db/migrations/001_init.sql`: sync_snapshots, provider_health, external_ingest_events.
`002_decision_state.sql`: schema_migrations, sync_runs, agent_runs, current_league_state, league_snapshots, roster_snapshots, players, player_id_map, projections_by_source, projection_snapshots, recommendations, decision_snapshots, waiver_claims, actuals, accuracy_metrics. Archivos presentes no prueban aplicación en Neon. No hay DATABASE_URL configurada en este checkout ni herramienta Neon conectada durante la auditoría.

Rutas existentes: POST /api/sync, POST /api/external-sync (Bearer), GET /api/cron/sync (CRON_SECRET). `vercel.json`: cron diario `0 12 * * *`. Sync recalcula sobre snapshots; no consulta Flaim en main. No hay rutas core ni jobs de entrenamiento en esta base.

## Ramas, PR y producción

PR #1 (matchup primitives), #2 (decision state/freshness) y #3 (import identidad tests) fusionadas. PR #4 Flaim OAuth/sync permanece draft abierto en `feat/flaim-live-sync`; su flag está desactivado. No se incorpora sin verificar OAuth y el primer sync. Ramas adicionales: feat/decision-engine, feat/matchup-lineup-v2, fix/lineup-test-identity-import.

GitHub combined status de main: Vercel success, enlace https://vercel.com/octaviovds-projects/q/CH8MSTH9uPvMn2ExZZy8otEfxnxP. GET https://q-ecru-nu.vercel.app devuelve HTTP 401 (privado) el 14 de octubre. Prueba alcance/auth, no acceso interno, contenido, scoring ni migraciones. Preview PR4 citado por su descripción; no verificado por esta auditoría. No afirmar producción funcional solo por build Ready.

## Comprobaciones de base

- tsc --noEmit: PASS.
- Vitest: PASS, 59 tests/5 archivos, 2026-10-14 09:13 Monterrey.
- next build: PASS, Next 16.3.5, cinco rutas incluidas.
- eslint: PASS, antes del commit de fase.
- npm ci: PASS; no se modificó lockfile. npm audit informa 11 vulnerabilidades de dependencias; revisión posterior, no ejecutar fix --force sin evaluar cambios.

Windows sandbox falló inicialmente por realpath/UNC EPERM y red DNS. Los resultados PASS provienen de repetir con ejecución autorizada fuera de esa restricción, no de omitir comprobaciones.

## Defectos reproducidos por VerifierAgent

OUT RB14 sustituido por sanoRB12 en optimizer pero sin recomendación; dos WR nuevos apuntan a la misma baja RB; roster8 sin FLEX devuelve [] y trade ofrece único QB; DST−4 genera rango floor0/median0/ceiling−4; projection ausente se convierte en0; schema permite FA ocupado por rival/IDs duplicados; SportsDataIO IDs no se traducen con player_id_map; DB etiqueta estimación ajustada como baseline ESPN; freshness matchup ignora sourceTimestamp/semana. Reproducciones con fixtures ficticios, sin datos privados.

## Cierre autorizado con excepciones

Waiver Engine: aplicado parcialmente. Lineup Optimizer: aplicado parcialmente. Trade Engine: aplicado parcialmente. Inicio del Predictive Core con las excepciones reales de `DECISIONS.md`: se conserva la base, se corrigen riesgos verificables y la sustitución del modelo permanece cerrada hasta datos reales, scoring reconciliado y backtest aceptado. Esto cierra la fase documental permitida por la regla de excepciones, no acredita módulos completos ni producción verificada.
