# Coordination board

Updated: 2026-09-30 (America/Monterrey)

| Carril | Rama | Chat / dueño | Archivos nuevos / tocados | Migraciones reservadas | Flags | Estado | Última actualización |
|---|---|---|---|---|---|---|---|
| A — Waiver Intelligence | — | Sin asignar en GitHub remoto | `lib/waivers/*` (propuesto) | Ninguna | `WAIVER_INTEL_V2` | Sin reclamar; no se inicia para evitar duplicar la otra tarea amplia | 2026-09-30 |
| B — Matchup-aware Lineup | `feat/matchup-lineup-v2` (local aislada; publicación bloqueada por GitHub 403) | Codex: Inspecciona carriles de nfl-fantasy | `lib/lineup/schemas.ts`, `lib/lineup/matchup.ts`, `tests/lineup.test.ts`; integración de UI/orquestador pendiente | Ninguna | `MATCHUP_LINEUP_V2` | Motor determinístico y 11 pruebas agregados; usa `optimizeLineup`; edge normalizado, muestra, frescura, rol y fuente; modo apagado preserva optimizer; falta cableado cuando C libere puntos compartidos | 2026-09-30 |
| C — Base compartida | `feat/decision-engine` (checkout paralelo local, sin cambios publicados) | Codex: Convertir app en decision engine (activo) | Trabajo observado en `lib/orchestrator.ts`, `lib/db.ts`, `app/api/sync/*`, `app/api/external-sync/*`, `app/api/cron/sync/*`, `app/globals.css`; cambios no integrados | `002_decision_state.sql` (presente solo como cambio local observado; aplicación no verificada) | Flags de C por confirmar | En curso en la otra tarea; evitar esos archivos y reconsultar antes de integración | 2026-09-30 |

## Verificación externa

- GitHub muestra solo `main` y ningún PR abierto; crear `feat/matchup-lineup-v2` fue rechazado con 403 por permisos del conector. El branch y tablero existen solo en el clon local aislado.
- Vercel reconoce un proyecto configurado en `.vercel`, pero el scope del equipo rechazó la lectura de deployments con 403; no se desplegó nada.
- No hay conector Neon. La consulta SQL de solo lectura no llegó a Neon (`NeonDbError`, red no disponible); no se aplicaron migraciones. El estado real de `002_decision_state.sql` sigue sin verificar.
- `.env.local` contiene `DATABASE_URL`, pero no `SPORTSDATAIO_API_KEY`; SportsDataIO no pudo probarse con credenciales. No se copiaron secretos al clon.
- `MATCHUP_LINEUP_V2` está preparado como flag explícito para el caller; falta exponerlo desde el servidor y conectar la UI cuando el trabajo paralelo libere esos archivos.
