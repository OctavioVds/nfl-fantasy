# Coordination board

Updated: 2026-09-30 (America/Monterrey)

| Carril | Rama | Chat / dueño | Archivos nuevos / tocados | Migraciones reservadas | Flags | Estado | Última actualización |
|---|---|---|---|---|---|---|---|
| A — Waiver Intelligence | — | Sin asignar en GitHub remoto | `lib/waivers/*` (propuesto) | Ninguna | `WAIVER_INTEL_V2` | Sin reclamar; no se inicia para evitar duplicar la otra tarea amplia | 2026-09-30 |
| B — Matchup-aware Lineup | `feat/matchup-lineup-v2` (local aislada; publicación bloqueada por GitHub 403) | Codex: Inspecciona carriles de nfl-fantasy | `lib/lineup/*`; integración aditiva pendiente de auditoría | Ninguna | `MATCHUP_LINEUP_V2` | Reclamado; auditoría en curso | 2026-09-30 |
| C — Base compartida | `feat/decision-engine` (checkout paralelo local, sin cambios publicados) | Codex: Convertir app en decision engine (activo) | Trabajo observado en `lib/orchestrator.ts`, `lib/db.ts`, `app/api/sync/*`, `app/api/external-sync/*`, `app/api/cron/sync/*`, `app/globals.css`; cambios no integrados | `002_decision_state.sql` (presente solo como cambio local observado; aplicación no verificada) | Flags de C por confirmar | En curso en la otra tarea; evitar esos archivos y reconsultar antes de integración | 2026-09-30 |
