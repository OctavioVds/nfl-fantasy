# Coordination board

Updated: 2026-09-30 (America/Monterrey)

| Carril | Rama | Chat / dueño | Archivos nuevos / tocados | Migraciones reservadas | Flags | Estado | Última actualización |
|---|---|---|---|---|---|---|---|
| A — Waiver Intelligence | — | Sin asignar en GitHub remoto | `lib/waivers/*` (propuesto) | Ninguna | `WAIVER_INTEL_V2` | Sin reclamar; no se inicia para evitar duplicar la otra tarea amplia | 2026-09-30 |
| B — Matchup-aware Lineup | `feat/matchup-lineup-v2` (local aislada; publicación bloqueada por GitHub 403) | Codex: Inspecciona carriles de nfl-fantasy | `lib/lineup/schemas.ts`, `lib/lineup/matchup.ts`, `tests/lineup.test.ts`; integración de UI/orquestador pendiente | Ninguna | `MATCHUP_LINEUP_V2` | Motor determinístico y 11 pruebas agregados; usa `optimizeLineup`; edge normalizado, muestra, frescura, rol y fuente; modo apagado preserva optimizer; falta cableado cuando C libere puntos compartidos | 2026-09-30 |
| C — Base compartida | `feat/decision-engine` (checkout paralelo local, sin cambios publicados) | Codex: Convertir app en decision engine (activo) | Cambios locales observados: `.env.example`, `README.md`, `app/page.tsx`, `app/globals.css`, `components/command-center.tsx`, `lib/{db,engine,fallback-data,orchestrator,providers,schemas,time,types}.ts`, `lib/providers/{sportsdataio,statshawk}.ts`, `scripts/migrate.mjs`, `db/migrations/002_decision_state.sql`, `lib/player-identity.ts`, `lib/snapshot-view.ts`, `proxy.ts`, pruebas de engine/orchestrator/schema/snapshot y rutas sync | `002_decision_state.sql` aplicada por la tarea paralela; `schema_migrations` confirma `001_init.sql` y `002_decision_state.sql` en la base configurada. No se verificó si es la DB de producción | Flags de C por confirmar | En curso en la otra tarea; ya retiró del fallback el roster estático identificable y conserva señal STALE; `proxy.ts` protege con `APP_ACCESS_PASSWORD` y falla cerrado si falta; no se verificó env de producción | 2026-09-30 |

## Verificación externa

- GitHub muestra solo `main` y ningún PR abierto; crear `feat/matchup-lineup-v2` fue rechazado con 403 por permisos del conector. El branch y tablero existen solo en el clon local aislado.
- Vercel reconoce un proyecto configurado en `.vercel`, pero el scope del equipo rechazó la lectura de deployments con 403; no se desplegó nada.
- No hay conector Neon. Una consulta de solo lectura sobre la `DATABASE_URL` local confirmó las tablas y las versiones `001_init.sql` y `002_decision_state.sql`; la segunda aparece aplicada por la otra tarea. No se confirmó si la URL es producción ni se aplicaron migraciones desde este carril.
- `.env.local` contiene `DATABASE_URL`, pero no `SPORTSDATAIO_API_KEY`; SportsDataIO no pudo probarse con credenciales. No se copiaron secretos al clon. La inspección de la rama paralela ya no encuentra el roster estático identificable en `fallback-data.ts`.
- La rama paralela añade `APP_ACCESS_PASSWORD` server-side con Basic Auth para la app y respuesta 503 fail-closed si falta. El valor configurado en producción no se pudo verificar por el 403 de Vercel.
- `MATCHUP_LINEUP_V2` está preparado como flag explícito para el caller; falta exponerlo desde el servidor y conectar la UI cuando el trabajo paralelo libere esos archivos.
